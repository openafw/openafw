import { newActionId, newRunId } from '../../../core/ids.ts'
import { logger } from '../../../core/logger.ts'
import type { AgentPacket, ModelCallPayload, NormalizedBlock } from '../../../core/packet.ts'
import { computeCost } from '../../cost/compute.ts'
import { appendPacket } from '../../store/writer.ts'
import { correlatedThreadId, deriveThreadTitle, effectiveInstanceId } from '../correlate.ts'
import { extractRequestParams } from '../params.ts'
import { type DecodeInput, type Decoder, headersToObject, teeForRaw } from '../types.ts'
import { parseAnthropicStream } from './sse.ts'

// biome-ignore lint/suspicious/noExplicitAny: third-party JSON payloads.
type Any = any

export const anthropicDecoder: Decoder = {
  async decode(input: DecodeInput): Promise<void> {
    const contentType = input.resHeaders.get('content-type') ?? ''
    const isStream = contentType.includes('text/event-stream')

    const req = parseRequest(input.reqBody)
    const rawReq = input.reqBody ? new Uint8Array(input.reqBody) : undefined
    const { parse: resStream, raw: rawResP } = teeForRaw(input.resBody)

    let blocks: NormalizedBlock[] = []
    let model: string = req.model ?? ''
    let stopReason: string | undefined
    let usageIn = 0
    let usageOut = 0
    let cacheRead: number | undefined
    let cacheWrite: number | undefined
    let errorMsg: string | undefined

    if (isStream && input.resStatus < 400) {
      try {
        const parsed = await parseAnthropicStream(resStream)
        blocks = parsed.blocks
        if (parsed.model) model = parsed.model
        stopReason = parsed.stopReason
        usageIn = parsed.usage.inputTokens ?? 0
        usageOut = parsed.usage.outputTokens ?? 0
        cacheRead = parsed.usage.cacheReadInputTokens
        cacheWrite = parsed.usage.cacheCreationInputTokens
        if (parsed.errors.length > 0) errorMsg = parsed.errors.join('; ')
      } catch (err) {
        errorMsg = `stream decode error: ${(err as Error).message}`
      }
    } else {
      const buf = await readAll(resStream)
      try {
        const json: Any = JSON.parse(new TextDecoder().decode(buf))
        if (json.error) {
          errorMsg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error)
        } else if (input.resStatus >= 400) {
          // Upstream returned a 4xx/5xx with a JSON body that isn't in
          // Anthropic's `{error: {...}}` shape. Capture the whole body
          // so the UI doesn't lose the diagnostic.
          errorMsg = JSON.stringify(json)
        }
        if (json.usage) {
          usageIn = json.usage.input_tokens ?? 0
          usageOut = json.usage.output_tokens ?? 0
          cacheRead = json.usage.cache_read_input_tokens
          cacheWrite = json.usage.cache_creation_input_tokens
        }
        if (Array.isArray(json.content)) blocks = json.content as NormalizedBlock[]
        if (json.model) model = json.model
        if (json.stop_reason) stopReason = json.stop_reason
      } catch (err) {
        errorMsg = `non-stream parse error: ${(err as Error).message}`
      }
    }

    const durMs = performance.now() - input.startedAt
    const ts = Date.now() - Math.round(durMs)

    const payload: ModelCallPayload = {
      kind: 'model_call',
      protocol: 'anthropic',
      endpoint: input.upstreamUrl,
      model,
      ...(input.clientModel && input.clientModel !== model
        ? { clientModel: input.clientModel }
        : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
      systemPrompt: typeof req.system === 'string' ? req.system : undefined,
      messages: Array.isArray(req.messages) ? req.messages : [],
      tools: Array.isArray(req.tools) ? req.tools : undefined,
      params: extractRequestParams(req),
      stream: isStream,
      response: blocks,
      stopReason,
      status: input.resStatus,
      error: errorMsg,
      ...(input.resStatus >= 400 ? { errorHeaders: headersToObject(input.resHeaders) } : {}),
      ...(input.orchestration ? { orchestration: input.orchestration } : {}),
    }

    const usd = computeCost({
      decoder: 'anthropic',
      model,
      inputTokens: usageIn,
      outputTokens: usageOut,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    })
    // Cost-saver savings: what the client-requested (pricier) model would have
    // cost at the same tokens, minus what the served model actually cost.
    const savedUsd =
      input.clientModel && input.clientModel !== model
        ? Math.max(
            0,
            computeCost({
              decoder: 'anthropic',
              model: input.clientModel,
              inputTokens: usageIn,
              outputTokens: usageOut,
              cacheReadTokens: cacheRead,
              cacheWriteTokens: cacheWrite,
            }) - usd,
          )
        : 0

    const messages = Array.isArray(req.messages) ? req.messages : []
    const threadTitle = deriveThreadTitle(messages)
    const instanceId = effectiveInstanceId(input.instanceId, input.agent, input.clientModel)
    const rawRes = await rawResP
    const packet: AgentPacket = {
      id: newActionId(),
      runId: newRunId(), // run still = one request; only thread is correlated
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
        tokensIn: usageIn,
        tokensOut: usageOut,
        tokensCacheRead: cacheRead,
        tokensCacheWrite: cacheWrite,
        ...(savedUsd > 0 ? { savedUsd } : {}),
      },
      payload,
    }

    await appendPacket(packet)
    const cacheStr = cacheRead || cacheWrite ? ` cache=${cacheRead ?? 0}r/${cacheWrite ?? 0}w` : ''
    logger.info(
      `captured ${input.agent}/anthropic ${model || '?'} ` +
        `${input.resStatus} tokens=${usageIn}/${usageOut}${cacheStr} ` +
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
