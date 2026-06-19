// Shapes the dashboard reads off the daemon API. Kept deliberately narrow —
// only the fields the views render — so they stay forward-compatible with
// extra fields the daemon may add.

export type RiskTag = {
  tag: string
  severity: 'info' | 'warn' | 'high'
  detail?: unknown
}

// The error outcome of a run/task once chain failover is accounted for.
//   failed    — the terminal model_call errored; the error reached the client
//   recovered — an attempt errored but a failover attempt succeeded
//   ok        — no errored model_call
export type RunOutcome = 'ok' | 'recovered' | 'failed'

export type RunListItem = {
  id: string
  threadId: string
  agent: string
  status: string
  startedAt: number
  endedAt: number | null
  durMs: number | null
  costUsd: number
  tokensIn: number | null
  tokensOut: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  actionCount: number
  /** The model this run actually routed to (costliest model_call). */
  model: string | null
  /** Error outcome once chain failover is accounted for. */
  outcome: RunOutcome
}

export type ActionSummary = {
  id: string
  kind: string
  sourceAgent: string
  ts: number
  durMs: number
  costUsd: number
  tokensIn: number | null
  tokensOut: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  riskTags: RiskTag[]
  // biome-ignore lint/suspicious/noExplicitAny: decoded packet payload is open-shaped
  payload: any
}

export type RunDetail = {
  run: RunListItem
  actions: ActionSummary[]
}

// ── tasks (= threads: one correlated conversation/goal) ────────────

export type TaskListItem = {
  id: string
  agent: string
  title: string | null
  startedAt: number
  endedAt: number | null
  durMs: number | null
  runCount: number
  actionCount: number
  /** The task's dominant served model (costliest model_call across its runs). */
  model: string | null
  tokensIn: number | null
  tokensOut: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  outcome: RunOutcome
}

export type TaskDetail = {
  thread: TaskListItem
  runs: RunListItem[]
}

// ── See: agent instances / MCP / skills ────────────────────────────

// One running agent instance (agent type + instanceId). instanceId null = the
// unknown/single bucket. `key` is the opaque URL key for the detail route.
export type AgentInstanceItem = {
  agent: string
  instanceId: string | null
  key: string
  taskCount: number
  actionCount: number
  costUsd: number
  firstSeen: number
  lastActive: number
  mcpCount: number
  skillCount: number
  toolCount: number
}

export type NameCount = { name: string; count: number; category?: string }

export type AgentInstanceDetail = {
  agent: string
  instanceId: string | null
  key: string
  mcpServers: NameCount[]
  skills: NameCount[]
  tools: NameCount[]
  tasks: TaskListItem[]
}

export type McpServerItem = {
  server: string
  callCount: number
  errorCount: number
  methodCount: number
  instanceCount: number
  taskCount: number
  lastActive: number
}

export type SkillItem = {
  skill: string
  useCount: number
  instanceCount: number
  taskCount: number
  lastActive: number
}

// ── wire status ────────────────────────────────────────────────────

export type WireEntry = {
  path: string
  agent: string
  drifted: boolean
  reason?: string
  lastChecked: number
}

export type WireStatus = {
  watching: number
  driftedCount: number
  /** Agents the proxy will accept traffic for — derived from routes.json, not
   *  from rewritten config files. This is the real "wired" signal in the
   *  launcher model (afw never edits an agent's config). */
  wiredAgents: string[]
  entries: WireEntry[]
}

// ── routing config ─────────────────────────────────────────────────

export type ProviderEntry = {
  id: string
  /** Human display name. The `id` stays internal/stable (referenced by
   *  routing.json and the `provider:<id>` secret); this is what the user edits. */
  label?: string
  baseUrl: string
  api: string
  authKind?: string
  auth?: { kind: string; header?: string }
  origin?: string
}

export type ModelEntry = {
  id: string
  providerId: string
  /** For models the id IS the wire string sent to the provider, so label
   *  usually mirrors it. */
  label?: string
  input?: string[]
  /** Total context window (input + output) in tokens. Drives the output-budget
   *  clamp so a request the agent sized for a larger window fits this model. */
  contextWindow?: number
  origin?: string
}

export type Modality = 'text' | 'image' | 'pdf' | 'audio' | 'video'

export type ModelApi = 'anthropic-messages' | 'openai-chat' | 'openai-responses'

// A rule that advances a chain member to the next on failure. The UI only
// authors `error` failover; budget/token rules stay CLI/advanced but are
// preserved when present.
// The window a token/USD cap is measured over: a calendar day/month, or a
// rolling N-hour window (the subscription's 5-hour quota is `{rollingHours:5}`).
export type SwitchPeriod = 'day' | 'month' | { rollingHours: number }

export type SwitchRule =
  | { kind: 'error' }
  | { kind: 'budget'; usdLimit: number; period: SwitchPeriod }
  | { kind: 'tokens'; tokenLimit: number; period: SwitchPeriod }
  // For subscription (OAuth) upstreams whose absolute token budget is invisible:
  // switch when the provider's own reported quota usage crosses this percentage.
  | { kind: 'quota-pct'; usedPct: number }

