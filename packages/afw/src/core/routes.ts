import type { Modality, ModelCost } from './model-registry.ts'

export const ROUTES_VERSION = 2 as const

export type DecoderKind =
  | 'anthropic'
  | 'openai-chat'
  | 'openai-responses'
  | 'gemini'
  | 'bedrock'
  | 'mcp'
  | 'passthrough'

/** A model declared in an agent's own config, harvested at wire time.
 *  Carried on PlannedEndpoint so the model registry can pick up the
 *  metadata (cost / context window / input modalities) at seed time. */
export type HarvestedModel = {
  id: string
  label?: string
  input?: Modality[]
  contextWindow?: number
  maxTokens?: number
  cost?: ModelCost
}

/** The shape of the credential afw captured for a route at wire time.
 *  A static key's value is stored in secrets.json under
 *  `provider:<routeKey>`; an `agent-oauth` route carries no stored value —
 *  afw reads and refreshes the token from the agent's own credential
 *  store. */
export type RouteAuth =
  | { kind: 'api-key'; header: string }
  | { kind: 'bearer' }
  | { kind: 'agent-oauth'; agent: 'claude-code' | 'codex' }

export type RouteEntry = {
  upstream: string
  decoder: DecoderKind
  auth?: RouteAuth
  /** When set, the proxy rewrites `body.model` to this id before
   *  forwarding upstream. Used by wrap-style routes where modelId is a
   *  afw-managed virtual handle and sourceModelId is the real
   *  upstream model. Absent for wildcard / OAuth routes — those
   *  forward `body.model` verbatim. */
  sourceModelId?: string
  /** Per-model metadata harvested at wire time, used by
   *  `seedFromRoutes` to populate the model registry. Single — each
   *  exact-match route is one model. Wildcard routes leave this absent;
   *  their models grow from observed traffic. */
  harvest?: HarvestedModel
  tombstoned?: boolean
}

export type Routes = {
  version: typeof ROUTES_VERSION
  /** Route keys come in two shapes:
   *   • `"<agentType>/<modelId>"` — exact match (wrap-style: openclaw, hermes).
   *   • `"<agentType>/*"` — wildcard (OAuth-style: claude-code, codex).
   *  Lookup tries exact first, then wildcard. MCP wraps use
   *  `"<agentType>/mcp/<name>"`. */
  routes: Record<string, RouteEntry>
}

export const WILDCARD_MODEL_ID = '*' as const

export function exactRouteKey(agent: string, modelId: string): string {
  return `${agent}/${modelId}`
}

export function wildcardRouteKey(agent: string): string {
  return `${agent}/${WILDCARD_MODEL_ID}`
}

export function findRoute(
  routes: Record<string, RouteEntry>,
  agent: string,
  modelId: string,
): RouteEntry | undefined {
  return routes[exactRouteKey(agent, modelId)] ?? routes[wildcardRouteKey(agent)]
}
