// /api/routing — the daemon side of the Control · Routing UI and the
// `agentfw route` CLI. Reads and mutates the three routing config files
// (models.json, routing.json, secrets.json) and reports last-24h spend.
//
// Secrets are write-only across this surface: the UI sends API-key values
// in, but only ever gets back the set of refs that exist — never a value.

import type { Context } from 'hono'
import {
  type CombinationModel,
  type Modality,
  type ModelApi,
  type ModelCost,
  type ModelEntry,
  type ProviderAuth,
  type ProviderEntry,
  type ReasoningEffort,
  findCombo,
  findModel,
  findProvider,
  mutateModelRegistry,
  readModelRegistry,
} from '../../core/model-registry.ts'
import {
  type CapabilityFulfillment,
  type CapabilityId,
  type ChainMember,
  type RoutingTarget,
  type SwitchRule,
  effectiveSubagentDowngrade,
  mutateRoutingPolicy,
  readRoutingPolicy,
} from '../../core/routing-policy.ts'
import { getSecret, readSecrets, removeSecret, secretRefs, setSecret } from '../../core/secrets.ts'
import { readManifest } from '../../cli/backup/manifest.ts'
import { activeProviderFor, readToolProviders, type ToolKind } from '../../core/tool-providers.ts'
import { clearBudgetCache } from '../orchestrator/budget.ts'
import { getRoutes } from '../routes/load.ts'
import { baselineInputTokens, recentModels } from '../store/models-queries.ts'

const MODEL_APIS: ModelApi[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const MODALITIES: Modality[] = ['text', 'audio', 'image', 'video', 'pdf']
const REASONING_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh']
const ONE_DAY = 24 * 3_600_000

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json()
    return isObj(body) ? body : null
  } catch {
    return null
  }
}

// ── GET /api/routing/registry ─────────────────────────────────────

export async function handleGetRegistry(c: Context): Promise<Response> {
  const reg = await readModelRegistry()
  const secrets = await readSecrets()
  return c.json({
    providers: reg.providers,
    models: reg.models,
    combos: reg.combos,
    secretRefs: secretRefs(secrets),
  })
}

// ── POST /api/routing/provider ────────────────────────────────────

/** Derive a stable, URL-safe internal id from a human name. Falls back to
 *  `provider` for names with no ASCII alphanumerics (e.g. pure CJK), and
 *  suffixes `-2`, `-3`, … to avoid colliding with an existing id. The id is
 *  what routing.json chains and the `provider:<id>` secret ref point at, so it
 *  is generated once at creation and never changes — the user only ever edits
 *  the display name. */
function deriveId(name: string, taken: Iterable<string>, fallback: string): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || fallback
  const set = new Set(taken)
  if (!set.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!set.has(candidate)) return candidate
  }
}

function generateProviderId(name: string, taken: Iterable<string>): string {
  return deriveId(name, taken, 'provider')
}

export async function handlePostProvider(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)

  // The user types a display name; the id is internal. On edit the client
  // echoes back the existing id (so the upsert + secret ref stay keyed to it);
  // on create the id is absent and we derive a stable one from the name.
  const name =
    typeof body.name === 'string' && body.name.trim() !== ''
      ? body.name.trim()
      : typeof body.label === 'string'
        ? body.label.trim()
        : ''
  const providedId = typeof body.id === 'string' ? body.id.trim() : ''
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
  const api = body.api
  if (!providedId && !name) return c.json({ error: 'provider name required' }, 400)
  if (!baseUrl) return c.json({ error: 'baseUrl required' }, 400)
  if (!MODEL_APIS.includes(api as ModelApi)) {
    return c.json({ error: `api must be one of ${MODEL_APIS.join(', ')}` }, 400)
  }

  const reg0 = await readModelRegistry()
  const id =
    providedId ||
    generateProviderId(
      name,
      reg0.providers.map((p) => p.id),
    )
  // On edit the name may be omitted (id echoed back) — keep the existing label.
  const label = name || reg0.providers.find((p) => p.id === id)?.label || id

  const authKind = body.authKind
  let auth: ProviderAuth
  if (authKind === 'passthrough') {
    auth = { kind: 'passthrough' }
  } else if (authKind === 'bearer' || authKind === 'api-key') {
    const valueRef = `provider:${id}`
    // why: only persist the key when the form actually carried one — editing
    // a provider without re-typing the key must keep the stored secret.
    if (typeof body.apiKey === 'string' && body.apiKey !== '') {
      await setSecret(valueRef, body.apiKey)
    }
    if (authKind === 'bearer') {
      auth = { kind: 'bearer', valueRef }
    } else {
      const header = typeof body.authHeader === 'string' ? body.authHeader.trim() : ''
      if (!header) return c.json({ error: 'authHeader required for api-key auth' }, 400)
      auth = { kind: 'api-key', header, valueRef }
    }
  } else {
    return c.json({ error: 'authKind must be passthrough, bearer, or api-key' }, 400)
  }

  const reasoningEffort = REASONING_EFFORTS.includes(body.reasoningEffort as ReasoningEffort)
    ? (body.reasoningEffort as ReasoningEffort)
    : undefined

  const provider: ProviderEntry = {
    id,
    label,
    baseUrl,
    api: api as ModelApi,
    auth,
    origin: 'manual',
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }

  const reg = await mutateModelRegistry((r) => ({
    ...r,
    providers: [...r.providers.filter((p) => p.id !== id), provider],
  }))
  return c.json({ ok: true, providers: reg.providers })
}

