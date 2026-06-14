// The routing policy — ~/.agentfw/routing.json. Per-agent decisions about
// which model(s) a wired agent's traffic is actually sent to: a straight
// passthrough, or an ordered failover chain (one or more members; the last
// is the unconditional fallback). Keyed by routeKey "<agent>/<provider>".

import { readFile } from 'node:fs/promises'
import { atomicWrite, fileExists } from './atomic-file.ts'
import { paths } from './paths.ts'

export const ROUTING_POLICY_VERSION = 4 as const

/** A condition that advances a chain to its next member. The last member's
 *  rules are ignored — there is nothing to switch to. */
export type SwitchRule =
  | { kind: 'error' }
  | { kind: 'budget'; usdLimit: number; period: 'day' | 'month' }
  | { kind: 'tokens'; tokenLimit: number; period: 'day' | 'month' }

export type ChainMember = {
  modelId: string
  /** Disambiguates when the same model id exists under multiple providers.
   *  Optional for back-compat: an entry without it resolves first-match. */
  providerId?: string
  /** Empty/absent on the last member — it is the final fallback. */
  switchOn?: SwitchRule[]
}

export type RoutingTarget =
  | { kind: 'passthrough' }
  | { kind: 'chain'; members: ChainMember[] }
  /** Reference to a reusable combination model (model-registry `combos`) — a
   *  fusion panel + judge + synthesizer. The combo is the single source of
   *  truth for its panel; a composite-target route's own `capabilities` are
   *  ignored at resolve time. */
  | { kind: 'composite'; comboId: string }

/** A capability the routed model can't natively provide (vision input,
 *  web search, …) — and how agentfw fills the gap.
 *
 *  - `companion`: a side-call to another model that does support the
 *    capability — for vision, the image pre-describe pass.
 *  - `local`: agentfw fills the capability itself — for web_search,
 *    that's the agentfw-tools MCP. No model-side companion needed. */
export type CapabilityFulfillment =
  | { via: 'companion'; modelId: string; providerId?: string }
  | {
      via: 'local'
      /** Tool-provider id from ~/.agentfw/tool-providers.json. When set,
       *  this route's calls use that provider instead of the global
       *  `active[<kind>]`. Lets one agent route through Baidu while
       *  another stays on DuckDuckGo without juggling the global
       *  setting. Absent → fall back to the global active. */
      providerId?: string
    }

/** The set of capability ids agentfw understands today. Open string so
 *  policy files written by a newer client are forwarded-compatible,
 *  but built-in ones get checked-in semantics. */
export type CapabilityId = 'vision' | 'web_search'

export type AgentRouting = {
  target: RoutingTarget
  /** Per-capability override for this route. */
  capabilities?: Partial<Record<CapabilityId, CapabilityFulfillment>>
}

/** The subagent cost-saver. Claude Code's dynamic-workflow subagent calls —
 *  identified on the wire by the ABSENCE of the orchestrator-only `Agent` tool
 *  (the planner always carries it; subagents never do, since they can't nest)
 *  — are rerouted to a cheaper model, while the planner stays on its requested
 *  model. Global and default-on for claude-code. See resolveSubagentDowngrade. */
export type SubagentDowngrade = {
  enabled: boolean
  /** Target model for subagent calls, e.g. `claude-sonnet-4-6`. */
  modelId: string
  /** Disambiguates the target when the id exists under multiple providers. */
  providerId?: string
  /** Floor that skips tiny utility calls (security-monitor `max_tokens:64`,
   *  title-gen, …) so only real subagent work is rerouted. */
  minMaxTokens: number
}

/** Default-on. The user disables or retargets it from the dashboard, which
 *  writes a (partial) `subagentDowngrade` override onto the policy. */
export const DEFAULT_SUBAGENT_DOWNGRADE: SubagentDowngrade = {
  enabled: true,
  modelId: 'claude-sonnet-4-6',
  minMaxTokens: 8000,
}

export type RoutingPolicy = {
  version: typeof ROUTING_POLICY_VERSION
  agents: Record<string, AgentRouting>
  /** Global subagent cost-saver override. Absent → DEFAULT_SUBAGENT_DOWNGRADE. */
  subagentDowngrade?: Partial<SubagentDowngrade>
  streamTranslation?: boolean
}

