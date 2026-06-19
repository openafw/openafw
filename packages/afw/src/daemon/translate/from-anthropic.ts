// Anthropic Messages → neutral IR. The IR is already Anthropic-shaped, so this
// is the lightest of the three parsers — mostly defensive field reads.

import type { NormalizedBlock } from '../../core/packet.ts'
import {
  type IRBlock,
  type IRImageSource,
  type IRMessage,
  type IRRequest,
  type IRResponse,
  type IRTool,
  mergeConsecutive,
} from './ir.ts'
import { asObject, num, optNum, str } from './shared.ts'

export function requestToIR(body: unknown): IRRequest {
  const b = asObject(body)
  const messages: IRMessage[] = []
  if (Array.isArray(b.messages)) {
    for (const raw of b.messages) {
      const m = asObject(raw)
      const role = m.role === 'assistant' ? 'assistant' : 'user'
      messages.push({ role, content: contentToBlocks(m.content) })
    }
  }
  return {
    model: str(b.model) ?? '',
    system: systemToString(b.system),
    messages: mergeConsecutive(messages),
    tools: toolsToIR(b.tools),
    ...(toolChoiceToIR(b.tool_choice) ? { toolChoice: toolChoiceToIR(b.tool_choice) } : {}),
    maxTokens: optNum(b.max_tokens),
    temperature: optNum(b.temperature),
    stream: b.stream === true,
  }
}

/** Anthropic tool_choice → IR. Returns undefined for absent or
 *  unrecognised values (caller omits the field). */
function toolChoiceToIR(raw: unknown): import('./ir.ts').IRToolChoice | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const type = typeof o.type === 'string' ? o.type : ''
  if (type === 'auto') return { kind: 'auto' }
  if (type === 'any') return { kind: 'any' }
  if (type === 'none') return { kind: 'none' }
  if (type === 'tool' && typeof o.name === 'string' && o.name.length > 0) {
    return { kind: 'tool', name: o.name }
  }
  return undefined
}

export function responseToIR(json: unknown): IRResponse {
  const j = asObject(json)
  const blocks: NormalizedBlock[] = []
  if (Array.isArray(j.content)) {
    for (const raw of j.content) {
      const c = asObject(raw)
      switch (c.type) {
        case 'text':
          blocks.push({ type: 'text', text: typeof c.text === 'string' ? c.text : '' })
          break
        case 'tool_use':
          blocks.push({
            type: 'tool_use',
            id: str(c.id) ?? '',
            name: str(c.name) ?? '',
            input: c.input ?? {},
          })
          break
        case 'thinking':
        case 'redacted_thinking':
          blocks.push({ type: 'thinking', text: typeof c.thinking === 'string' ? c.thinking : '' })
          break
        case 'image':
          blocks.push({ type: 'image', source: c.source })
          break
        default:
          blocks.push({ type: 'unknown', raw })
          break
      }
    }
  }
  const usage = asObject(j.usage)
  return {
    model: str(j.model) ?? '',
    blocks,
    stopReason: str(j.stop_reason),
    usage: {
      in: num(usage.input_tokens),
      out: num(usage.output_tokens),
      cacheRead: optNum(usage.cache_read_input_tokens),
      cacheWrite: optNum(usage.cache_creation_input_tokens),
    },
  }
}

// ── helpers ───────────────────────────────────────────────────────

function systemToString(system: unknown): string | undefined {
  if (typeof system === 'string') return system.length > 0 ? system : undefined
  if (Array.isArray(system)) {
    const text = system
      .map((p) => (typeof asObject(p).text === 'string' ? (asObject(p).text as string) : ''))
      .filter((t) => t.length > 0)
      .join('\n')
    return text.length > 0 ? text : undefined
  }
  return undefined
}

function contentToBlocks(content: unknown): IRBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: IRBlock[] = []
  for (const raw of content) {
    const c = asObject(raw)
    switch (c.type) {
      case 'text':
        blocks.push({ type: 'text', text: typeof c.text === 'string' ? c.text : '' })
        break
      case 'image': {
        const src = imageToSource(c.source)
        if (src) blocks.push({ type: 'image', source: src })
        break
      }
      case 'tool_use':
        blocks.push({
          type: 'tool_use',
          id: str(c.id) ?? '',
          name: str(c.name) ?? '',
          input: c.input ?? {},
        })
        break
      case 'tool_result':
        blocks.push({
          type: 'tool_result',
          toolUseId: str(c.tool_use_id) ?? '',
          content: contentToBlocks(c.content),
          isError: c.is_error === true ? true : undefined,
        })
        break
      case 'thinking':
      case 'redacted_thinking':
        blocks.push({ type: 'thinking', text: typeof c.thinking === 'string' ? c.thinking : '' })
        break
      default:
        break
    }
  }
  return blocks
}

function imageToSource(source: unknown): IRImageSource | undefined {
  const s = asObject(source)
  if (s.type === 'base64' && typeof s.data === 'string') {
    return { kind: 'base64', mediaType: str(s.media_type) ?? 'image/png', data: s.data }
  }
  if (s.type === 'url' && typeof s.url === 'string') {
    return { kind: 'url', url: s.url }
  }
  return undefined
}

function toolsToIR(tools: unknown): IRTool[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const out: IRTool[] = []
  for (const raw of tools) {
    const t = asObject(raw)
    const name = str(t.name)
    if (!name) continue
    out.push({
      name,
      description: str(t.description),
      inputSchema: t.input_schema ?? { type: 'object' },
    })
  }
  return out.length > 0 ? out : undefined
}