// ── POST /api/routing/provider/effort ─────────────────────────────

/** Update only the reasoningEffort field on a provider, preserving every
 *  other field (auth, origin, baseUrl). The user can flip this on seeded
 *  OAuth-subscription providers without converting them to `manual`. */
export async function handlePostProviderEffort(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (!id) return c.json({ error: 'provider id required' }, 400)
  const raw = body.reasoningEffort
  if (raw != null && !REASONING_EFFORTS.includes(raw as ReasoningEffort)) {
    return c.json(
      { error: `reasoningEffort must be one of ${REASONING_EFFORTS.join(', ')} or null` },
      400,
    )
  }
  const effort = raw == null ? undefined : (raw as ReasoningEffort)
  const reg = await mutateModelRegistry((r) => ({
    ...r,
    providers: r.providers.map((p) => {
      if (p.id !== id) return p
      const next: ProviderEntry = { ...p }
      if (effort) next.reasoningEffort = effort
      else delete next.reasoningEffort
      return next
    }),
  }))
  return c.json({ ok: true, providers: reg.providers })
}

// ── DELETE /api/routing/provider?id= ──────────────────────────────

export async function handleDeleteProvider(c: Context): Promise<Response> {
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'missing id' }, 400)

  const reg = await mutateModelRegistry((r) => ({
    ...r,
    // Drop the provider and any models that pointed at it — an orphan model
    // can never resolve.
    providers: r.providers.filter((p) => p.id !== id),
    models: r.models.filter((m) => m.providerId !== id),
  }))
  await removeSecret(`provider:${id}`)
  return c.json({ ok: true, providers: reg.providers, models: reg.models })
}

// ── POST /api/routing/model ───────────────────────────────────────

function normalizeModalities(raw: unknown): Modality[] {
  if (!Array.isArray(raw)) return ['text']
  const out = raw.filter((m): m is Modality => MODALITIES.includes(m as Modality))
  return out.length > 0 ? out : ['text']
}

function normalizeCostInput(raw: unknown): ModelCost | undefined {
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

export async function handlePostModel(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)

  const id = typeof body.id === 'string' ? body.id.trim() : ''
  const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : ''
  if (!id) return c.json({ error: 'model id required' }, 400)
  if (!providerId) return c.json({ error: 'providerId required' }, 400)

  const reg0 = await readModelRegistry()
  if (!findProvider(reg0, providerId)) {
    return c.json({ error: `unknown provider "${providerId}"` }, 400)
  }

  const cost = normalizeCostInput(body.cost)
  const model: ModelEntry = {
    id,
    providerId,
    label: typeof body.label === 'string' && body.label !== '' ? body.label : id,
    ...(MODEL_APIS.includes(body.api as ModelApi) ? { api: body.api as ModelApi } : {}),
    input: normalizeModalities(body.input),
    ...(typeof body.contextWindow === 'number' ? { contextWindow: body.contextWindow } : {}),
    ...(typeof body.maxTokens === 'number' ? { maxTokens: body.maxTokens } : {}),
    ...(cost ? { cost } : {}),
    origin: 'manual',
  }

  const reg = await mutateModelRegistry((r) => ({
    ...r,
    // Dedupe by (providerId, id) — the same model id can legitimately
    // exist under more than one provider, so a same-id row under a
    // different provider must survive this upsert untouched.
    models: [...r.models.filter((m) => !(m.id === id && m.providerId === providerId)), model],
  }))
  return c.json({ ok: true, models: reg.models })
}

// ── DELETE /api/routing/model?id=&providerId= ─────────────────────