export type ChainMember = { modelId: string; providerId?: string; switchOn?: SwitchRule[] }

export type RoutingTarget =
  | { kind: 'passthrough' }
  | { kind: 'chain'; members: ChainMember[] }
  | { kind: 'composite'; comboId: string }

export type CapabilityId = 'vision' | 'web_search'

export type CapabilityFulfillment =
  | { via: 'companion'; modelId: string; providerId?: string }
  | { via: 'local'; providerId?: string }

// Model Fusion — afw's local take on OpenRouter Fusion. A `panel` of models
// answers the prompt in parallel, a `judge` distils their answers into a
// structured analysis, and a `synthesizer` writes the final answer grounded in
// it. Routes target a fusion model by id. Each panel member can carry a vision
// bridge (pre-describe images for a text-only member) and per-member web_search.
export type FusionEndpoint = { modelId: string; providerId?: string }

// A fusion panel member: the primary model, its per-member failover rules
// (token/USD caps + error), and the backup model they switch to.
export type FusionMember = {
  modelId: string
  providerId?: string
  switchOn?: SwitchRule[]
  fallback?: FusionEndpoint
}

export type CombinationModel = {
  id: string
  label: string
  panel: FusionMember[]
  // One multimodal companion for the whole fusion, plus a panel-wide web_search
  // pin. Configured at the fusion level, not per member.
  vision?: FusionEndpoint
  webSearch?: { providerId?: string }
  judge?: FusionEndpoint
  synthesizer?: FusionEndpoint
  // A single cheap model for subagent / cron tasks routed to this fusion — they
  // skip the panel/judge/synthesizer and go straight to it.
  cheapModel?: FusionEndpoint
  origin?: string
}

export type AgentRouting = {
  target: RoutingTarget
  capabilities?: Partial<Record<CapabilityId, CapabilityFulfillment>>
}

export type RoutingPolicy = {
  agents: Record<string, AgentRouting>
}

export type RoutingRoute = {
  routeKey: string
  agent: string
  provider: string
  decoder: string
}

export type Registry = {
  providers: ProviderEntry[]
  models: ModelEntry[]
  combos: CombinationModel[]
  secretRefs?: string[]
}

export type SubagentDowngrade = {
  enabled: boolean
  modelId: string
  providerId?: string
  minMaxTokens: number
}

// afw API keys — auth tokens a generic OpenAI/Anthropic-compatible agent
// presents to the /v1 endpoint. The request's model name (a tier) selects the
// real model, not the key. See core/access-keys.ts.
export type AccessKeyItem = {
  id: string
  label: string
  token: string
  agent: string
  instance?: string
  createdAt: number
  lastUsedAt?: number
}

// The three fixed model names, named after Starbucks cup sizes, low → high.
export type KeyConnection = {
  baseUrl: string
  anthropicBaseUrl: string
  port: number
  modelNames: Array<{ tier: string; name: string; rank: number }>
}

export type KeysResponse = { keys: AccessKeyItem[]; connection: KeyConnection }

// A model tier (Tall/Grande/Venti) and the routing target the user mapped it to.
export type TierRow = { tier: string; display: string; rank: number; target?: RoutingTarget }

export type TiersResponse = { tiers: TierRow[]; connection: KeyConnection }

export type PolicyResponse = {
  policy: RoutingPolicy
  routes: RoutingRoute[]
  subagentDowngrade?: SubagentDowngrade
}

// ── tool providers (web_search backends, …) ────────────────────────

export type SearchBackend = 'duckduckgo' | 'brave' | 'searxng' | 'tavily' | 'baidu'

export type ToolProvider = {
  id: string
  label: string
  kind: 'web_search'
  backend: SearchBackend
  baseUrl?: string
  authRef?: string
  costPerCall?: number
  origin?: string
}

export type ToolProvidersResponse = {
  providers: ToolProvider[]
  active: Partial<Record<'web_search', string>>
  secretRefs?: string[]
}

// ── guard (risk findings) ──────────────────────────────────────────

export type RiskFinding = {
  actionId: string
  runId: string
  agent: string
  kind: string
  ts: number
  tag: string
  severity: 'info' | 'warn' | 'high'
  detail?: unknown
}

export type RiskPage = {
  findings: RiskFinding[]
  total: number
}

// ── guard (credential masking) ─────────────────────────────────────

// One credential type the firewall can de-identify on the wire. `fake` is the
// public placeholder swapped in for the real value — no secret material.
// `custom` rules are user-defined (editable pattern, removable).
export type MaskingRule = {
  id: string
  label: string
  description: string
  fake: string
  custom: boolean
  pattern: string
  flags?: string
  group?: number
}

// A provider the masking is configured per: `id` is the wire key (registry
// provider id), `enabled` the rule ids turned on for it. Opt-in — empty = off.
export type MaskingProvider = {
  id: string
  label: string
  baseUrl?: string
  enabled: string[]
}

export type MaskingResponse = {
  rules: MaskingRule[]
  providers: MaskingProvider[]
}
