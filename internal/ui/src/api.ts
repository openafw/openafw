import type {
  AgentInstanceDetail,
  AgentInstanceItem,
  MaskingResponse,
  McpServerItem,
  PolicyResponse,
  Registry,
  RiskPage,
  SkillItem,
  RoutingTarget,
  RunDetail,
  RunListItem,
  SearchBackend,
  TaskDetail,
  TaskListItem,
  SubagentDowngrade,
  ToolProvidersResponse,
  WireStatus,
} from './types'

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()) as T
}

async function send(method: string, path: string, body?: unknown): Promise<void> {
  const r = await fetch(path, {
    method,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  })
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `HTTP ${r.status}`)
  }
}

// ── see: runs ──────────────────────────────────────────────────────

export type RunsPage = {
  rows: RunListItem[]
  total: number
  limit: number
  offset: number
}

export async function fetchRuns(opts: { limit?: number; offset?: number } = {}): Promise<RunsPage> {
  const params = new URLSearchParams()
  params.set('limit', String(opts.limit ?? 50))
  params.set('offset', String(opts.offset ?? 0))
  return getJson<RunsPage>(`/api/runs?${params.toString()}`)
}

export async function fetchRun(id: string): Promise<RunDetail> {
  return getJson<RunDetail>(`/api/runs/${encodeURIComponent(id)}`)
}

// ── see: tasks (threads) ───────────────────────────────────────────

export type TasksPage = {
  rows: TaskListItem[]
  total: number
  limit: number
  offset: number
}

export async function fetchTasks(
  opts: { limit?: number; offset?: number } = {},
): Promise<TasksPage> {
  const params = new URLSearchParams()
  params.set('limit', String(opts.limit ?? 50))
  params.set('offset', String(opts.offset ?? 0))
  return getJson<TasksPage>(`/api/threads?${params.toString()}`)
}

export async function fetchTask(id: string): Promise<TaskDetail> {
  return getJson<TaskDetail>(`/api/threads/${encodeURIComponent(id)}`)
}

// ── see: agent instances / mcp / skills ────────────────────────────

export async function fetchInstances(): Promise<AgentInstanceItem[]> {
  return (await getJson<{ instances: AgentInstanceItem[] }>('/api/instances')).instances
}

export async function fetchInstance(key: string): Promise<AgentInstanceDetail> {
  // key already arrives URL-encoded from the list; pass it through as a segment.
  return getJson<AgentInstanceDetail>(`/api/instances/${key}`)
}

export async function fetchMcp(): Promise<McpServerItem[]> {
  return (await getJson<{ servers: McpServerItem[] }>('/api/mcp')).servers
}

export async function fetchSkills(): Promise<SkillItem[]> {
  return (await getJson<{ skills: SkillItem[] }>('/api/skills')).skills
}

// ── wire status ────────────────────────────────────────────────────

export async function fetchWireStatus(): Promise<WireStatus> {
  return getJson<WireStatus>('/api/wire/status')
}

// ── route: providers / models / policy ─────────────────────────────

export async function fetchRegistry(): Promise<Registry> {
  return getJson<Registry>('/api/routing/registry')
}

export async function fetchPolicy(): Promise<PolicyResponse> {
  return getJson<PolicyResponse>('/api/routing/policy')
}

export async function setAgentRoute(routeKey: string, target: RoutingTarget): Promise<void> {
  await send('POST', '/api/routing/agent', { routeKey, target })
}

export async function unsetAgentRoute(routeKey: string): Promise<void> {
  await send('DELETE', `/api/routing/agent?routeKey=${encodeURIComponent(routeKey)}`)
}

export async function setSubagentDowngrade(patch: Partial<SubagentDowngrade>): Promise<void> {
  await send('POST', '/api/routing/subagent', patch)
}

// Pair a text-only routed model with a multimodal companion: the companion
// describes the request's images before the routed model sees it.
export async function setVisionCompanion(
  routeKey: string,
  modelId: string,
  providerId?: string,
): Promise<void> {
  await send('POST', '/api/routing/capability', {
    routeKey,
    capabilityId: 'vision',
    fulfillment: { via: 'companion', modelId, ...(providerId ? { providerId } : {}) },
  })
}

export async function unsetVisionCompanion(routeKey: string): Promise<void> {
  await send(
    'DELETE',
    `/api/routing/capability?routeKey=${encodeURIComponent(routeKey)}&capabilityId=vision`,
  )
}

// providers + models (the registry)

export type ProviderInput = {
  /** Display name the user types. Omit `id` to create (backend derives one);
   *  pass the existing `id` to edit in place. */
  name: string
  /** Present only when editing an existing provider — keeps its internal id
   *  (and `provider:<id>` secret) stable. */
  id?: string
  baseUrl: string
  api: string
  authKind: 'passthrough' | 'bearer' | 'api-key'
  authHeader?: string
  apiKey?: string
}

