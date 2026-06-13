// The model registry — ~/.agentfw/models.json. The catalog of providers and
// models agentfw can route an agent to. Seeded automatically from the wire
// (one provider per route, models observed in captured traffic) and extended
// by the user. Modeled on OpenClaw's provider/model onboarding config.

import { readFile } from 'node:fs/promises'
import { atomicWrite, fileExists } from './atomic-file.ts'
import { paths } from './paths.ts'
import {
  type CapabilityFulfillment,
  type CapabilityId,
  type ChainMember,
  normalizeCapabilities,
  normalizeMember,
} from './routing-policy.ts'

export const MODEL_REGISTRY_VERSION = 2 as const

/** The three request/response wire formats agentfw can translate between. */
export type ModelApi = 'anthropic-messages' | 'openai-chat' | 'openai-responses'

export type Modality = 'text' | 'audio' | 'image' | 'video' | 'pdf'

/** Reasoning effort knob shared across OpenAI Responses (`reasoning.effort`)
 *  and Anthropic Messages (thinking budget). 'xhigh' is honored by Anthropic
 *  thinking budget; for OpenAI it's clamped to 'high'. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type ProviderAuth =
  // Inject a custom header (e.g. `x-api-key`) with a value from secrets.json.
  | { kind: 'api-key'; header: string; valueRef: string }
  // Inject `Authorization: Bearer <secret>`.
  | { kind: 'bearer'; valueRef: string }
  // Inject a subscription OAuth token agentfw reads — and refreshes — from
  // the owning agent's own credential store (Keychain / auth.json). The
  // token is never copied into secrets.json.
  | { kind: 'agent-oauth'; agent: 'claude-code' | 'codex' }
  // Reuse the client agent's own auth header verbatim (same-provider routing).
  | { kind: 'passthrough' }

export type ProviderEntry = {
  id: string
  label: string
  baseUrl: string
  api: ModelApi
  auth: ProviderAuth
  origin: 'seeded' | 'manual'
  /** For seeded providers — the routeKey "<agent>/<provider>" they came from. */
  seededFrom?: string
  /** Reasoning effort applied to requests this provider sees. For OAuth
   *  subscriptions this is load-bearing (codex's chatgpt backend returns
   *  empty content without `reasoning.effort`, claude-code thinking is
   *  set from this); for api-key providers it's an optional default a
   *  routed call can carry to a reasoning-capable model. */
  reasoningEffort?: ReasoningEffort
}

