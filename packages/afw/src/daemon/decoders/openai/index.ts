import { newActionId, newRunId } from '../../../core/ids.ts'
import { logger } from '../../../core/logger.ts'
import type { AgentPacket, ModelCallPayload, NormalizedBlock } from '../../../core/packet.ts'
import { computeCost } from '../../cost/compute.ts'
import { appendPacket } from '../../store/writer.ts'
import { correlatedThreadId, deriveThreadTitle, effectiveInstanceId } from '../correlate.ts'
import { extractRequestParams } from '../params.ts'
import { type DecodeInput, type Decoder, headersToObject, teeForRaw } from '../types.ts'
import { parseOpenAIChatStream } from './sse.ts'

// biome-ignore lint/suspicious/noExplicitAny: third-party JSON payloads.
type Any = any

export const openaiChatDecoder: Decoder = {
  async decode(input: DecodeInput): Promise<void> {
    const contentType = input.resHeaders.get('content-type') ?? ''
    const isStream = contentType.includes('text/event-stream')

    const req = parseRequest(input.reqBody)
    const rawReq = input.reqBody ? new Uint8Array(input.reqBody) : undefined
    const { parse: resStream, raw: rawResP } = teeForRaw(input.resBody)

    let blocks: NormalizedBlock[] = []
    let model: string = req.model ?? ''
    let finishReason: string | undefined
    let usageIn = 0
    let usageOut = 0
    let cacheRead: number | undefined
    let errorMsg: string | undefined

    if (isStream && input.resStatus < 400) {
      try {
        const parsed = await parseOpenAIChatStream(resStream)
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
        // Non-JSON body. Common when the upstream returns an HTML error page
        // (xiangxinai/Cloudflare/nginx for 4xx/5xx). Surface the body excerpt
        // instead of "Unexpected token '<'".
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
          // Non-OpenAI error shape (e.g. vLLM emits
          // `{object: "error", message, type, code}` with no `.error`
          // key). Without this fallback the captured packet has no
          // body excerpt and the UI shows "(empty body)" even though
          // the upstream told us exactly what was wrong.
          errorMsg = JSON.stringify(json)
        }
        if (json.usage) {
          usageIn = json.usage.prompt_tokens ?? 0
          usageOut = json.usage.completion_tokens ?? 0
          cacheRead = json.usage.prompt_tokens_details?.cached_tokens
        }
        const choice = json.choices?.[0]
        if (choice) {
          if (choice.finish_reason) finishReason = choice.finish_reason
          const msg = choice.message
          if (msg) {
            if (typeof msg.content === 'string' && msg.content.length > 0) {
              blocks.push({ type: 'text', text: msg.content })
            }
            if (Array.isArray(msg.tool_calls)) {
              for (const tc of msg.tool_calls) {
                let inp: unknown = {}
                try {
                  inp = JSON.parse(tc.function?.arguments ?? '{}')
                } catch {
                  /* keep raw */
                }
                blocks.push({
                  type: 'tool_use',
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  input: inp,
                  rawJson: tc.function?.arguments,
                })
              }
            }
          }
        }
        if (json.model) model = json.model
      }
    }

    const durMs = performance.now() - input.startedAt
    const ts = Date.now() - Math.round(durMs)

    // why: OpenAI's prompt_tokens is the GROSS input including cached_tokens.
    // We store tokensIn as the fresh (non-cache-hit) portion so storage has
    // one semantics across all decoders (Anthropic already excludes cache).
    const freshIn = Math.max(0, usageIn - (cacheRead ?? 0))

    const usd = computeCost({
      decoder: 'openai-chat',
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
              decoder: 'openai-chat',
              model: input.clientModel,
              inputTokens: freshIn,
              outputTokens: usageOut,
              cacheReadTokens: cacheRead,
            }) - usd,
          )
        : 0

    const payload: ModelCallPayload = {
      kind: 'model_call',
      protocol: 'openai-chat',
      endpoint: input.upstreamUrl,
      model,
      ...(input.clientModel && input.clientModel !== model
        ? { clientModel: input.clientModel }
        : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
      systemPrompt: extractSystem(req.messages),
      messages: Array.isArray(req.messages) ? req.messages : [],
      tools: Array.isArray(req.tools) ? req.tools : undefined,
      params: extractRequestParams(req),
      stream: isStream,
      response: blocks,
      stopReason: finishReason,
      status: input.resStatus,
      error: errorMsg,
      ...(input.resStatus >= 400 ? { errorHeaders: headersToObject(input.resHeaders) } : {}),
      ...(input.orchestration ? { orchestration: input.orchestration } : {}),
      ...(input.guardEdits?.length ? { guardEdits: input.guardEdits } : {}),
    }

    const messages = Array.isArray(req.messages) ? req.messages : []
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
      `captured ${input.agent}/openai-chat ${model || '?'} ` +
        `${input.resStatus} tokens=${freshIn}/${usageOut}${cacheStr} ` +
        `$${usd.toFixed(6)} ${durMs.toFixed(0)}ms` +
        (errorMsg ? ` err="${errorMsg.slice(0, 80)}"` : ''),
    )
  },
}

function parseRequest(buf: ArrayBuffer | undefined): Any {
  if (!buf) return {}
  try {
    return JSON.parse(new TextDecoder().decode(buf))
  } catch {
    return {}
  }
}

function extractSystem(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (const m of messages as Any[]) {
    if (m?.role === 'system' && typeof m.content === 'string') return m.content
  }
  return undefined
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
  // Strip HTML tags and collapse whitespace for a one-line human-readable
  // peek at error bodies (xiangxinai, Cloudflare, etc.).
  const stripped = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.slice(0, 200)
}
