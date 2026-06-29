// Bridge afw's decoded AgentPacket → the OGR engine's normalized request shape.
// afw's decoders already normalize Anthropic / OpenAI into ModelCallPayload, so
// this only re-roles the messages for provenance and lifts tool calls out of the
// model response (what afw sees on the wire).

import type { ModelCallPayload, NormalizedBlock } from '../../core/packet.ts'
import type { NormMessage, NormRequest, NormToolCall } from './engine.ts'
import type { LlmProtocol } from './types.ts'

export function protocolOf(p: ModelCallPayload): LlmProtocol | null {
  switch (p.protocol) {
    case 'anthropic':
      return 'anthropic.messages'
    case 'openai-chat':
      return 'openai.chat'
    case 'openai-responses':
      return 'openai.responses'
    default:
      return null
  }
}

export function toNormRequest(p: ModelCallPayload, sessionId: string): NormRequest {
  const messages: NormMessage[] = []
  if (p.systemPrompt) messages.push({ role: 'system', content: p.systemPrompt })

  for (const raw of p.messages) {
    if (!raw || typeof raw !== 'object') continue
    pushMessage(messages, raw as Record<string, unknown>)
  }

  // The tool calls the model just emitted (response blocks) are the freshest
  // action signal on the wire — attach them so ConfigRules judges them.
  const toolCalls = responseToolCalls(p.response)
  if (toolCalls.length > 0) messages.push({ role: 'assistant', content: '', toolCalls })

  return { protocol: protocolOf(p), model: p.model, sessionId, messages }
}

// Flatten one inbound message into normalized entries. An Anthropic user message
// whose content holds tool_result blocks is split into a `tool` (untrusted)
// entry so provenance is correct; OpenAI `role:'tool'` maps straight through.
function pushMessage(out: NormMessage[], m: Record<string, unknown>): void {
  const role = typeof m.role === 'string' ? m.role : 'user'

  if (Array.isArray(m.content)) {
    const text: string[] = []
    for (const block of m.content) {
      if (!block || typeof block !== 'object') {
        if (typeof block === 'string') text.push(block)
        continue
      }
      const b = block as Record<string, unknown>
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', content: blockText(b.content) })
      } else {
        text.push(blockText(b.text ?? b.content ?? b))
      }
    }
    if (text.join('').trim()) out.push({ role, content: text.join('\n') })
    return
  }

  out.push({ role, content: contentText(m.content) })
}

function responseToolCalls(blocks: NormalizedBlock[]): NormToolCall[] {
  const out: NormToolCall[] = []
  for (const b of blocks) {
    if (b.type === 'tool_use') out.push({ name: b.name, arguments: b.input })
  }
  return out
}

function contentText(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(blockText).join('\n')
  return blockText(content)
}

function blockText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    const t = (v as { text?: unknown }).text
    if (typeof t === 'string') return t
    try {
      return JSON.stringify(v)
    } catch {
      return ''
    }
  }
  return String(v)
}
