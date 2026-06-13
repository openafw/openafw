import type { DecoderKind } from '../../core/routes.ts'

/**
 * Heuristic decoder selection based on upstream URL. Users can override per
 * route in `~/.agentfw/wire/routes.json`.
 */
export function decoderFor(upstream: string): DecoderKind {
  let host: string
  try {
    host = new URL(upstream).hostname
  } catch {
    return 'passthrough'
  }

  if (host.endsWith('anthropic.com')) return 'anthropic'
  if (host.endsWith('openai.com')) return 'openai-chat'
  if (host === 'openrouter.ai') return 'openai-chat'
  if (host.endsWith('googleapis.com')) return 'gemini'
  if (host.endsWith('amazonaws.com')) return 'bedrock'
  // OpenAI-compatible default — covers vLLM, Ollama, LM Studio, Together,
  // Fireworks, Groq, Cerebras, Mistral, etc.
  return 'openai-chat'
}
