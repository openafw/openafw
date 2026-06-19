// Protocol translation entry point. Every request/response crosses a neutral
// IR (Anthropic-shaped): 3 parsers + 3 serializers, not 6 pairwise paths.
// When source and destination APIs match, translation is identity — the
// orchestrator's fast path never pays the round-trip.

import type { ModelApi } from '../../core/model-registry.ts'
import * as fromAnthropic from './from-anthropic.ts'
import * as fromOpenAIChat from './from-openai-chat.ts'
import * as fromOpenAIResponses from './from-openai-responses.ts'
import type { IRRequest, IRResponse } from './ir.ts'
import * as toAnthropic from './to-anthropic.ts'
import * as toOpenAIChat from './to-openai-chat.ts'
import * as toOpenAIResponses from './to-openai-responses.ts'

export type { IRBlock, IRMessage, IRRequest, IRResponse, IRTool } from './ir.ts'
export { parseStreamToIR, translateSseStream } from './stream.ts'

type Parser = {
  requestToIR: (body: unknown) => IRRequest
  responseToIR: (json: unknown) => IRResponse
}
type Serializer = {
  requestFromIR: (ir: IRRequest) => unknown
  responseFromIR: (ir: IRResponse) => unknown
}

const PARSERS: Record<ModelApi, Parser> = {
  'anthropic-messages': fromAnthropic,
  'openai-chat': fromOpenAIChat,
  'openai-responses': fromOpenAIResponses,
}

const SERIALIZERS: Record<ModelApi, Serializer> = {
  'anthropic-messages': toAnthropic,
  'openai-chat': toOpenAIChat,
  'openai-responses': toOpenAIResponses,
}

export function parseRequestToIR(api: ModelApi, body: unknown): IRRequest {
  return PARSERS[api].requestToIR(body)
}

export function serializeRequestFromIR(api: ModelApi, ir: IRRequest): unknown {
  return SERIALIZERS[api].requestFromIR(ir)
}

export function parseResponseToIR(api: ModelApi, json: unknown): IRResponse {
  return PARSERS[api].responseToIR(json)
}

export function serializeResponseFromIR(api: ModelApi, ir: IRResponse): unknown {
  return SERIALIZERS[api].responseFromIR(ir)
}

/** Translate a request body from one wire API to another. Identity when
 *  `from === to`. The caller still overrides the `model` field afterwards. */
export function translateRequest(from: ModelApi, to: ModelApi, body: unknown): unknown {
  if (from === to) return body
  return serializeRequestFromIR(to, parseRequestToIR(from, body))
}

/** Translate a non-streaming response JSON from one wire API to another.
 *  Identity when `from === to`. */
export function translateResponseJson(from: ModelApi, to: ModelApi, json: unknown): unknown {
  if (from === to) return json
  return serializeResponseFromIR(to, parseResponseToIR(from, json))
}