export async function handleDeleteModel(c: Context): Promise<Response> {
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'missing id' }, 400)
  // providerId is optional for back-compat with older UIs / scripts:
  // when missing, fall back to "any model with this id" (the previous
  // behavior). New UI always passes it so a delete on one provider's
  // copy doesn't take the sibling under another provider with it.
  const providerId = c.req.query('providerId')
  const reg = await mutateModelRegistry((r) => ({
    ...r,
    models: r.models.filter((m) => {
      if (m.id !== id) return true
      if (providerId !== undefined && m.providerId !== providerId) return true
      return false
    }),
  }))
  return c.json({ ok: true, models: reg.models })
}

// ── POST /api/routing/combo ───────────────────────────────────────
//
// Combination models — a reusable failover chain + capabilities (vision
// companion, web_search tool provider) stored in the registry. A route targets
// one by id (`{kind:'composite', comboId}`); the combo, not the route, owns its
// members and capabilities.

/** Normalize + validate a combo's capabilities map: vision must point at a real
 *  (companion) model; web_search at a real local tool provider. */
async function normalizeComboCapabilities(
  raw: unknown,
): Promise<{ caps?: Partial<Record<CapabilityId, CapabilityFulfillment>> } | { error: string }> {
  if (raw == null) return {}
  if (!isObj(raw)) return { error: 'capabilities must be an object' }
  const out: Partial<Record<CapabilityId, CapabilityFulfillment>> = {}
  const reg = await readModelRegistry()

  const vision = raw.vision
  if (isObj(vision)) {
    if (vision.via !== 'companion') return { error: "vision capability must be via 'companion'" }
    const modelId = typeof vision.modelId === 'string' ? vision.modelId.trim() : ''
    if (!modelId) return { error: 'vision companion needs a modelId' }
    const providerId =
      typeof vision.providerId === 'string' && vision.providerId !== ''
        ? vision.providerId
        : undefined
    if (!findModel(reg, modelId, providerId)) {
      return { error: `unknown vision companion "${providerId ? `${providerId}/` : ''}${modelId}"` }
    }
    out.vision = providerId
      ? { via: 'companion', modelId, providerId }
      : { via: 'companion', modelId }
  }

  const ws = raw.web_search
  if (isObj(ws)) {
    if (ws.via !== 'local') return { error: "web_search capability must be via 'local'" }
    const providerId =
      typeof ws.providerId === 'string' && ws.providerId !== '' ? ws.providerId : undefined
    if (providerId) {
      const store = await readToolProviders()
      if (!store.providers.some((p) => p.id === providerId && p.kind === 'web_search')) {
        return { error: `unknown web_search tool provider "${providerId}"` }
      }
    }
    out.web_search = providerId ? { via: 'local', providerId } : { via: 'local' }
  }

  return { caps: Object.keys(out).length > 0 ? out : undefined }
}

export async function handlePostCombo(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)

  const providedId = typeof body.id === 'string' ? body.id.trim() : ''
  const name = typeof body.label === 'string' ? body.label.trim() : ''
  if (!providedId && !name) return c.json({ error: 'combination model name required' }, 400)

  if (!Array.isArray(body.members) || body.members.length === 0) {
    return c.json({ error: 'a combination model needs at least one model' }, 400)
  }
  const members: ChainMember[] = []
  for (const m of body.members) {
    const norm = normalizeMemberInput(m)
    if ('error' in norm) return c.json({ error: norm.error }, 400)
    members.push(norm)
  }

  const reg0 = await readModelRegistry()
  for (const m of members) {
    if (!findModel(reg0, m.modelId, m.providerId)) {
      const where = m.providerId ? `model "${m.providerId}/${m.modelId}"` : `model "${m.modelId}"`
      return c.json({ error: `unknown ${where}` }, 400)
    }
  }

  const capsResult = await normalizeComboCapabilities(body.capabilities)
  if ('error' in capsResult) return c.json({ error: capsResult.error }, 400)

  const id =
    providedId ||
    deriveId(
      name,
      reg0.combos.map((x) => x.id),
      'combo',
    )
  const label = name || reg0.combos.find((x) => x.id === id)?.label || id
  const combo: CombinationModel = {
    id,
    label,
    members,
    ...(capsResult.caps ? { capabilities: capsResult.caps } : {}),
    origin: 'manual',
  }

  const reg = await mutateModelRegistry((r) => ({
    ...r,
    combos: [...r.combos.filter((x) => x.id !== id), combo],
  }))
  return c.json({ ok: true, combos: reg.combos })
}

// ── DELETE /api/routing/combo?id= ─────────────────────────────────