export const EMPTY_POLICY: RoutingPolicy = {
  version: ROUTING_POLICY_VERSION,
  agents: {},
}

/** Merge the policy's (partial) override onto the built-in default so callers
 *  always get a complete config. */
export function effectiveSubagentDowngrade(policy: RoutingPolicy): SubagentDowngrade {
  const o = policy.subagentDowngrade
  if (!o) return DEFAULT_SUBAGENT_DOWNGRADE
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_SUBAGENT_DOWNGRADE.enabled,
    modelId:
      typeof o.modelId === 'string' && o.modelId !== ''
        ? o.modelId
        : DEFAULT_SUBAGENT_DOWNGRADE.modelId,
    ...(typeof o.providerId === 'string' && o.providerId !== ''
      ? { providerId: o.providerId }
      : {}),
    minMaxTokens:
      typeof o.minMaxTokens === 'number' && o.minMaxTokens >= 0
        ? o.minMaxTokens
        : DEFAULT_SUBAGENT_DOWNGRADE.minMaxTokens,
  }
}

export const PASSTHROUGH: AgentRouting = { target: { kind: 'passthrough' } }

// ── helpers ───────────────────────────────────────────────────────

/** Build a routing-policy key. The agent component carries an optional
 *  per-instance suffix (`<agent>@<instance>`) minted by `agentfw run`;
 *  the model component is the request's `body.model` (or `*`). Mirrors the
 *  shape the proxy builds on the hot path so the `run` command and the
 *  dashboard write keys `routingFor` will actually match. */
export function policyKeyFor(agent: string, model: string, instanceId?: string): string {
  const a = instanceId ? `${agent}@${instanceId}` : agent
  return `${a}/${model || '*'}`
}

/** The routing for a policyKey, most-specific first. The key is
 *  `<agent>[@<instance>]/<model|*>`; lookup walks:
 *    1. `<agent>@<instance>/<model>`   exact instance + model
 *    2. `<agent>@<instance>/*`         this instance, any model
 *    3. `<agent>/<model>`              type-wide model override
 *    4. `<agent>/*`                    type-wide default
 *  then PASSTHROUGH. Steps 1–2 only exist when the key carries an instance;
 *  for a plain `<agent>/<model>` key this collapses to the original
 *  exact-then-wildcard behaviour. An entry that *exists* (any kind,
 *  including an explicit passthrough) is honored as-is — only literal
 *  absence advances to the next candidate. This is what makes a
 *  monitor-only instance (`<agent>@<inst>/*` = passthrough) shadow a
 *  type-wide model override. */
export function routingFor(policy: RoutingPolicy, policyKey: string): AgentRouting {
  const slash = policyKey.indexOf('/')
  if (slash <= 0) return policy.agents[policyKey] ?? PASSTHROUGH

  const agentPart = policyKey.slice(0, slash) // `<agent>` or `<agent>@<instance>`
  const model = policyKey.slice(slash + 1) // `<model>` or `*`
  const at = agentPart.indexOf('@')
  const bareAgent = at >= 0 ? agentPart.slice(0, at) : agentPart

  const candidates = [`${agentPart}/${model}`]
  if (model !== '*') candidates.push(`${agentPart}/*`)
  if (at >= 0) {
    candidates.push(`${bareAgent}/${model}`)
    if (model !== '*') candidates.push(`${bareAgent}/*`)
  }
  for (const key of candidates) {
    const hit = policy.agents[key]
    if (hit) return hit
  }
  return PASSTHROUGH
}

/** Whether live SSE translation is enabled — default true. Setting
 *  `streamTranslation:false` forces every routed swap to buffer + synthesize. */
export function streamTranslationEnabled(policy: RoutingPolicy): boolean {
  return policy.streamTranslation !== false
}

