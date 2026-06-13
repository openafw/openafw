import { newActionId, newRunId } from '../../../core/ids.ts'
import { logger } from '../../../core/logger.ts'
import type { AgentPacket, ModelCallPayload, NormalizedBlock } from '../../../core/packet.ts'
import { computeCost } from '../../cost/compute.ts'
import { appendPacket } from '../../store/writer.ts'
import { correlatedThreadId, deriveThreadTitle, effectiveInstanceId } from '../correlate.ts'
import { extractRequestParams } from '../params.ts'
import { type DecodeInput, type Decoder, headersToObject, teeForRaw } from '../types.ts'
import { collectOutputBlocks, parseOpenAIResponsesStream } from './responses-sse.ts'

// biome-ignore lint/suspicious/noExplicitAny: third-party JSON shapes.
type Any = any

/**
 * Decoder for the OpenAI Responses API.
 *
 *   POST /v1/responses                                   (api.openai.com)
 *   POST /backend-api/codex/responses                    (chatgpt.com — used
 *                                                          by Codex CLI on
 *                                                          ChatGPT-Plus auth)
 *
 * Shape (different from Chat Completions):
 *   request.input      = mixed array of {type:'message'|'function_call'|
 *                                         'function_call_output', ...}
 *   request.instructions = system text
 *   response.output    = mixed array of {type:'message'|'function_call'|
 *                                         'reasoning', ...}
 *   response.usage     = { input_tokens, output_tokens,
 *                          input_tokens_details: { cached_tokens } }
 *
 * Normalisation:
 *   - request.input  → messages array in Anthropic-ish shape so the run
 *                       detail / outcome detectors don't need a new path
 *   - request.instructions → systemPrompt
 *   - response.output → NormalizedBlock[] (text / tool_use / thinking)
 */
export const openaiResponsesDecoder: Decoder = {
  async decode(input: DecodeInput): Promise<void> {
    const req = parseRequest(input.reqBody)
    const rawReq = input.reqBody ? new Uint8Array(input.reqBody) : undefined
    const { parse: resStream, raw: rawResP } = teeForRaw(input.resBody)

    // chatgpt.com/backend-api/codex (Codex on ChatGPT auth) omits the
    // content-type header on its SSE responses. Fall back to the
    // request's `stream: true` flag — Codex sets it for every /responses
    // call. The official api.openai.com upstream still ships
    // content-type: text/event-stream so the header check stays as the
    // primary signal.
    const contentType = input.resHeaders.get('content-type') ?? ''
    const isStream = contentType.includes('text/event-stream') || req.stream === true

    let blocks: NormalizedBlock[] = []
    let model: string = req.model ?? ''
    let finishReason: string | undefined
    let usageIn = 0
    let usageOut = 0
    let cacheRead: number | undefined
    let errorMsg: string | undefined

    if (isStream && input.resStatus < 400) {
      try {
        const parsed = await parseOpenAIResponsesStream(resStream)
        blocks = parsed.blocks
        if (parsed.model) model = parsed.model
        finishReason = parsed.finishReason
        usageIn = parsed.usage.inputTokens ?? 0
        usageOut = parsed.usage.outputTokens ?? 0
        cacheRead = parsed.usage.cacheReadInputTokens
        if (parsed.errors.length > 0) errorMsg = parsed.errors.join('; ')
      } catch (err) {
        errorMsg = `stream decode error: ${(err as Error).message}`
      }
    } else {
      const buf = await readAll(resStream)
      const text = new TextDecoder().decode(buf)
      let json: Any = null
      try {
        json = JSON.parse(text)
      } catch {
        if (input.resStatus >= 400) {
          errorMsg = `HTTP ${input.resStatus}: ${snippet(text)}`
        } else if (text.trim().length > 0) {
          errorMsg = `non-JSON response: ${snippet(text)}`
        }
      }
      if (json) {
        if (json.error) {
          errorMsg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error)
        } else if (input.resStatus >= 400) {
          // Non-Responses error shape (e.g. vLLM
          // `{object: "error", message, type, code}`). Capture the whole
          // body so the UI doesn't show "(empty body)" when the upstream
          // actually told us what was wrong.
          errorMsg = JSON.stringify(json)
        }
        const usage = json.usage ?? {}
        usageIn = usage.input_tokens ?? usage.prompt_tokens ?? 0
        usageOut = usage.output_tokens ?? usage.completion_tokens ?? 0
        const cached =
          usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens
        if (typeof cached === 'number') cacheRead = cached
        if (json.model) model = json.model
        if (typeof json.status === 'string' && json.status !== 'completed') {
          finishReason = json.status
        }
        blocks = collectOutputBlocks(json.output)
      }
    }

    const durMs = performance.now() - input.startedAt
    const ts = Date.now() - Math.round(durMs)

    // why: OpenAI's input_tokens is the GROSS input including cached tokens.
    // Normalize to fresh-only at storage so all decoders share one semantics.
    const freshIn = Math.max(0, usageIn - (cacheRead ?? 0))

    const usd = computeCost({
      // why: pricing is keyed on the decoder ID. We register Responses
      // pricing under 'openai-responses' so users can add custom rates
      // via ~/.agentfw/pricing.json without confusing them with Chat
      // pricing for the same model name.
      decoder: 'openai-responses',
      model,
      inputTokens: freshIn,
      outputTokens: usageOut,
      cacheReadTokens: cacheRead,
    })
    const savedUsd =
      input.clientModel && input.clientModel !== model
        ? Math.max(
            0,
            computeCost({
              decoder: 'openai-responses',
              model: input.clientModel,
              inputTokens: freshIn,
              outputTokens: usageOut,
              cacheReadTokens: cacheRead,
            }) - usd,
          )
        : 0

    const messages = inputToMessages(req.input)
    const payload: ModelCallPayload = {
      kind: 'model_call',
      protocol: 'openai-responses',
      endpoint: input.upstreamUrl,
      model,
      ...(input.clientModel && input.clientModel !== model
        ? { clientModel: input.clientModel }
        : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
      systemPrompt: typeof req.instructions === 'string' ? req.instructions : undefined,
      messages,
      tools: Array.isArray(req.tools) ? req.tools : undefined,
      params: extractRequestParams(req),
      stream: isStream,
      response: blocks,
      stopReason: finishReason,
      status: input.resStatus,
      error: errorMsg,
      ...(input.resStatus >= 400 ? { errorHeaders: headersToObject(input.resHeaders) } : {}),
      ...(input.orchestration ? { orchestration: input.orchestration } : {}),
    }

    const threadTitle = deriveThreadTitle(messages)
    const instanceId = effectiveInstanceId(input.instanceId, input.agent, input.clientModel)
    const rawRes = await rawResP
    const packet: AgentPacket = {
      id: newActionId(),
      runId: newRunId(),
      threadId: correlatedThreadId(input.agent, messages, instanceId),
      ...(threadTitle ? { threadTitle } : {}),
      ...(instanceId ? { instanceId } : {}),
      ...(rawReq ? { rawReq } : {}),
      ...(rawRes.length > 0 ? { rawRes } : {}),
      ts,
      durMs,
      sourceAgent: input.agent,
      cost: {
        usd,
        tokensIn: freshIn,
        tokensOut: usageOut,
        tokensCacheRead: cacheRead,
        ...(savedUsd > 0 ? { savedUsd } : {}),
      },
      payload,
    }

    await appendPacket(packet)
    const cacheStr = cacheRead ? ` cache=${cacheRead}r` : ''
    logger.info(
      `captured ${input.agent}/openai-responses ${model || '?'} ` +
        `${input.resStatus} tokens=${freshIn}/${usageOut}${cacheStr} ` +
        `$${usd.toFixed(6)} ${durMs.toFixed(0)}ms` +
        (errorMsg ? ` err="${errorMsg.slice(0, 80)}"` : ''),
    )
  },
}