export async function handleDeleteCombo(c: Context): Promise<Response> {
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'missing id' }, 400)
  // Routes that pointed at this combo aren't rewritten — they degrade to
  // passthrough at resolve time (logged). Surface them so the UI can warn.
  const policy = await readRoutingPolicy()
  const affectedRoutes = Object.entries(policy.agents)
    .filter(([, a]) => a.target.kind === 'composite' && a.target.comboId === id)
    .map(([k]) => k)
  const reg = await mutateModelRegistry((r) => ({
    ...r,
    combos: r.combos.filter((x) => x.id !== id),
  }))
  return c.json({
    ok: true,
    combos: reg.combos,
    ...(affectedRoutes.length > 0 ? { affectedRoutes } : {}),
  })
}

// ── POST /api/routing/list-models ─────────────────────────────────

/** A model id discovered from a provider's own `/v1/models` endpoint. */
export type DiscoveredModel = { id: string; label?: string }

/** Trim an upstream error body to a short single-line excerpt — strips
 *  HTML tags and collapses whitespace, for a readable inline UI error. */
function errorExcerpt(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** Parse a provider's model-list response tolerantly. Handles OpenAI
 *  (`{data:[{id}]}`), Anthropic (`{data:[{id,display_name}]}`), an
 *  `{models:[…]}` envelope, and a bare array of objects or strings.
 *  Idless entries are dropped and ids de-duped. */
export function parseModelList(json: unknown): DiscoveredModel[] {
  const rows: unknown[] = Array.isArray(json)
    ? json
    : isObj(json) && Array.isArray(json.data)
      ? json.data
      : isObj(json) && Array.isArray(json.models)
        ? json.models
        : []
  const seen = new Set<string>()
  const out: DiscoveredModel[] = []
  for (const row of rows) {
    let id = ''
    let label: string | undefined
    if (typeof row === 'string') {
      id = row.trim()
    } else if (isObj(row)) {
      id =
        typeof row.id === 'string'
          ? row.id.trim()
          : typeof row.name === 'string'
            ? row.name.trim()
            : ''
      const dn = row.display_name ?? row.label
      if (typeof dn === 'string' && dn.trim() !== '') label = dn.trim()
    }
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(label ? { id, label } : { id })
  }
  return out
}

/** Build a provider's `/v1/models` URL, matching `generationUrl`'s
 *  convention that a base URL already ending in `/v1` is not doubled. */
export function modelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
}

/** When a baseUrl carries a protocol-translation path (e.g. DeepSeek's
 *  `https://api.deepseek.com/anthropic`), the inference endpoint lives
 *  under that path but the `/v1/models` listing is usually only
 *  implemented at the origin root. Returns the origin's `/v1/models`
 *  when distinct from the path-scoped one, or undefined when there's
 *  nothing different to try. parseModelList handles both Anthropic and
 *  OpenAI response shapes, so swapping which one we hit doesn't matter
 *  for the parsed result. */
export function rootModelsUrlFallback(baseUrl: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return undefined
  }
  // Treat "/" and "/v1" as already-root paths — no fallback needed.
  const path = parsed.pathname.replace(/\/+$/, '')
  if (path === '' || path === '/v1') return undefined
  const root = `${parsed.protocol}//${parsed.host}`
  const fallback = `${root}/v1/models`
  return fallback === modelsUrl(baseUrl) ? undefined : fallback
}

// Discovery for the "List models" button on the Add-provider form. Issues
// exactly one GET to the user's own configured provider baseUrl with the
// user's own key, only on an explicit click — contacts no agentfw/Anthropic
// server and sends no identifiers. Within the PRIVACY.md contract. Never
// throws: a network error or a non-2xx upstream becomes a 502 {error}.
export async function handlePostListModels(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)

  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
  const api = body.api
  if (!baseUrl) return c.json({ error: 'baseUrl required' }, 400)
  if (!MODEL_APIS.includes(api as ModelApi)) {
    return c.json({ error: `api must be one of ${MODEL_APIS.join(', ')}` }, 400)
  }

  const headers = new Headers({ accept: 'application/json' })
  if (api === 'anthropic-messages') headers.set('anthropic-version', '2023-06-01')

  const authKind = body.authKind
  if (authKind === 'bearer' || authKind === 'api-key') {
    // The form may carry the key directly; otherwise fall back to the
    // secret already stored for an existing provider.
    let key = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    if (key === '') {
      const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : ''
      if (providerId !== '') {
        key = getSecret(await readSecrets(), `provider:${providerId}`) ?? ''
      }
    }
    if (key === '') {
      return c.json({ error: "an API key is required to list this provider's models" }, 400)
    }
    if (authKind === 'bearer') {
      headers.set('authorization', `Bearer ${key}`)
    } else {
      const header = typeof body.authHeader === 'string' ? body.authHeader.trim() : ''
      if (!header) return c.json({ error: 'authHeader required for api-key auth' }, 400)
      headers.set(header, key)
    }
  }

  // Try the path-scoped /v1/models first. If it fails (4xx/5xx, network,
  // non-JSON), and the baseUrl has a protocol-translation path like
  // `/anthropic`, try the origin's /v1/models — many third-party
  // providers (e.g. DeepSeek) only implement the inference endpoints
  // under the protocol-prefixed path but expose the models listing at
  // the root. parseModelList handles both wire shapes so the swap is
  // transparent.
  const result = await tryFetchModels(modelsUrl(baseUrl), headers)
  if (result.ok) return c.json({ models: result.models })

  const fallbackUrl = rootModelsUrlFallback(baseUrl)
  if (fallbackUrl) {
    const fallback = await tryFetchModels(fallbackUrl, headers)
    if (fallback.ok) return c.json({ models: fallback.models })
  }
  return c.json({ error: result.error }, 502)
}

