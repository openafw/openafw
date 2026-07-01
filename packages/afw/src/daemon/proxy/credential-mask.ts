// Proxy-side credential masking: swap real secrets for fakes in the outbound
// request body, and restore the real values in the inbound response stream.
// The pure find/replace + rule catalog live in core/masking.ts; this file is
// the wire glue (ArrayBuffer in, streaming transform out).

import { logger } from '../../core/logger.ts'
import {
  type MaskingRule,
  enabledRulesForProvider,
  maskCredentials,
} from '../../core/masking.ts'
import type { GuardEdit } from '../../core/packet.ts'
import { getMaskingConfig } from '../masking/load.ts'

export type MaskedText = {
  /** The text with credentials swapped for fakes. */
  text: string
  /** fake → real, to restore the response. Empty for rewrite-style rules. */
  restore: Map<string, string>
  /** Request text edits applied by scoped guard/masking rules. */
  edits: GuardEdit[]
}

export type MaskedRequest = {
  /** The body to forward upstream, with credentials swapped for fakes. */
  body: ArrayBuffer
  /** fake → real, to restore the response. Empty for rewrite-style rules. */
  restore: Map<string, string>
  /** Request text edits applied by scoped guard/masking rules. */
  edits: GuardEdit[]
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Copy into a clean ArrayBuffer — fetch dislikes shared Uint8Array views.
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}

/** Mask credentials in a body of text using the rules the user enabled for
 *  `providerId`. Returns undefined when masking is off for the provider or
 *  nothing matched — callers then forward the original text untouched. */
export function maskText(text: string, providerId: string): MaskedText | undefined {
  const rules = enabledRulesForProvider(getMaskingConfig(), providerId)
  if (rules.length === 0) return undefined

  const masked = maskTextWithRules(text, rules)
  if (!masked) return undefined
  logMasking(providerId, masked.restore.size, masked.hits)
  return { text: masked.text, restore: masked.restore, edits: masked.edits }
}

/** Mask credentials in a request body for `providerId`. Returns undefined when
 *  masking is off, the body isn't decodable text, or nothing matched. */
export function maskRequestBody(
  body: ArrayBuffer | undefined,
  providerId: string,
): MaskedRequest | undefined {
  if (!body || body.byteLength === 0) return undefined
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    return undefined // binary body (multipart upload, etc.) — leave it alone
  }
  const rules = enabledRulesForProvider(getMaskingConfig(), providerId)
  if (rules.length === 0) return undefined

  const masked = maskTextWithRules(text, rules)
  if (!masked) return undefined
  logMasking(providerId, masked.restore.size, masked.hits)
  return {
    body: toArrayBuffer(new TextEncoder().encode(masked.text)),
    restore: masked.restore,
    edits: masked.edits,
  }
}

function maskTextWithRules(
  text: string,
  rules: readonly MaskingRule[],
):
  | { text: string; restore: Map<string, string>; hits: Record<string, number>; edits: GuardEdit[] }
  | undefined {
  const unscoped = rules.filter((r) => !r.scope)
  const scoped = rules.filter((r) => r.scope)
  let maskedText = text
  let changed = false
  const restore = new Map<string, string>()
  const hits: Record<string, number> = {}
  const edits: GuardEdit[] = []

  if (scoped.length > 0) {
    const scopedResult = maskScopedJsonText(maskedText, scoped)
    if (scopedResult) {
      maskedText = scopedResult.text
      changed = true
      mergeRestore(restore, scopedResult.restore)
      mergeHits(hits, scopedResult.hits)
      edits.push(...scopedResult.edits)
    }
  }

  if (unscoped.length > 0) {
    const result = maskCredentials(maskedText, unscoped)
    if (result.masked !== maskedText || result.restore.size > 0) {
      maskedText = result.masked
      changed = true
      mergeRestore(restore, result.restore)
      mergeHits(hits, result.hits)
    }
  }

  return changed ? { text: maskedText, restore, hits, edits } : undefined
}

type Raw = Record<string, unknown>
type MessageRef = {
  role: string
  apply(rules: readonly MaskingRule[]): {
    changed: boolean
    restore: Map<string, string>
    hits: Record<string, number>
    edits: GuardEdit[]
  }
}