/** Create (no id) or edit (with id) a provider — the backend upserts by id. */
export async function saveProvider(p: ProviderInput): Promise<void> {
  await send('POST', '/api/routing/provider', p)
}

export async function removeProvider(id: string): Promise<void> {
  await send('DELETE', `/api/routing/provider?id=${encodeURIComponent(id)}`)
}

/** Create or edit a model — keyed by (providerId, id). The id IS the wire model
 *  string sent to the provider; label mirrors it. */
export async function saveModel(m: {
  id: string
  providerId: string
  label?: string
  input: string[]
  contextWindow?: number
}): Promise<void> {
  await send('POST', '/api/routing/model', m)
}

// Discover a provider's models from its own /v1/models endpoint. The backend
// uses the stored `provider:<id>` secret when no apiKey is passed (edit flow).
export type DiscoveredModel = { id: string; label?: string }

export async function fetchModelList(input: {
  baseUrl: string
  api: string
  authKind: 'passthrough' | 'bearer' | 'api-key'
  authHeader?: string
  apiKey?: string
  providerId?: string
}): Promise<DiscoveredModel[]> {
  const r = await fetch('/api/routing/list-models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await r.json().catch(() => ({}))) as { models?: DiscoveredModel[]; error?: string }
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
  return body.models ?? []
}

// combination models (registry `combos`)
export async function saveCombo(combo: {
  id?: string
  label: string
  members: { modelId: string; providerId?: string; switchOn?: { kind: string }[] }[]
  capabilities?: Record<string, unknown>
}): Promise<void> {
  await send('POST', '/api/routing/combo', combo)
}

export async function removeCombo(id: string): Promise<void> {
  await send('DELETE', `/api/routing/combo?id=${encodeURIComponent(id)}`)
}

export async function removeModel(id: string, providerId?: string): Promise<void> {
  const q = providerId
    ? `id=${encodeURIComponent(id)}&providerId=${encodeURIComponent(providerId)}`
    : `id=${encodeURIComponent(id)}`
  await send('DELETE', `/api/routing/model?${q}`)
}

// ── tool providers ─────────────────────────────────────────────────

export async function fetchToolProviders(): Promise<ToolProvidersResponse> {
  return getJson<ToolProvidersResponse>('/api/tool-providers')
}

export async function upsertToolProvider(p: {
  id: string
  label?: string
  kind: 'web_search'
  backend: SearchBackend
  baseUrl?: string
  apiKey?: string
  costPerCall?: number
}): Promise<void> {
  await send('POST', '/api/tool-providers', p)
}

export async function deleteToolProvider(id: string): Promise<void> {
  await send('DELETE', `/api/tool-providers?id=${encodeURIComponent(id)}`)
}

export async function setActiveToolProvider(kind: 'web_search', providerId: string): Promise<void> {
  await send('POST', '/api/tool-providers/active', { kind, providerId })
}

// ── guard: risk findings ───────────────────────────────────────────

export async function fetchRisk(opts: { limit?: number } = {}): Promise<RiskPage> {
  const params = new URLSearchParams()
  params.set('limit', String(opts.limit ?? 100))
  return getJson<RiskPage>(`/api/risk?${params.toString()}`)
}

// ── guard: credential masking ──────────────────────────────────────

export async function fetchMasking(): Promise<MaskingResponse> {
  return getJson<MaskingResponse>('/api/masking')
}

async function postMasking(path: string, body: unknown): Promise<MaskingResponse> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `HTTP ${r.status}`)
  }
  return (await r.json()) as MaskingResponse
}

export function setMaskingRule(
  provider: string,
  id: string,
  enabled: boolean,
): Promise<MaskingResponse> {
  return postMasking('/api/masking/rule', { provider, id, enabled })
}

/** Set a provider's whole enabled set at once (select-all / clear-all). */
export function setMaskingProvider(provider: string, enabled: string[]): Promise<MaskingResponse> {
  return postMasking('/api/masking/provider', { provider, enabled })
}

/** Override the fake a rule swaps in (empty string resets to default). */
export function setMaskingFake(id: string, fake: string): Promise<MaskingResponse> {
  return postMasking('/api/masking/fake', { id, fake })
}

export type CustomMaskingInput = {
  id: string
  label: string
  description?: string
  pattern: string
  flags?: string
  group?: number
  fake: string
}

export function upsertMaskingCustom(rule: CustomMaskingInput): Promise<MaskingResponse> {
  return postMasking('/api/masking/custom', rule)
}

export async function deleteMaskingCustom(id: string): Promise<MaskingResponse> {
  const r = await fetch(`/api/masking/custom?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `HTTP ${r.status}`)
  }
  return (await r.json()) as MaskingResponse
}
