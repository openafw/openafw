// Pick the wire protocol codex should speak to afw — matched to the backend
// model the codex route resolves to, so the common case stays translation-free:
//
//   • routed backend is openai-chat      → codex speaks `chat`  (chat↔chat)
//   • routed backend is openai-responses → codex speaks `responses` (resp↔resp)
//   • backend is anthropic / unresolved  → codex speaks `responses` (its
//     richest native form); afw translates downstream.
//
// The choice drives two coupled knobs that MUST agree: the `wire_api` afw sets
// on the inline codex provider (wiring.ts) and the decoder afw registers for
// codex traffic (route-setup.ts) — the decoder is what afw parses the request
// as, so a mismatch would mis-decode every call. Both read this one resolver.
//
// Caveat: the codex route decoder is per-agent (shared across instances), so
// concurrent codex instances pointed at different-protocol backends aren't
// distinguished — the last launch wins the shared decoder. Fine for the normal
// one-setup-per-project case.

import {
  type ModelApi,
  findModel,
  readModelRegistry,
  resolveApi,
} from '../../core/model-registry.ts'
import type { DecoderKind } from '../../core/routes.ts'
import { readRoutingPolicy } from '../../core/routing-policy.ts'

export type CodexWireProtocol = {
  /** codex `model_providers.<id>.wire_api` value. */
  wireApi: 'responses' | 'chat'
  /** afw route decoder — how the proxy parses codex's request. */
  decoder: DecoderKind
}

/** Resolve codex's effective backend wire format. `modelOverride` is the
 *  per-launch `--model` (a routed instance pins one model); without it the
 *  type-level `codex/*` routing default decides. Best-effort: any read failure
 *  or an unresolved/mixed target falls back to Responses (codex's native). */
export async function resolveCodexWireProtocol(modelOverride?: string): Promise<CodexWireProtocol> {
  const api = await resolveBackendApi(modelOverride).catch(() => undefined)
  if (api === 'openai-chat') return { wireApi: 'chat', decoder: 'openai-chat' }
  return { wireApi: 'responses', decoder: 'openai-responses' }
}

async function resolveBackendApi(modelOverride?: string): Promise<ModelApi | undefined> {
  const reg = await readModelRegistry()
  if (modelOverride) {
    const m = findModel(reg, modelOverride)
    if (m) return resolveApi(reg, m)
  }
  // No per-launch model → the type-level codex default. A passthrough/absent
  // target keeps codex on Responses (its OpenAI-native default); a single-model
  // chain follows that model's protocol; a composite/fusion stays Responses.
  const policy = await readRoutingPolicy()
  const target = policy.agents['codex/*']?.target ?? policy.agents.codex?.target
  if (target?.kind === 'chain') {
    const first = target.members[0]
    if (first) {
      const m = findModel(reg, first.modelId, first.providerId)
      if (m) return resolveApi(reg, m)
    }
  }
  return 'openai-responses'
}
