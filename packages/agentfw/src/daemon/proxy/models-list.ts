// Synthesize an Anthropic-shaped /v1/models response for Claude Desktop.
//
// Claude Desktop's third-party-inference panel fetches /v1/models at
// launch to populate its model picker. The picker only accepts model
// IDs that start with `claude-`, and Claude Desktop only speaks the
// Anthropic protocol — so the list agentfw returns must be `claude-*`
// IDs that the user's routing policy can route under
// `claude-desktop/<modelId>` (or the wildcard `claude-desktop/*`).
//
// Source of truth: the model registry's entries under provider
// `claude-desktop/*`. seedFromRoutes pre-seeds KNOWN_SOURCE_MODELS
// there at wire time, and noteObservedModel appends any new ids seen
// in real traffic — so the picker stays in lockstep with the
// per-source-model rows on the Routing page. Per-source-model routing
// entries from routing.json are folded in too (a user override implies
// the id should be listed, even if it hasn't been observed yet). A
// small built-in default keeps the picker non-empty on first run when
// neither registry nor policy has anything to offer.

import { KNOWN_SOURCE_MODELS } from '../../core/known-source-models.ts'
import { readModelRegistry } from '../../core/model-registry.ts'
import { readRoutingPolicy } from '../../core/routing-policy.ts'

const AGENT_PREFIX = 'claude-desktop/'
const WILDCARD_ROUTE_KEY = 'claude-desktop/*'
const CLAUDE_PREFIX = 'claude-'

// Shared with seed.ts so the picker the user sees and the rows the
// Routing UI offers stay in lockstep.
const DEFAULT_MODEL_IDS = KNOWN_SOURCE_MODELS['claude-desktop']

type AnthropicModelEntry = {
  type: 'model'
  id: string
  display_name: string
  created_at: string
}

export async function synthesizeClaudeDesktopModels(): Promise<{
  data: AnthropicModelEntry[]
  has_more: false
  first_id: string | null
  last_id: string | null
}> {
  const ids = new Set<string>()

  try {
    const reg = await readModelRegistry()
    for (const m of reg.models) {
      if (m.providerId !== WILDCARD_ROUTE_KEY) continue
      if (m.id.startsWith(CLAUDE_PREFIX)) ids.add(m.id)
    }
  } catch {
    // why: a malformed registry shouldn't empty the picker.
  }

  try {
    const policy = await readRoutingPolicy()
    for (const key of Object.keys(policy.agents)) {
      if (!key.startsWith(AGENT_PREFIX)) continue
      const modelId = key.slice(AGENT_PREFIX.length)
      if (modelId === '' || modelId === '*') continue
      if (modelId.startsWith(CLAUDE_PREFIX)) ids.add(modelId)
    }
  } catch {
    // why: routing.json is user-editable — a malformed file shouldn't
    // empty Claude Desktop's model picker. Fall through to defaults.
  }

  if (ids.size === 0) {
    for (const id of DEFAULT_MODEL_IDS) ids.add(id)
  }

  const sorted = [...ids].sort()
  const data: AnthropicModelEntry[] = sorted.map((id) => ({
    type: 'model',
    id,
    display_name: id,
    created_at: '2025-01-01T00:00:00Z',
  }))

  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  }
}

export function isClaudeDesktopModelsRequest(agent: string, restPath: string): boolean {
  if (agent !== 'claude-desktop') return false
  const p = restPath.replace(/\/+$/, '')
  return p === '/v1/models' || p === '/models'
}