type TryFetchResult = { ok: true; models: DiscoveredModel[] } | { ok: false; error: string }

async function tryFetchModels(url: string, headers: Headers): Promise<TryFetchResult> {
  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers })
  } catch (err) {
    return { ok: false, error: `could not reach ${url}: ${(err as Error).message}` }
  }
  const text = await res.text().catch(() => '')
  if (res.status >= 400) {
    return { ok: false, error: `provider returned HTTP ${res.status}: ${errorExcerpt(text)}` }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: `provider returned a non-JSON response: ${errorExcerpt(text)}` }
  }
  return { ok: true, models: parseModelList(json) }
}

// ── GET /api/routing/policy ───────────────────────────────────────

// The Routing view renders one card per wire route. Excluded here:
//   • MCP routes — they carry no model traffic.
//   • routes for agents not currently wired — `agentfw unwire` deliberately
//     leaves stale entries in routes.json, so without this filter the page
//     shows dead cards for agents that were wired at some point in the past.
export async function handleGetPolicy(c: Context): Promise<Response> {
  const policy = await readRoutingPolicy()
  const reg = await readModelRegistry()
  const manifest = await readManifest()
  const toolStore = await readToolProviders()
  // Match handleWireStatus: "wired" = has a (non-tombstoned) route OR a
  // manifest entry. Manual-mode agents like claude-desktop with no MCP
  // wraps only show up in routes.json, never in the manifest — without
  // this union their card never gets per-source-model rows.
  const wiredAgents = new Set<string>(manifest.entries.map((e) => e.agent))
  for (const [routeKey, entry] of Object.entries(getRoutes().routes)) {
    if (entry.tombstoned) continue
    const slash = routeKey.indexOf('/')
    if (slash > 0) wiredAgents.add(routeKey.slice(0, slash))
  }

  // Agents that have the agentfw-tools MCP injected — identified by a
  // manifest entry that set `/mcpServers/agentfw` (or the legacy
  // `/mcpServers/agentfw` from before the rename). The routing card surfaces
  // this as a "Tools" block per agent so the user can see which capabilities
  // agentfw already fills locally vs which still require the upstream's
  // server-side implementation.
  const toolsPointers = new Set(['/mcpServers/agentfw', '/mcpServers/agentfw'])
  const agentsWithAgentfwTools = new Set<string>()
  for (const e of manifest.entries) {
    if (e.changes.some((c) => c.type === 'set' && toolsPointers.has(c.jsonPointer))) {
      agentsWithAgentfwTools.add(e.agent)
    }
  }
  const webSearchProvider = activeProviderFor(toolStore, 'web_search' as ToolKind)
  // The set of tools the agentfw-tools MCP exposes today. Hard-coded for
  // now — when the binary grows new tools this list should be the
  // single source of truth; for v0 keeping it inline avoids spinning
  // up the MCP just to introspect it.
  const agentfwToolsDescriptors = [
    { name: 'web_search', backend: webSearchProvider?.backend ?? 'unconfigured' },
    { name: 'web_fetch', backend: 'local' },
  ]
  const routes = Object.entries(getRoutes().routes)
    .filter(([, entry]) => entry.decoder !== 'mcp')
    .map(([routeKey, entry]) => {
      // routeKey is `<agentType>/<modelId>` (exact wrap) or
      // `<agentType>/*` (wildcard for OAuth-style). Split into the two
      // segments for UI display + dispatch.
      const slash = routeKey.indexOf('/')
      const agent = slash >= 0 ? routeKey.slice(0, slash) : routeKey
      const modelId = slash >= 0 ? routeKey.slice(slash + 1) : ''
      // Source models seen on this route — the UI renders one
      // per-source-model row per entry so wildcard (OAuth) agents can
      // carry per-model overrides alongside the agent default.
      // Populated by noteObservedModel from observed traffic and (for
      // OAuth agents) pre-seeded from KNOWN_SOURCE_MODELS at wire time.
      const sourceModels = reg.models
        .filter((m) => m.providerId === routeKey)
        .map((m) => ({
          id: m.id,
          label: m.label,
          ...(m.input ? { input: m.input } : {}),
        }))
        .sort((a, b) => a.label.localeCompare(b.label))
      // Local agentfw tools the agent has been wired with. Empty for
      // agents that haven't been (re)wired since the agentfw-tools
      // injection landed.
      const tools = agentsWithAgentfwTools.has(agent) ? agentfwToolsDescriptors : []
      return {
        routeKey,
        agent,
        modelId,
        decoder: entry.decoder,
        upstream: entry.upstream,
        sourceModels,
        tools,
        ...(entry.sourceModelId ? { sourceModelId: entry.sourceModelId } : {}),
      }
    })
    .filter((r) => wiredAgents.has(r.agent))
    .sort((a, b) => a.routeKey.localeCompare(b.routeKey))
  // Resolve the subagent cost-saver to its effective (default-merged) config
  // so the UI shows the real state even when routing.json has no override.
  return c.json({ policy, routes, subagentDowngrade: effectiveSubagentDowngrade(policy) })
}