/** USD per million tokens, the display convention used across agentfw. */
export type ModelCost = {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export type ModelEntry = {
  id: string
  providerId: string
  label: string
  /** Overrides the provider's api when a provider hosts mixed wire formats. */
  api?: ModelApi
  /** The modality array doubles as the vision flag — see isVision(). */
  input: Modality[]
  contextWindow?: number
  maxTokens?: number
  cost?: ModelCost
  origin: 'seeded' | 'manual'
}

/** A reusable combination model: an ordered failover chain of models plus the
 *  capabilities (vision companion, web_search tool provider) agentfw fulfills
 *  on its behalf. Routes target a combo by id (`{kind:'composite', comboId}`);
 *  the combo — not the route — owns its members + capabilities. Reinstates the
 *  old routing-v2 "strategy" concept as a first-class, registry-owned model. */
export type CombinationModel = {
  id: string
  label: string
  members: ChainMember[]
  capabilities?: Partial<Record<CapabilityId, CapabilityFulfillment>>
  origin: 'manual'
}

export type ModelRegistry = {
  version: typeof MODEL_REGISTRY_VERSION
  providers: ProviderEntry[]
  models: ModelEntry[]
  combos: CombinationModel[]
}

export const EMPTY_REGISTRY: ModelRegistry = {
  version: MODEL_REGISTRY_VERSION,
  providers: [],
  models: [],
  combos: [],
}

const MODEL_APIS: ModelApi[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const MODALITIES: Modality[] = ['text', 'audio', 'image', 'video', 'pdf']
const REASONING_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh']

// ── helpers ───────────────────────────────────────────────────────

export function findProvider(reg: ModelRegistry, id: string): ProviderEntry | undefined {
  return reg.providers.find((p) => p.id === id)
}

/** Look up a model by id, optionally scoped to a provider.
 *
 *  Same model id can exist under multiple providers (e.g. a Xiangxin
 *  model harvested under `hermes/...` and also added by hand under a
 *  custom `og-text` provider). When `providerId` is supplied we match
 *  the exact pair; otherwise we fall back to the first matching id so
 *  legacy callers (and pre-providerId routing-policy entries) still
 *  resolve to *something* instead of breaking. */
export function findModel(
  reg: ModelRegistry,
  id: string,
  providerId?: string,
): ModelEntry | undefined {
  if (providerId !== undefined) {
    return reg.models.find((m) => m.id === id && m.providerId === providerId)
  }
  return reg.models.find((m) => m.id === id)
}

/** A model's effective wire format: its own override, else its provider's. */
export function resolveApi(reg: ModelRegistry, model: ModelEntry): ModelApi | undefined {
  return model.api ?? findProvider(reg, model.providerId)?.api
}

/** A model can see images — the trigger for the text↔multimodal split. */
export function isVision(model: ModelEntry): boolean {
  return model.input.includes('image')
}

export function findCombo(reg: ModelRegistry, id: string): CombinationModel | undefined {
  return reg.combos.find((c) => c.id === id)
}

// ── parse / normalize ─────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function normalizeAuth(raw: unknown): ProviderAuth | undefined {
  if (!isObj(raw)) return undefined
  if (raw.kind === 'passthrough') return { kind: 'passthrough' }
  if (raw.kind === 'agent-oauth' && (raw.agent === 'claude-code' || raw.agent === 'codex')) {
    return { kind: 'agent-oauth', agent: raw.agent }
  }
  if (raw.kind === 'bearer' && typeof raw.valueRef === 'string') {
    return { kind: 'bearer', valueRef: raw.valueRef }
  }
  if (
    raw.kind === 'api-key' &&
    typeof raw.header === 'string' &&
    raw.header !== '' &&
    typeof raw.valueRef === 'string'
  ) {
    return { kind: 'api-key', header: raw.header, valueRef: raw.valueRef }
  }
  return undefined
}

function normalizeProvider(raw: unknown): ProviderEntry | undefined {
  if (!isObj(raw)) return undefined
  const { id, label, baseUrl, api, origin, seededFrom, reasoningEffort } = raw
  if (typeof id !== 'string' || id === '') return undefined
  if (typeof baseUrl !== 'string' || baseUrl === '') return undefined
  if (!MODEL_APIS.includes(api as ModelApi)) return undefined
  const auth = normalizeAuth(raw.auth)
  if (!auth) return undefined
  return {
    id,
    label: typeof label === 'string' ? label : id,
    baseUrl,
    api: api as ModelApi,
    auth,
    origin: origin === 'manual' ? 'manual' : 'seeded',
    ...(typeof seededFrom === 'string' ? { seededFrom } : {}),
    ...(REASONING_EFFORTS.includes(reasoningEffort as ReasoningEffort)
      ? { reasoningEffort: reasoningEffort as ReasoningEffort }
      : {}),
  }
}

function normalizeCost(raw: unknown): ModelCost | undefined {
  if (!isObj(raw)) return undefined
  const { input, output, cacheRead, cacheWrite } = raw
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  return {
    input,
    output,
    ...(typeof cacheRead === 'number' ? { cacheRead } : {}),
    ...(typeof cacheWrite === 'number' ? { cacheWrite } : {}),
  }
}

function normalizeModel(raw: unknown): ModelEntry | undefined {
  if (!isObj(raw)) return undefined
  const { id, providerId, label, api, origin, contextWindow, maxTokens } = raw
  if (typeof id !== 'string' || id === '') return undefined
  if (typeof providerId !== 'string' || providerId === '') return undefined
  const input = Array.isArray(raw.input)
    ? raw.input.filter((m): m is Modality => MODALITIES.includes(m as Modality))
    : []
  const cost = normalizeCost(raw.cost)
  return {
    id,
    providerId,
    label: typeof label === 'string' ? label : id,
    ...(MODEL_APIS.includes(api as ModelApi) ? { api: api as ModelApi } : {}),
    input: input.length > 0 ? input : ['text'],
    ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
    ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
    ...(cost ? { cost } : {}),
    origin: origin === 'manual' ? 'manual' : 'seeded',
  }
}

/** A combination model — members + capabilities reuse the routing-policy
 *  normalizers so a combo and a per-route chain validate identically. Dropped
 *  when it has no id or no resolvable members. */
function normalizeCombo(raw: unknown): CombinationModel | undefined {
  if (!isObj(raw)) return undefined
  const { id, label } = raw
  if (typeof id !== 'string' || id === '') return undefined
  const members = Array.isArray(raw.members)
    ? raw.members.map(normalizeMember).filter((m): m is ChainMember => m != null)
    : []
  if (members.length === 0) return undefined
  const capabilities = normalizeCapabilities(raw.capabilities)
  return {
    id,
    label: typeof label === 'string' && label !== '' ? label : id,
    members,
    ...(capabilities ? { capabilities } : {}),
    origin: 'manual',
  }
}

/** Coerce parsed JSON into a valid registry — malformed entries are dropped,
 *  a hand-edited file with one bad entry never wipes the rest. v1 (no `combos`)
 *  is accepted and migrated forward trivially. Throws only on an unsupported
 *  version, so a future format is never silently downgraded. */
export function normalizeModelRegistry(raw: unknown): ModelRegistry {
  if (!isObj(raw)) return { ...EMPTY_REGISTRY }
  if (raw.version !== 1 && raw.version !== MODEL_REGISTRY_VERSION) {
    throw new Error(
      `models.json version ${String(raw.version)} not supported (expected ${MODEL_REGISTRY_VERSION})`,
    )
  }
  const providers = Array.isArray(raw.providers)
    ? raw.providers.map(normalizeProvider).filter((p): p is ProviderEntry => p != null)
    : []
  const models = Array.isArray(raw.models)
    ? raw.models.map(normalizeModel).filter((m): m is ModelEntry => m != null)
    : []
  const combos = Array.isArray(raw.combos)
    ? raw.combos.map(normalizeCombo).filter((c): c is CombinationModel => c != null)
    : []
  return { version: MODEL_REGISTRY_VERSION, providers, models, combos }
}

// ── read / write ──────────────────────────────────────────────────

export async function readModelRegistry(): Promise<ModelRegistry> {
  if (!(await fileExists(paths.models))) return { ...EMPTY_REGISTRY }
  return normalizeModelRegistry(JSON.parse(await readFile(paths.models, 'utf8')))
}

export async function writeModelRegistry(reg: ModelRegistry): Promise<void> {
  await atomicWrite(paths.models, `${JSON.stringify(reg, null, 2)}\n`)
}

// why: read-modify-write of one shared file races under concurrency (the
// observed-model hook fires on every model_call). Serialize all mutations
// through one chain so no update is lost.
let writeChain: Promise<unknown> = Promise.resolve()

export function mutateModelRegistry(
  fn: (reg: ModelRegistry) => ModelRegistry | undefined,
): Promise<ModelRegistry> {
  const next = writeChain.then(async () => {
    const reg = await readModelRegistry()
    const updated = fn(reg)
    if (updated) await writeModelRegistry(updated)
    return updated ?? reg
  })
  writeChain = next.catch(() => {})
  return next
}