function maskScopedJsonText(
  text: string,
  rules: readonly MaskingRule[],
):
  | { text: string; restore: Map<string, string>; hits: Record<string, number>; edits: GuardEdit[] }
  | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(parsed)) return undefined

  const refs = collectMessageRefs(parsed)
  const restore = new Map<string, string>()
  const hits: Record<string, number> = {}
  const edits: GuardEdit[] = []
  let changed = false

  for (const rule of rules) {
    const scope = rule.scope
    if (!scope) continue
    const matching = refs.filter((r) => scope.role === 'any' || r.role === scope.role)
    const selected = scope.message === 'first' ? matching.slice(0, 1) : matching
    for (const ref of selected) {
      const result = ref.apply([rule])
      if (!result.changed) continue
      changed = true
      mergeRestore(restore, result.restore)
      mergeHits(hits, result.hits)
      edits.push(...result.edits)
    }
  }

  return changed ? { text: JSON.stringify(parsed), restore, hits, edits } : undefined
}

function collectMessageRefs(root: Raw): MessageRef[] {
  const refs: MessageRef[] = []
  if (typeof root.system === 'string') {
    refs.push(stringPropRef(root, 'system', 'system', '$.system'))
  } else if (Array.isArray(root.system)) {
    refs.push(contentArrayRef(root.system, 'system', '$.system'))
  }
  if (typeof root.instructions === 'string') {
    refs.push(stringPropRef(root, 'instructions', 'developer', '$.instructions'))
  }
  if (Array.isArray(root.messages)) collectMessageArrayRefs(refs, root.messages, '$.messages')
  if (Array.isArray(root.input)) collectMessageArrayRefs(refs, root.input, '$.input')
  return refs
}

function collectMessageArrayRefs(refs: MessageRef[], messages: unknown[], basePath: string): void {
  for (const [index, item] of messages.entries()) {
    if (!isObject(item)) continue
    const role = typeof item.role === 'string' ? item.role : 'user'
    const itemPath = `${basePath}[${index}]`
    if (typeof item.content === 'string') {
      refs.push(stringPropRef(item, 'content', role, `${itemPath}.content`))
    } else if (Array.isArray(item.content)) {
      refs.push(contentArrayRef(item.content, role, `${itemPath}.content`))
    } else if (typeof item.input === 'string') {
      refs.push(stringPropRef(item, 'input', role, `${itemPath}.input`))
    }
  }
}

function stringPropRef(obj: Raw, key: string, role: string, path: string): MessageRef {
  return {
    role,
    apply(rules) {
      const before = typeof obj[key] === 'string' ? obj[key] : ''
      const result = maskCredentials(before, rules)
      if (result.masked !== before) obj[key] = result.masked
      return {
        changed: result.masked !== before,
        restore: result.restore,
        hits: result.hits,
        edits:
          result.masked !== before
            ? editsForResult(path, role, before, result.masked, result.hits)
            : [],
      }
    },
  }
}

function contentArrayRef(content: unknown[], role: string, path: string): MessageRef {
  return {
    role,
    apply(rules) {
      const restore = new Map<string, string>()
      const hits: Record<string, number> = {}
      const edits: GuardEdit[] = []
      let changed = false
      for (const [index, part] of content.entries()) {
        if (!isObject(part) || typeof part.text !== 'string') continue
        const before = part.text
        const result = maskCredentials(part.text, rules)
        if (result.masked === before) continue
        part.text = result.masked
        changed = true
        mergeRestore(restore, result.restore)
        mergeHits(hits, result.hits)
        edits.push(
          ...editsForResult(`${path}[${index}].text`, role, before, result.masked, result.hits),
        )
      }
      return { changed, restore, hits, edits }
    },
  }
}

function editsForResult(
  path: string,
  role: string,
  before: string,
  after: string,
  hits: Record<string, number>,
): GuardEdit[] {
  const ruleIds = Object.keys(hits)
  const fragment = changedFragment(before, after)
  return (ruleIds.length > 0 ? ruleIds : ['masking']).map((ruleId) => ({
    ruleId,
    path,
    role,
    before: fragment.before,
    after: fragment.after,
  }))
}