// ── POST /api/routing/subagent ────────────────────────────────────

/** Update the global Claude Code subagent cost-saver. Patches
 *  `policy.subagentDowngrade` from the effective (default-merged) config so a
 *  partial body (e.g. just `{enabled:false}`) is a safe toggle. Mirrors the
 *  `agentfw route subagent` CLI. */
export async function handlePostSubagent(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)
  const next = effectiveSubagentDowngrade(await readRoutingPolicy())
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled
  if (typeof body.modelId === 'string' && body.modelId.trim() !== '') {
    next.modelId = body.modelId.trim()
  }
  if (typeof body.providerId === 'string') {
    const pid = body.providerId.trim()
    if (pid) next.providerId = pid
    else delete next.providerId
  }
  if (typeof body.minMaxTokens === 'number' && body.minMaxTokens >= 0) {
    next.minMaxTokens = body.minMaxTokens
  }
  await mutateRoutingPolicy((p) => ({ ...p, subagentDowngrade: next }))
  return c.json({ ok: true, subagentDowngrade: next })
}

// ── POST /api/routing/agent ───────────────────────────────────────

function normalizeSwitchInput(raw: unknown): SwitchRule | undefined {
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

function normalizeMemberInput(raw: unknown): ChainMember | { error: string } {
  if (!isObj(raw)) return { error: 'each member must be an object' }
  if (typeof raw.modelId !== 'string' || raw.modelId === '') {
    return { error: 'each member needs a modelId' }
  }
  const switchOn = Array.isArray(raw.switchOn)
    ? raw.switchOn.map(normalizeSwitchInput).filter((r): r is SwitchRule => r != null)
    : []
  return {
    modelId: raw.modelId,
    ...(typeof raw.providerId === 'string' && raw.providerId !== ''
      ? { providerId: raw.providerId }
      : {}),
    ...(switchOn.length > 0 ? { switchOn } : {}),
  }
}

function normalizeTargetInput(raw: unknown): RoutingTarget | { error: string } {
  if (!isObj(raw)) return { error: 'target must be an object' }
  if (raw.kind === 'passthrough') return { kind: 'passthrough' }
  if (raw.kind === 'composite') {
    const comboId = typeof raw.comboId === 'string' ? raw.comboId.trim() : ''
    if (!comboId) return { error: 'composite target needs a comboId' }
    return { kind: 'composite', comboId }
  }
  if (raw.kind === 'chain') {
    if (!Array.isArray(raw.members) || raw.members.length === 0) {
      return { error: 'chain target needs at least one member' }
    }
    const members: ChainMember[] = []
    for (const m of raw.members) {
      const norm = normalizeMemberInput(m)
      if ('error' in norm) return { error: norm.error }
      members.push(norm)
    }
    return { kind: 'chain', members }
  }
  return { error: 'target.kind must be passthrough, chain, or composite' }
}

export async function handlePostAgent(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)

  const routeKey = typeof body.routeKey === 'string' ? body.routeKey.trim() : ''
  if (!routeKey) return c.json({ error: 'routeKey required' }, 400)

  const target = normalizeTargetInput(body.target)
  if ('error' in target) return c.json({ error: target.error }, 400)

  // Validate every chain member's model so the UI gets a real error rather
  // than a silent passthrough fallback at request time.
  const reg = await readModelRegistry()
  if (target.kind === 'chain') {
    for (const m of target.members) {
      if (!findModel(reg, m.modelId, m.providerId)) {
        const where = m.providerId ? `model "${m.providerId}/${m.modelId}"` : `model "${m.modelId}"`
        return c.json({ error: `unknown ${where}` }, 400)
      }
    }
  }
  if (target.kind === 'composite' && !findCombo(reg, target.comboId)) {
    return c.json({ error: `unknown combination model "${target.comboId}"` }, 400)
  }

  // `passthrough` collapses to "no entry" only on the bare-agent wildcard
  // (`<agent>/*`) — there it IS the default, and dropping the entry keeps
  // routing.json minimal. An exact-match key (`claude-code/claude-opus-4-7`)
  // OR a per-instance key (`claude-code@worker-3/*`, minted by
  // `agentfw run --monitor`) must store its passthrough explicitly: the
  // instance's "leave me untouched" has to shadow a type-level model
  // override, which a deleted entry would fall straight through.
  const isWildcardKey = routeKey.endsWith('/*') && !routeKey.includes('@')
  const policy = await mutateRoutingPolicy((p) => {
    const agents = { ...p.agents }
    if (target.kind === 'passthrough' && isWildcardKey) {
      delete agents[routeKey]
    } else {
      agents[routeKey] = { target }
    }
    return { ...p, agents }
  })
  clearBudgetCache()
  return c.json({ ok: true, policy })
}

