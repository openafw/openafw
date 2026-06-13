import { createParser } from 'eventsource-parser'
import type { NormalizedBlock } from '../../../core/packet.ts'

export type AnthropicStreamResult = {
  blocks: NormalizedBlock[]
  model?: string
  stopReason?: string
  usage: {
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
  }
  errors: string[]
}

type InProgress =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; rawJson: string }
  | { type: 'thinking'; text: string }
  | { type: 'unknown'; raw: unknown }

// biome-ignore lint/suspicious/noExplicitAny: SSE payloads from third-party providers are arbitrary JSON.
type Any = any

export async function parseAnthropicStream(
  stream: ReadableStream<Uint8Array>,
): Promise<AnthropicStreamResult> {
  const result: AnthropicStreamResult = { blocks: [], usage: {}, errors: [] }
  const inProgress = new Map<number, InProgress>()
  const completed: (NormalizedBlock | undefined)[] = []

  const parser = createParser({
    onEvent: (ev) => {
      let data: Any
      try {
        data = JSON.parse(ev.data)
      } catch {
        result.errors.push(`failed to parse SSE event: ${ev.data.slice(0, 80)}`)
        return
      }

      const t: string | undefined = data?.type
      if (!t) return

      switch (t) {
        case 'message_start': {
          if (data.message?.model) result.model = data.message.model
          if (data.message?.usage) {
            result.usage.inputTokens = data.message.usage.input_tokens
            result.usage.cacheReadInputTokens = data.message.usage.cache_read_input_tokens
            result.usage.cacheCreationInputTokens = data.message.usage.cache_creation_input_tokens
          }
          break
        }

        case 'content_block_start': {
          const idx: number = data.index
          const cb = data.content_block
          if (!cb) break
          if (cb.type === 'text') {
            inProgress.set(idx, { type: 'text', text: cb.text ?? '' })
          } else if (cb.type === 'tool_use') {
            inProgress.set(idx, {
              type: 'tool_use',
              id: cb.id ?? '',
              name: cb.name ?? '',
              rawJson: '',
            })
          } else if (cb.type === 'thinking') {
            inProgress.set(idx, { type: 'thinking', text: cb.thinking ?? '' })
          } else {
            inProgress.set(idx, { type: 'unknown', raw: cb })
          }
          break
        }

        case 'content_block_delta': {
          const idx: number = data.index
          const delta = data.delta
          const block = inProgress.get(idx)
          if (!block || !delta) break
          if (delta.type === 'text_delta' && block.type === 'text') {
            block.text += delta.text ?? ''
          } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
            block.rawJson += delta.partial_json ?? ''
          } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
            block.text += delta.thinking ?? ''
          }
          break
        }

        case 'content_block_stop': {
          const idx: number = data.index
          const block = inProgress.get(idx)
          if (!block) break
          inProgress.delete(idx)

          if (block.type === 'text') {
            completed[idx] = { type: 'text', text: block.text }
          } else if (block.type === 'tool_use') {
            let input: unknown = {}
            if (block.rawJson) {
              try {
                input = JSON.parse(block.rawJson)
              } catch {
                /* keep rawJson for debugging */
              }
            }
            completed[idx] = {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input,
              rawJson: block.rawJson || undefined,
            }
          } else if (block.type === 'thinking') {
            completed[idx] = { type: 'thinking', text: block.text }
          } else {
            completed[idx] = { type: 'unknown', raw: block.raw }
          }
          break
        }

        case 'message_delta': {
          if (data.delta?.stop_reason) result.stopReason = data.delta.stop_reason
          if (data.usage) {
            if (data.usage.output_tokens !== undefined) {
              result.usage.outputTokens = data.usage.output_tokens
            }
            if (data.usage.input_tokens !== undefined) {
              result.usage.inputTokens = data.usage.input_tokens
            }
          }
          break
        }

        case 'message_stop':
          break

        case 'error':
          result.errors.push(JSON.stringify(data))
          break
      }
    },
  })

  const td = new TextDecoder()
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    parser.feed(td.decode(chunk, { stream: true }))
  }
  parser.feed(td.decode())

  result.blocks = completed.filter((b): b is NormalizedBlock => b != null)
  return result
}