function changedFragment(before: string, after: string): { before: string; after: string } {
  if (before === after) return { before, after }

  let start = 0
  const maxStart = Math.min(before.length, after.length)
  while (start < maxStart && before[start] === after[start]) start++

  let beforeEnd = before.length
  let afterEnd = after.length
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--
    afterEnd--
  }

  const left = expandLeft(before, start)
  const beforeRight = expandRight(before, beforeEnd)
  const afterRight = expandRight(after, afterEnd)
  return {
    before: before.slice(left, beforeRight),
    after: after.slice(left, afterRight),
  }
}

function expandLeft(text: string, index: number): number {
  let i = index
  while (i > 0 && !/\s/.test(text.charAt(i - 1))) i--
  return i
}

function expandRight(text: string, index: number): number {
  let i = index
  while (i < text.length && !/\s/.test(text.charAt(i))) i++
  return i
}

function mergeRestore(into: Map<string, string>, from: Map<string, string>): void {
  for (const [fake, real] of from) into.set(fake, real)
}

function mergeHits(into: Record<string, number>, from: Record<string, number>): void {
  for (const [id, n] of Object.entries(from)) into[id] = (into[id] ?? 0) + n
}

function logMasking(providerId: string, restored: number, hits: Record<string, number>): void {
  const summary = Object.entries(hits)
    .map(([id, n]) => `${id}×${n}`)
    .join(', ')
  logger.info(`masking: applied ${summary || 'no hits'} → ${providerId} [restore=${restored}]`)
}

function isObject(v: unknown): v is Raw {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

/** Restore real values in a buffered response string (the orchestrated buffered
 *  path). No-op when nothing was masked. */
export function restoreText(text: string, restore: Map<string, string>): string {
  let out = text
  for (const [fake, real] of restore) out = out.split(fake).join(real)
  return out
}

/** A TransformStream that replaces every fake with its real value in a byte
 *  stream, handling fakes that straddle a chunk boundary by holding back a
 *  short tail. Fakes are ASCII and the real values these rules match contain no
 *  JSON-special characters, so byte-level replacement is safe for both SSE and
 *  buffered JSON responses without re-escaping. */
export function makeRestoreTransform(
  restore: Map<string, string>,
): TransformStream<Uint8Array, Uint8Array> {
  const pairs = [...restore.entries()].map(([fake, real]) => ({
    fake: Buffer.from(fake, 'utf8'),
    real: Buffer.from(real, 'utf8'),
  }))
  // Hold back (maxFake - 1) bytes so a fake split across two chunks still
  // matches once the next chunk arrives.
  const maxFake = pairs.reduce((m, p) => Math.max(m, p.fake.length), 0)
  let carry = Buffer.alloc(0)

  const replaceAll = (buf: Buffer): Buffer => {
    let out = buf
    for (const { fake, real } of pairs) {
      let idx = out.indexOf(fake)
      if (idx < 0) continue
      const parts: Buffer[] = []
      let from = 0
      while (idx >= 0) {
        parts.push(out.subarray(from, idx), real)
        from = idx + fake.length
        idx = out.indexOf(fake, from)
      }
      parts.push(out.subarray(from))
      out = Buffer.concat(parts)
    }
    return out
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const buf = replaceAll(Buffer.concat([carry, Buffer.from(chunk)]))
      const keep = Math.min(Math.max(maxFake - 1, 0), buf.length)
      const emit = buf.subarray(0, buf.length - keep)
      carry = Buffer.from(buf.subarray(buf.length - keep))
      if (emit.length > 0) controller.enqueue(new Uint8Array(emit))
    },
    flush(controller) {
      const buf = replaceAll(carry)
      if (buf.length > 0) controller.enqueue(new Uint8Array(buf))
    },
  })
}

/** Wrap a response stream so the masked fakes are restored to their real
 *  values before reaching the agent. No-op (returns the input) when nothing was
 *  masked. */
export function restoreResponseStream(
  stream: ReadableStream<Uint8Array>,
  masked: MaskedRequest | undefined,
): ReadableStream<Uint8Array> {
  if (!masked || masked.restore.size === 0) return stream
  return stream.pipeThrough(makeRestoreTransform(masked.restore))
}