// ── POST /api/routing/capability ──────────────────────────────────

/** Set a per-route capability fulfillment (vision-companion etc.).
 *  Mutates `policy.agents[routeKey].capabilities[capabilityId]`.
 *  Auto-deleting the entry on `via:'local'` is intentional: local is
 *  the implicit default for any tool we ship (e.g. web_search via the
 *  agentfw-tools MCP), so storing it explicitly just adds noise. Use
 *  the DELETE endpoint when you want to revert a companion override. */
const KNOWN_CAPABILITY_IDS = new Set(['vision', 'web_search'])

export async function handlePostCapability(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)
  const routeKey = typeof body.routeKey === 'string' ? body.routeKey.trim() : ''
  if (!routeKey) return c.json({ error: 'routeKey required' }, 400)
  const capabilityId = typeof body.capabilityId === 'string' ? body.capabilityId.trim() : ''
  if (!KNOWN_CAPABILITY_IDS.has(capabilityId)) {
    return c.json(
      { error: `capabilityId must be one of ${[...KNOWN_CAPABILITY_IDS].join(', ')}` },
      400,
    )
  }

  const fulfillment = body.fulfillment
  if (!isObj(fulfillment)) {
    return c.json({ error: 'fulfillment object required' }, 400)
  }

  const via = fulfillment.via
  if (via !== 'companion' && via !== 'local') {
    return c.json({ error: "fulfillment.via must be 'companion' or 'local'" }, 400)
  }

  // Validate the referenced model when via='companion'.
  let normalized: import('../../core/routing-policy.ts').CapabilityFulfillment
  if (via === 'companion') {
    const modelId = typeof fulfillment.modelId === 'string' ? fulfillment.modelId : ''
    if (!modelId) return c.json({ error: 'companion fulfillment needs a modelId' }, 400)
    const providerId =
      typeof fulfillment.providerId === 'string' ? fulfillment.providerId : undefined
    const reg = await readModelRegistry()
    if (!findModel(reg, modelId, providerId)) {
      const where = providerId ? `${providerId}/${modelId}` : modelId
      return c.json({ error: `unknown companion model "${where}"` }, 400)
    }
    normalized = providerId
      ? { via: 'companion', modelId, providerId }
      : { via: 'companion', modelId }
  } else {
    const providerId =
      typeof fulfillment.providerId === 'string' && fulfillment.providerId !== ''
        ? fulfillment.providerId
        : undefined
    normalized = providerId ? { via: 'local', providerId } : { via: 'local' }
  }

  const policy = await mutateRoutingPolicy((p) => {
    const agents = { ...p.agents }
    const prior = agents[routeKey] ?? { target: { kind: 'passthrough' as const } }
    const capabilities = { ...(prior.capabilities ?? {}) }
    capabilities[capabilityId as 'vision' | 'web_search'] = normalized
    agents[routeKey] = { ...prior, capabilities }
    return { ...p, agents }
  })
  clearBudgetCache()
  return c.json({ ok: true, policy })
}

