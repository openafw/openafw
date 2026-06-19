// Known source models per agent type — the model IDs the agent
// reliably advertises in its `body.model` field. Used in two places:
//
//   • daemon/routing/seed.ts pre-seeds these into the model registry
//     under each wildcard route's seeded provider, so the Routing UI
//     can render per-source-model rows before any traffic flows.
//   • daemon/proxy/models-list.ts uses the claude-desktop set as the
//     default response to Claude Desktop's launch-time /v1/models call
//     when no routing policy has been configured yet.
//
// Only agents whose routes are wildcard-style (OAuth) need a list here
// — wrap-style agents (openclaw, hermes) declare their own model id at
// wire time, so the seed step harvests them from routes.json directly.
//
// The list intentionally captures variants the user might want to route
// differently — e.g. the 1M-context Opus is a distinct id from regular
// Opus so each can take its own routing target. Names match what the
// agents actually send today; this is configuration, not a contract —
// the system handles unknown ids fine, the list just primes the UI.

import type { KnownAgentId } from './agent.ts'

export const KNOWN_SOURCE_MODELS = {
  'claude-code': [
    'claude-haiku-4-5',
    'claude-sonnet-4-6',
    'claude-opus-4-8',
    'claude-opus-4-8[1m]',
    'claude-fable-5',
  ],
  'claude-desktop': [
    'claude-haiku-4-5',
    'claude-sonnet-4-6',
    'claude-opus-4-8',
    'claude-opus-4-8[1m]',
    'claude-fable-5',
  ],
} as const satisfies Partial<Record<KnownAgentId, readonly string[]>>

export type AgentWithKnownSourceModels = keyof typeof KNOWN_SOURCE_MODELS

export function knownSourceModelsFor(agent: string): readonly string[] | undefined {
  return (KNOWN_SOURCE_MODELS as Record<string, readonly string[] | undefined>)[agent]
}
