import type { AgentId } from '../../core/agent.ts'
import { DAEMON_BASE_URL } from '../../core/paths.ts'
import { exactRouteKey, wildcardRouteKey } from '../../core/routes.ts'

/** agentfw's wire URL for an agent — single path segment carrying the
 *  agent type. Body.model carries per-instance dispatch. */
export function agentfwUrlFor(agent: AgentId): string {
  return `${DAEMON_BASE_URL}/wire/${agent}`
}

/** agentfw's wire URL for one agent *instance* — the agent segment carries an
 *  `@<instance>` suffix minted per launch by `agentfw run`. The proxy
 *  splits it back into (agent, instance): the bare agent drives route lookup,
 *  the instance narrows the routing policy and tags the capture. */
export function agentfwUrlForInstance(agent: AgentId, instanceId: string): string {
  return `${DAEMON_BASE_URL}/wire/${agent}@${instanceId}`
}

export function agentfwMcpUrlFor(agent: AgentId, mcpName: string): string {
  return `${DAEMON_BASE_URL}/wire/${agent}/mcp/${encodeURIComponent(mcpName)}`
}

/** Route key for a wrap-style agent — exact match on `(agent, modelId)`. */
export function routeKeyForModel(agent: AgentId, modelId: string): string {
  return exactRouteKey(agent, modelId)
}

/** Route key for an OAuth-style agent — wildcard covers all of upstream's models. */
export function routeKeyForWildcard(agent: AgentId): string {
  return wildcardRouteKey(agent)
}

export function mcpRouteKeyFor(agent: AgentId, mcpName: string): string {
  return `${agent}/mcp/${mcpName}`
}