// ── parse / normalize ─────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function normalizeSwitchRule(raw: unknown): SwitchRule | undefined {
  if (!isObj(raw)) return undefined
  if (raw.kind === 'error') return { kind: 'error' }
  if (
    raw.kind === 'budget' &&
    typeof raw.usdLimit === 'number' &&
    raw.usdLimit >= 0 &&
    (raw.period === 'day' || raw.period === 'month')
  ) {
    return { kind: 'budget', usdLimit: raw.usdLimit, period: raw.period }
  }
  if (
    raw.kind === 'tokens' &&
    typeof raw.tokenLimit === 'number' &&
    raw.tokenLimit >= 0 &&
    (raw.period === 'day' || raw.period === 'month')
  ) {
    return { kind: 'tokens', tokenLimit: raw.tokenLimit, period: raw.period }
  }
  return undefined
}

export function normalizeMember(raw: unknown): ChainMember | undefined {
  if (!isObj(raw)) return undefined
  if (typeof raw.modelId !== 'string' || raw.modelId === '') return undefined
  const switchOn = Array.isArray(raw.switchOn)
    ? raw.switchOn.map(normalizeSwitchRule).filter((r): r is SwitchRule => r != null)
    : []
  return {
    modelId: raw.modelId,
    ...(typeof raw.providerId === 'string' && raw.providerId !== ''
      ? { providerId: raw.providerId }
      : {}),
    ...(switchOn.length > 0 ? { switchOn } : {}),
  }
}

function normalizeTarget(raw: unknown): RoutingTarget {
  if (!isObj(raw)) return { kind: 'passthrough' }
  if (raw.kind === 'composite' && typeof raw.comboId === 'string' && raw.comboId !== '') {
    return { kind: 'composite', comboId: raw.comboId }
  }
  if (raw.kind === 'chain' && Array.isArray(raw.members)) {
    const members = raw.members.map(normalizeMember).filter((m): m is ChainMember => m != null)
    if (members.length === 0) return { kind: 'passthrough' }
    return { kind: 'chain', members }
  }
  return { kind: 'passthrough' }
}

const KNOWN_CAPABILITY_IDS: CapabilityId[] = ['vision', 'web_search']

function normalizeFulfillment(raw: unknown): CapabilityFulfillment | undefined {
  if (!isObj(raw)) return undefined
  if (raw.via === 'companion') {
    if (typeof raw.modelId !== 'string' || raw.modelId === '') return undefined
    return {
      via: 'companion',
      modelId: raw.modelId,
      ...(typeof raw.providerId === 'string' && raw.providerId !== ''
        ? { providerId: raw.providerId }
        : {}),
    }
  }
  if (raw.via === 'local') {
    return {
      via: 'local',
      ...(typeof raw.providerId === 'string' && raw.providerId !== ''
        ? { providerId: raw.providerId }
        : {}),
    }
  }
  return undefined
}

