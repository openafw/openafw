// Proxy-side credential masking: swap real secrets for fakes in the outbound
// request body, and restore the real values in the inbound response stream.
// The pure find/replace + rule catalog live in core/masking.ts; this file is
// the wire glue (ArrayBuffer in, streaming transform out).

import { logger } from '../../core/logger.ts'
import { enabledRulesForProvider, maskCredentials } from '../../core/masking.ts'
import { getMaskingConfig } from '../masking/load.ts'

export type MaskedText = {
  /** The text with credentials swapped for fakes. */
  text: string
  /** fake → real, to restore the response. Non-empty by construction. */
  restore: Map<string, string>
}

export type MaskedRequest = {
  /** The body to forward upstream, with credentials swapped for fakes. */
  body: ArrayBuffer
  /** fake → real, to restore the response. Non-empty by construction. */
  restore: Map<string, string>
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

  const { masked, restore, hits } = maskCredentials(text, rules)
  if (restore.size === 0) return undefined

  const summary = Object.entries(hits)
    .map(([id, n]) => `${id}×${n}`)
    .join(', ')
  logger.info(
    `masking: swapped ${restore.size} credential(s) for fakes → ${providerId} [${summary}]`,
  )
  return { text: masked, restore }
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
  const masked = maskText(text, providerId)
  if (!masked) return undefined
  return { body: toArrayBuffer(new TextEncoder().encode(masked.text)), restore: masked.restore }
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
