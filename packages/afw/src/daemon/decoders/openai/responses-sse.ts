// Streaming parser for the OpenAI Responses API
// (POST /v1/responses or chatgpt.com/backend-api/codex/responses).
//
// We don't replay every delta — the `response.completed` event carries
// the full final state (output items, usage). We just keep the first
// model name we see, the final completed payload, and any error event.
// Falls back to last-seen delta text only if the stream never completes.

import { createParser } from 'eventsource-parser'
import type { NormalizedBlock } from '../../../core/packet.ts'

// biome-ignore lint/suspicious/noExplicitAny: third-party SSE shapes.
type Any = any

export type OpenAIResponsesStreamResult = {
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

export async function parseOpenAIResponsesStream(
  stream: ReadableStream<Uint8Array>,
): Promise<OpenAIResponsesStreamResult> {
  const result: OpenAIResponsesStreamResult = { blocks: [], usage: {}, errors: [] }
  let completedResponse: Any = null
  let deltaText = ''
  // codex's chatgpt session backend (store:false) sends an empty `output`
  // array on `response.completed`. The complete output items live in
  // `response.output_item.done.item` instead — we accumulate them as the
  // stream goes and use them as the primary source when the completed
  // payload's output is empty.
  const finalizedItems: Any[] = []

  const parser = createParser({
    onEvent: (ev) => {
      if (!ev.data || ev.data === '[DONE]') return
      let data: Any
      try {
        data = JSON.parse(ev.data)
      } catch {
        result.errors.push(`failed to parse SSE event: ${ev.data.slice(0, 80)}`)
        return
      }

      const type = data?.type ?? ''
      const response = data?.response ?? data?.item ?? null

      // First time we see a model id, capture it (early events carry it).
      if (response?.model && !result.model) result.model = response.model

      switch (type) {
        case 'response.created':
        case 'response.in_progress':
          // Carries the partial response shape; no useful new info yet.
          break

        case 'response.output_text.delta':
          if (typeof data.delta === 'string') deltaText += data.delta
          break

        case 'response.output_item.done':
          // The completed shape of one output item (message / function_call /
          // reasoning). Codex emits these for every item even when its
          // `response.completed.output` ends up empty.
          if (data.item && typeof data.item === 'object') finalizedItems.push(data.item)
          break

        case 'response.completed':
          completedResponse = data.response ?? null
          break

        case 'response.failed':
        case 'error':
          result.errors.push(
            typeof data.error === 'string'
              ? data.error
              : JSON.stringify(data.error ?? data.message ?? data).slice(0, 200),
          )
          break

        default:
          break
      }
    },
  })

  const decoder = new TextDecoder()
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    parser.feed(decoder.decode(chunk, { stream: true }))
  }
  parser.feed(decoder.decode())

  if (completedResponse) {
    if (completedResponse.model && !result.model) result.model = completedResponse.model
    const status = typeof completedResponse.status === 'string' ? completedResponse.status : ''
    if (status && status !== 'completed') result.finishReason = status

    const usage = completedResponse.usage ?? {}
    result.usage.inputTokens = usage.input_tokens ?? usage.prompt_tokens
    result.usage.outputTokens = usage.output_tokens ?? usage.completion_tokens
    const cached =
      usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens
    if (typeof cached === 'number') result.usage.cacheReadInputTokens = cached

    // Prefer `completedResponse.output` when it carries items (api.openai.com
    // ships them here); fall back to the per-item stream events when it's
    // empty (chatgpt.com/backend-api/codex with store:false).
    const completedOutput = Array.isArray(completedResponse.output) ? completedResponse.output : []
    const itemsSource = completedOutput.length > 0 ? completedOutput : finalizedItems
    result.blocks = collectOutputBlocks(itemsSource)
    if (result.blocks.length === 0 && deltaText) {
      // Last-ditch: items were all reasoning / unrecognized but text deltas
      // arrived earlier — salvage them.
      result.blocks = [{ type: 'text', text: deltaText }]
    }
  } else if (finalizedItems.length > 0) {
    // Stream ended without a completed event but we still have items.
    result.blocks = collectOutputBlocks(finalizedItems)
    result.errors.push('stream ended before response.completed')
  } else if (deltaText) {
    // Stream truncated before completed and no per-item events — salvage
    // whatever text deltas we saw.
    result.blocks = [{ type: 'text', text: deltaText }]
    result.errors.push('stream ended before response.completed')
  }

  return result
}

export function collectOutputBlocks(output: unknown): NormalizedBlock[] {
  if (!Array.isArray(output)) return []
  const blocks: NormalizedBlock[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const it = item as Any
    switch (it.type) {
      case 'message': {
        if (Array.isArray(it.content)) {
          for (const c of it.content) {
            if (!c || typeof c !== 'object') continue
            if ((c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') {
              blocks.push({ type: 'text', text: c.text })
            }
          }
        } else if (typeof it.content === 'string') {
          blocks.push({ type: 'text', text: it.content })
        }
        break
      }
      case 'local_shell_call': {
        // codex's shell built-in — surface it as a tool_use so the trace shows
        // the command instead of dropping the item.
        blocks.push({
          type: 'tool_use',
          id: it.call_id ?? it.id ?? '',
          name: 'local_shell',
          input: it.action && typeof it.action === 'object' ? it.action : {},
        })
        break
      }
      case 'custom_tool_call': {
        blocks.push({
          type: 'tool_use',
          id: it.call_id ?? it.id ?? '',
          name: typeof it.name === 'string' ? it.name : '',
          input: typeof it.input === 'string' ? it.input : (it.input ?? {}),
        })
        break
      }
      case 'function_call':
      case 'tool_call': {
        const name = typeof it.name === 'string' ? it.name : (it.function?.name ?? '')
        const argsRaw =
          typeof it.arguments === 'string'
            ? it.arguments
            : typeof it.function?.arguments === 'string'
              ? it.function.arguments
              : ''
        let input: unknown = {}
        if (argsRaw) {
          try {
            input = JSON.parse(argsRaw)
          } catch {
            /* keep rawJson */
          }
        }
        blocks.push({
          type: 'tool_use',
          id: it.call_id ?? it.id ?? '',
          name,
          input,
          rawJson: argsRaw || undefined,
        })
        break
      }
      case 'reasoning': {
        // The Responses API exposes reasoning as a list of summary entries
        // (when reasoning summaries are on) or as opaque tokens. Surface
        // whatever text we find so the conversation view shows a thinking
        // block instead of dropping it silently.
        const parts: string[] = []
        if (Array.isArray(it.summary)) {
          for (const s of it.summary) {
            if (typeof s === 'string') parts.push(s)
            else if (s && typeof s === 'object' && typeof s.text === 'string') parts.push(s.text)
          }
        } else if (typeof it.text === 'string') {
          parts.push(it.text)
        }
        if (parts.length > 0) blocks.push({ type: 'thinking', text: parts.join('\n') })
        break
      }
      default:
        break
    }
  }
  return blocks
}