// ── DELETE /api/routing/capability?routeKey=&capabilityId= ────────

export async function handleDeleteCapability(c: Context): Promise<Response> {
  const routeKey = c.req.query('routeKey')
  const capabilityId = c.req.query('capabilityId')
  if (!routeKey) return c.json({ error: 'missing routeKey' }, 400)
  if (!capabilityId || !KNOWN_CAPABILITY_IDS.has(capabilityId)) {
    return c.json({ error: 'missing or unknown capabilityId' }, 400)
  }
  const policy = await mutateRoutingPolicy((p) => {
    const prior = p.agents[routeKey]
    if (!prior?.capabilities) return undefined
    if (!(capabilityId in prior.capabilities)) return undefined
    const capabilities = { ...prior.capabilities }
    delete capabilities[capabilityId as 'vision' | 'web_search']
    const next = { ...prior }
    if (Object.keys(capabilities).length === 0) delete next.capabilities
    else next.capabilities = capabilities
    return { ...p, agents: { ...p.agents, [routeKey]: next } }
  })
  clearBudgetCache()
  return c.json({ ok: true, policy })
}

// ── DELETE /api/routing/agent?routeKey= ───────────────────────────

/** Remove an agent routing entry outright — the UI's "Use default"
 *  action on a per-source-model row. With the entry gone, routingFor's
 *  exact→wildcard fallback takes over: the source model now inherits
 *  whatever the `<agent>/*` default is. POSTing passthrough on the same
 *  key would *store* an explicit passthrough — different semantics. */
export async function handleDeleteAgent(c: Context): Promise<Response> {
  const routeKey = c.req.query('routeKey')
  if (!routeKey) return c.json({ error: 'missing routeKey' }, 400)
  const policy = await mutateRoutingPolicy((p) => {
    if (!(routeKey in p.agents)) return undefined
    const agents = { ...p.agents }
    delete agents[routeKey]
    return { ...p, agents }
  })
  clearBudgetCache()
  return c.json({ ok: true, policy })
}

// ── POST /api/routing/secret ──────────────────────────────────────

export async function handlePostSecret(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)
  const ref = typeof body.ref === 'string' ? body.ref.trim() : ''
  const value = typeof body.value === 'string' ? body.value : ''
  if (!ref) return c.json({ error: 'ref required' }, 400)
  if (!value) return c.json({ error: 'value required' }, 400)
  const store = await setSecret(ref, value)
  return c.json({ ok: true, secretRefs: secretRefs(store) })
}

// ── DELETE /api/routing/secret?ref= ───────────────────────────────

export async function handleDeleteSecret(c: Context): Promise<Response> {
  const ref = c.req.query('ref')
  if (!ref) return c.json({ error: 'missing ref' }, 400)
  const store = await removeSecret(ref)
  return c.json({ ok: true, secretRefs: secretRefs(store) })
}

// ── GET /api/routing/spend ────────────────────────────────────────

// Last-24h spend per model id. Routed children carry the real model id and
// real cost; the $0 parent rows fold in harmlessly.
export async function handleGetSpend(c: Context): Promise<Response> {
  const rows = await recentModels(Date.now() - ONE_DAY)
  const byModel = new Map<string, { costUsd: number; calls: number }>()
  for (const r of rows) {
    const acc = byModel.get(r.model) ?? { costUsd: 0, calls: 0 }
    acc.costUsd += r.costMicro / 1_000_000
    acc.calls += r.uses
    byModel.set(r.model, acc)
  }
  const spend = [...byModel.entries()]
    .map(([model, v]) => ({ model, costUsd: v.costUsd, calls: v.calls }))
    .sort((a, b) => b.costUsd - a.costUsd)
  return c.json({ spend })
}

// ── GET /api/routing/baseline ─────────────────────────────────────

// Smallest observed model-call input size for an agent (last 30 days) — the
// launcher uses it to decide whether lowering Claude Code's auto-compaction
// window would fire on the first prompt. Null when there's no traffic yet.
const THIRTY_DAYS = 30 * ONE_DAY
export async function handleGetBaseline(c: Context): Promise<Response> {
  const agent = c.req.query('agent')
  if (!agent) return c.json({ error: 'agent required' }, 400)
  const baselineTokens = await baselineInputTokens(agent, Date.now() - THIRTY_DAYS)
  return c.json({ baselineTokens })
}