export function normalizeCapabilities(
  raw: unknown,
): Partial<Record<CapabilityId, CapabilityFulfillment>> | undefined {
  if (!isObj(raw)) return undefined
  const out: Partial<Record<CapabilityId, CapabilityFulfillment>> = {}
  for (const id of KNOWN_CAPABILITY_IDS) {
    const f = normalizeFulfillment((raw as Record<string, unknown>)[id])
    if (f) out[id] = f
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeSubagentDowngrade(raw: unknown): Partial<SubagentDowngrade> | undefined {
  if (!isObj(raw)) return undefined
  const out: Partial<SubagentDowngrade> = {}
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  if (typeof raw.modelId === 'string' && raw.modelId !== '') out.modelId = raw.modelId
  if (typeof raw.providerId === 'string' && raw.providerId !== '') out.providerId = raw.providerId
  if (typeof raw.minMaxTokens === 'number' && raw.minMaxTokens >= 0) {
    out.minMaxTokens = raw.minMaxTokens
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeRouting(raw: unknown): AgentRouting | undefined {
  if (!isObj(raw)) return undefined
  const capabilities = normalizeCapabilities(raw.capabilities)
  return {
    target: normalizeTarget(raw.target),
    ...(capabilities ? { capabilities } : {}),
  }
}

/** v1 → v2: combos→strategies, per-agent visionCompanionModelId folded
 *  into the strategy's toolModels. We collapse v1 directly into v3 by
 *  running v2 as an intermediate shape and then v2→v3 below. */
function migrateV1ToV2(raw: Record<string, unknown>): Record<string, unknown> {
  const strategies: unknown[] = Array.isArray(raw.combos) ? [...raw.combos] : []
  const usedIds = new Set<string>()
  for (const s of strategies) {
    if (isObj(s) && typeof s.id === 'string') usedIds.add(s.id)
  }
  const uniqueId = (base: string): string => {
    let id = base
    let n = 2
    while (usedIds.has(id)) id = `${base}-${n++}`
    usedIds.add(id)
    return id
  }

  const agents: Record<string, unknown> = {}
  if (isObj(raw.agents)) {
    for (const [key, value] of Object.entries(raw.agents)) {
      if (!isObj(value)) continue
      const target = value.target
      const companion =
        typeof value.visionCompanionModelId === 'string' && value.visionCompanionModelId !== ''
          ? value.visionCompanionModelId
          : undefined
      if (isObj(target) && target.kind === 'combo' && typeof target.comboId === 'string') {
        agents[key] = { target: { kind: 'strategy', strategyId: target.comboId } }
      } else if (
        isObj(target) &&
        target.kind === 'model' &&
        typeof target.modelId === 'string' &&
        target.modelId !== '' &&
        companion
      ) {
        const stratId = uniqueId(`${key.replace(/\//g, '-')}-vision`)
        strategies.push({
          id: stratId,
          label: `${key} (vision)`,
          members: [{ modelId: target.modelId }],
          toolModels: [{ kind: 'vision', modelId: companion }],
        })
        agents[key] = { target: { kind: 'strategy', strategyId: stratId } }
      } else if (isObj(target) && target.kind === 'model' && typeof target.modelId === 'string') {
        agents[key] = { target: { kind: 'model', modelId: target.modelId } }
      } else {
        agents[key] = { target: { kind: 'passthrough' } }
      }
    }
  }

  return {
    version: 2,
    strategies,
    agents,
    ...(typeof raw.streamTranslation === 'boolean'
      ? { streamTranslation: raw.streamTranslation }
      : {}),
  }
}

/** v2 → v3: drop the top-level `strategies` array; inline strategy refs as
 *  chain members; single-model targets become 1-member chains. Legacy
 *  strategy.toolModels (vision companions) are converted to per-route
 *  capabilities.vision so the failover-loop behaviour survives. */
function migrateV2ToV3(raw: Record<string, unknown>): Record<string, unknown> {
  const strategiesById = new Map<string, { members: unknown[]; visionModelId?: string }>()
  if (Array.isArray(raw.strategies)) {
    for (const s of raw.strategies) {
      if (!isObj(s) || typeof s.id !== 'string') continue
      const members = Array.isArray(s.members) ? s.members : []
      let visionModelId: string | undefined
      if (Array.isArray(s.toolModels)) {
        for (const tm of s.toolModels) {
          if (
            isObj(tm) &&
            tm.kind === 'vision' &&
            typeof tm.modelId === 'string' &&
            tm.modelId !== ''
          ) {
            visionModelId = tm.modelId
            break
          }
        }
      }
      strategiesById.set(s.id, {
        members,
        ...(visionModelId ? { visionModelId } : {}),
      })
    }
  }

  const agents: Record<string, unknown> = {}
  if (isObj(raw.agents)) {
    for (const [key, value] of Object.entries(raw.agents)) {
      if (!isObj(value)) continue
      const target = value.target
      const existingCaps = isObj(value.capabilities) ? value.capabilities : {}

      if (isObj(target) && target.kind === 'passthrough') {
        agents[key] = {
          target: { kind: 'passthrough' },
          ...(Object.keys(existingCaps).length > 0 ? { capabilities: existingCaps } : {}),
        }
        continue
      }

      if (
        isObj(target) &&
        target.kind === 'model' &&
        typeof target.modelId === 'string' &&
        target.modelId !== ''
      ) {
        const member: Record<string, unknown> = { modelId: target.modelId }
        if (typeof target.providerId === 'string' && target.providerId !== '') {
          member.providerId = target.providerId
        }
        agents[key] = {
          target: { kind: 'chain', members: [member] },
          ...(Object.keys(existingCaps).length > 0 ? { capabilities: existingCaps } : {}),
        }
        continue
      }

      if (isObj(target) && target.kind === 'strategy' && typeof target.strategyId === 'string') {
        const strat = strategiesById.get(target.strategyId)
        if (!strat || strat.members.length === 0) {
          // Dangling reference — fall back to passthrough.
          agents[key] = { target: { kind: 'passthrough' } }
          continue
        }
        const caps: Record<string, unknown> = { ...existingCaps }
        // Lift the strategy's vision tool-model into a per-route
        // capability unless the route already pins one of its own.
        if (strat.visionModelId && !caps.vision) {
          caps.vision = { via: 'companion', modelId: strat.visionModelId }
        }
        agents[key] = {
          target: { kind: 'chain', members: strat.members },
          ...(Object.keys(caps).length > 0 ? { capabilities: caps } : {}),
        }
        continue
      }

      agents[key] = { target: { kind: 'passthrough' } }
    }
  }

  return {
    version: 3,
    agents,
    ...(typeof raw.streamTranslation === 'boolean'
      ? { streamTranslation: raw.streamTranslation }
      : {}),
  }
}

/** v3 → v4: no structural change — v4 only adds the `composite` target kind
 *  (which v3 files never carry). Pure version bump; `normalizeRoutingPolicy`
 *  re-normalizes the agents map regardless. */
function migrateV3ToV4(raw: Record<string, unknown>): Record<string, unknown> {
  return { ...raw, version: ROUTING_POLICY_VERSION }
}

/** Coerce parsed JSON into a valid policy — malformed entries are dropped.
 *  Older versions are migrated forward; throws only on an unsupported version. */
export function normalizeRoutingPolicy(raw: unknown): RoutingPolicy {
  if (!isObj(raw)) return { ...EMPTY_POLICY }
  let obj: Record<string, unknown> = raw
  if (obj.version === 1) obj = migrateV1ToV2(obj)
  if (obj.version === 2) obj = migrateV2ToV3(obj)
  if (obj.version === 3) obj = migrateV3ToV4(obj)
  if (obj.version !== ROUTING_POLICY_VERSION) {
    throw new Error(
      `routing.json version ${String(obj.version)} not supported (expected ${ROUTING_POLICY_VERSION})`,
    )
  }
  const agents: Record<string, AgentRouting> = {}
  if (isObj(obj.agents)) {
    for (const [key, value] of Object.entries(obj.agents)) {
      const routing = normalizeRouting(value)
      if (routing) agents[key] = routing
    }
  }
  const subagentDowngrade = normalizeSubagentDowngrade(obj.subagentDowngrade)
  return {
    version: ROUTING_POLICY_VERSION,
    agents,
    ...(subagentDowngrade ? { subagentDowngrade } : {}),
    ...(typeof obj.streamTranslation === 'boolean'
      ? { streamTranslation: obj.streamTranslation }
      : {}),
  }
}

// ── read / write ──────────────────────────────────────────────────

export async function readRoutingPolicy(): Promise<RoutingPolicy> {
  if (!(await fileExists(paths.routing))) return { ...EMPTY_POLICY }
  return normalizeRoutingPolicy(JSON.parse(await readFile(paths.routing, 'utf8')))
}

export async function writeRoutingPolicy(policy: RoutingPolicy): Promise<void> {
  await atomicWrite(paths.routing, `${JSON.stringify(policy, null, 2)}\n`)
}

let writeChain: Promise<unknown> = Promise.resolve()

/** Serialized read-modify-write — see model-registry.ts mutateModelRegistry. */
export function mutateRoutingPolicy(
  fn: (policy: RoutingPolicy) => RoutingPolicy | undefined,
): Promise<RoutingPolicy> {
  const next = writeChain.then(async () => {
    const policy = await readRoutingPolicy()
    const updated = fn(policy)
    if (updated) await writeRoutingPolicy(updated)
    return updated ?? policy
  })
  writeChain = next.catch(() => {})
  return next
}
