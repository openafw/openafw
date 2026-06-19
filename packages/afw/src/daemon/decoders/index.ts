import type { DecoderKind } from '../../core/routes.ts'
import { anthropicDecoder } from './anthropic/index.ts'
import { openaiChatDecoder } from './openai/index.ts'
import { openaiResponsesDecoder } from './openai/responses.ts'
import { passthroughDecoder } from './passthrough.ts'
import type { Decoder } from './types.ts'

const REGISTRY: Partial<Record<DecoderKind, Decoder>> = {
  anthropic: anthropicDecoder,
  'openai-chat': openaiChatDecoder,
  'openai-responses': openaiResponsesDecoder,
  passthrough: passthroughDecoder,
  // gemini / bedrock / mcp — later
}

export function decoderFor(kind: DecoderKind): Decoder | undefined {
  return REGISTRY[kind] ?? passthroughDecoder
}