/**
 * Convert a Responses-API request.input array into messages-shape so the
 * run-detail conversation view (which expects Anthropic-ish content) can
 * render it without a special case.
 */
export function inputToMessages(input: unknown): Any[] {
  if (!Array.isArray(input)) return []
  const out: Any[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const it = item as Any
    if (it.type === 'message' || (it.role && it.content)) {
      out.push({ role: it.role ?? 'user', content: normaliseMessageContent(it.content) })
      continue
    }
    if (it.type === 'function_call') {
      // assistant turn that issued a tool call
      out.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: it.call_id ?? it.id ?? '',
            name: it.name ?? it.function?.name ?? '',
            input: tryParseArgs(it.arguments ?? it.function?.arguments),
          },
        ],
      })
      continue
    }
    if (it.type === 'function_call_output' || it.type === 'tool_result') {
      // tool result message
      out.push({
        role: 'tool',
        tool_call_id: it.call_id ?? it.id ?? '',
        content: it.output ?? it.content ?? '',
      })
      continue
    }
  }
  return out
}

function normaliseMessageContent(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content
  // Responses API uses {type:'input_text'|'output_text', text} parts.
  // The run-detail renderer already understands {type:'text', text}; map
  // input_text/output_text → text so it lights up.
  return content.map((c) => {
    if (!c || typeof c !== 'object') return c
    const o = c as Any
    if (o.type === 'input_text' || o.type === 'output_text') {
      return { type: 'text', text: o.text ?? '' }
    }
    return c
  })
}

function tryParseArgs(raw: unknown): unknown {
  if (raw == null) return {}
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

function parseRequest(buf: ArrayBuffer | undefined): Any {
  if (!buf) return {}
  try {
    return JSON.parse(new TextDecoder().decode(buf))
  } catch {
    return {}
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function snippet(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}
