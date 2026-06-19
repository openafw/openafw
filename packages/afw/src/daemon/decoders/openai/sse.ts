import { createParser } from 'eventsource-parser'
import type { NormalizedBlock } from '../../../core/packet.ts'

// biome-ignore lint/suspicious/noExplicitAny: OpenAI-compatible providers vary.
type Any = any

type InProgressToolCall = {
  id?: string
  name?: string
  argsBuffer: string
}

export type OpenAIChatStreamResult = {
  blocks: NormalizedBlock[]
  model?: string
  finishReason?: string
  usage: {
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
  }
  errors: string[]
}

export async function parseOpenAIChatStream(
  stream: ReadableStream<Uint8Array>,
): Promise<OpenAIChatStreamResult> {
  const result: OpenAIChatStreamResult = { blocks: [], usage: {}, errors: [] }
  let textContent = ''
  const toolCalls = new Map<number, InProgressToolCall>()

  const parser = createParser({
    onEvent: (ev) => {
      if (ev.data === '[DONE]') return
      let data: Any
      try {
        data = JSON.parse(ev.data)
      } catch {
        result.errors.push(`failed to parse SSE event: ${ev.data.slice(0, 80)}`)
        return
      }

      if (data.model && !result.model) result.model = data.model

      if (data.usage) {
        result.usage.inputTokens = data.usage.prompt_tokens
        result.usage.outputTokens = data.usage.completion_tokens
        const ptd = data.usage.prompt_tokens_details
        if (ptd?.cached_tokens) result.usage.cacheReadInputTokens = ptd.cached_tokens
      }

      const choice = data.choices?.[0]
      if (!choice) return

      const delta = choice.delta
      if (typeof delta?.content === 'string') textContent += delta.content

      if (Array.isArray(delta?.tool_calls)) {
        for (const t of delta.tool_calls) {
          const idx: number = t.index ?? 0
          const existing = toolCalls.get(idx) ?? { argsBuffer: '' }
          if (t.id) existing.id = t.id
          if (t.function?.name) existing.name = t.function.name
          if (typeof t.function?.arguments === 'string') {
            existing.argsBuffer += t.function.arguments
          }
          toolCalls.set(idx, existing)
        }
      }

      if (choice.finish_reason) result.finishReason = choice.finish_reason
    },
  })

  const decoder = new TextDecoder()
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    parser.feed(decoder.decode(chunk, { stream: true }))
  }
  parser.feed(decoder.decode())

  if (textContent.length > 0) {
    result.blocks.push({ type: 'text', text: textContent })
  }
  const sortedTools = [...toolCalls.entries()].sort((a, b) => a[0] - b[0])
  for (const [, tc] of sortedTools) {
    let input: unknown = {}
    if (tc.argsBuffer) {
      try {
        input = JSON.parse(tc.argsBuffer)
      } catch {
        /* keep rawJson for debugging */
      }
    }
    result.blocks.push({
      type: 'tool_use',
      id: tc.id ?? '',
      name: tc.name ?? '',
      input,
      rawJson: tc.argsBuffer || undefined,
    })
  }

  return result
}
