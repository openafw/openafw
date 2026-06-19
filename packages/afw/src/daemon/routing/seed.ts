// Auto-seeding for the model registry. Two sources, split by who knows
// the model list — the agent's config, or only the wire:
//
//   • seedFromRoutes — for agents whose config declares a per-provider
//     `models[]` catalog (OpenClaw and Hermes), seed exactly that list
//     and nothing else. The list is curated by the user; observation
//     for these agents is ignored on purpose so we don't dilute it.
//   • noteObservedModel — for agents whose config carries no model name
//     (Claude Code regardless of auth, Codex regardless of auth — Codex's
//     top-level `model` is a session default the user routinely overrides
//     per-task), the registry grows from captured traffic only.
//
// afw never calls the provider's `/v1/models` for discovery — the
// privacy contract is "no unsolicited outbound calls about the user",
// and a list-models call would still leak that you wired this provider.
// Manual entries are never touched; seeded entries are kept in sync.

import { knownSourceModelsFor } from '../../core/known-source-models.ts'
import { logger } from '../../core/logger.ts'
import {
  type ModelApi,
  type ModelEntry,
  type ProviderAuth,
  type ProviderEntry,
  type ReasoningEffort,
  mutateModelRegistry,
  readModelRegistry,
} from '../../core/model-registry.ts'
import type { DecoderKind, HarvestedModel, RouteEntry } from '../../core/routes.ts'
import { lookupCatalogModel } from '../cost/catalog.ts'
import { getRoutes } from '../routes/load.ts'

/** The decoder kinds afw can translate — others can't be a routing target. */
function decoderToApi(decoder: DecoderKind): ModelApi | undefined {
  if (decoder === 'anthropic') return 'anthropic-messages'
  if (decoder === 'openai-chat') return 'openai-chat'
  if (decoder === 'openai-responses') return 'openai-responses'
  return undefined
}

/** Derive a seeded provider's managed auth from the route's captured
 *  credential shape. The value lives in secrets.json under
 *  `provider:<routeKey>`; a route with no captured credential stays
 *  passthrough so wiring never hard-fails. */
export function authFromRoute(routeKey: string, auth: RouteEntry['auth']): ProviderAuth {
  if (!auth) return { kind: 'passthrough' }
  if (auth.kind === 'agent-oauth') return { kind: 'agent-oauth', agent: auth.agent }
  const valueRef = `provider:${routeKey}`
  return auth.kind === 'bearer'
    ? { kind: 'bearer', valueRef }
    : { kind: 'api-key', header: auth.header, valueRef }
}

/** Default reasoning effort for a seeded OAuth-subscription provider. Both
 *  codex's chatgpt backend and claude-code's Messages route care about a
 *  reasoning / thinking knob — the upstream model behaves differently
 *  without one. Defaults mirror what each first-party CLI sends out of the
 *  box: codex CLI uses `medium`; Claude Code's "Ultrathink" maps to
 *  `xhigh`. The value is preserved if the user later edits it. */
function defaultReasoningEffort(auth: ProviderAuth): ReasoningEffort | undefined {
  if (auth.kind !== 'agent-oauth') return undefined
  return auth.agent === 'claude-code' ? 'xhigh' : 'medium'
}

/** True when two resolved provider auths are interchangeable. */
function sameAuth(a: ProviderAuth, b: ProviderAuth): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'passthrough') return true
  if (a.kind === 'bearer' && b.kind === 'bearer') return a.valueRef === b.valueRef
  if (a.kind === 'agent-oauth' && b.kind === 'agent-oauth') return a.agent === b.agent
  if (a.kind === 'api-key' && b.kind === 'api-key') {
    return a.header === b.header && a.valueRef === b.valueRef
  }
  return false
}

// ── seed providers + harvested models from the wire ───────────────

/** Build the seeded ModelEntry a harvested model maps to. The harvested
 *  model carries no `api` override — its wire format is the provider's.
 *  Modality falls back to the bundled catalog when the agent's own config
 *  didn't declare it. */
function harvestedToModel(routeKey: string, hm: HarvestedModel): ModelEntry {
  const cat = lookupCatalogModel(hm.id)
  return {
    id: hm.id,
    providerId: routeKey,
    label: hm.label ?? hm.id,
    input: hm.input && hm.input.length > 0 ? hm.input : (cat?.input ?? ['text']),
    ...(typeof hm.contextWindow === 'number' ? { contextWindow: hm.contextWindow } : {}),
    ...(typeof hm.maxTokens === 'number' ? { maxTokens: hm.maxTokens } : {}),
    ...(hm.cost ? { cost: hm.cost } : {}),
    origin: 'seeded',
  }
}

/** True when a seeded model row already matches its harvested source. */
function sameModel(a: ModelEntry, b: ModelEntry): boolean {
  return (
    a.providerId === b.providerId &&
    a.label === b.label &&
    a.contextWindow === b.contextWindow &&
    a.maxTokens === b.maxTokens &&
    JSON.stringify(a.input) === JSON.stringify(b.input) &&
    JSON.stringify(a.cost ?? null) === JSON.stringify(b.cost ?? null)
  )
}

/** Agents whose model list comes from their own config (harvested at wire
 *  time) and not from observed traffic. OpenClaw and Hermes both declare
 *  their per-provider `models[]` explicitly; trusting observation for them
 *  would inject ids the user didn't authorise — and would dilute the
 *  curated list with whatever transient slug the wire happened to see. */
const HARVEST_ONLY_AGENTS = new Set(['openclaw', 'hermes'])

function routeAgent(routeKey: string): string {
  const slash = routeKey.indexOf('/')
  return slash > 0 ? routeKey.slice(0, slash) : routeKey
}

/** Drop seeded providers whose wire route has vanished, plus the seeded
 *  models orphaned by them. Manual entries are untouched.
 *
 *  When `harvestOnlyDesired` is supplied, it also prunes seeded models on
 *  *surviving* providers whose id is not in the desired set for that
 *  provider — meant for harvest-only providers (openclaw, hermes) where
 *  the route's `models[]` is authoritative. For other surviving providers
 *  (claude-code, codex), seeded models added by `noteObservedModel` are
 *  kept regardless. */
export function pruneVanishedSeeds(
  providers: ProviderEntry[],
  models: ModelEntry[],
  desiredProviderIds: ReadonlySet<string>,
  harvestOnlyDesired?: ReadonlyMap<string, ReadonlySet<string>>,
): { providers: ProviderEntry[]; models: ModelEntry[]; pruned: boolean } {
  const prunedProviderIds = new Set<string>()
  const keptProviders = providers.filter((p) => {
    if (p.origin === 'seeded' && !desiredProviderIds.has(p.id)) {
      prunedProviderIds.add(p.id)
      return false
    }
    return true
  })
  let modelsDropped = 0
  const keptModels = models.filter((m) => {
    if (m.origin !== 'seeded') return true
    if (prunedProviderIds.has(m.providerId)) {
      modelsDropped++
      return false
    }
    const wanted = harvestOnlyDesired?.get(m.providerId)
    if (wanted && !wanted.has(m.id)) {
      modelsDropped++
      return false
    }
    return true
  })
  return {
    providers: keptProviders,
    models: keptModels,
    pruned: prunedProviderIds.size > 0 || modelsDropped > 0,
  }
}

/** Per translatable wire route: derive one seeded provider — carrying the
 *  managed auth captured at wire time, or passthrough when no credential
 *  was found — and seed any models the agent's config declared.
 *  Idempotent: manual entries are left alone, seeded ones updated in place,
 *  and the file is rewritten only when something actually changed. */
export async function seedFromRoutes(): Promise<void> {
  try {
    const routes = getRoutes().routes
    const desiredProviders: ProviderEntry[] = []
    const desiredModels: ModelEntry[] = []
    // Per-provider desired model id set for harvest-only routes. Passed to
    // `pruneVanishedSeeds` so leftover seeded models from earlier wires
    // (or the deprecated catalog-flood path) get dropped automatically.
    const harvestOnlyDesired = new Map<string, Set<string>>()
    for (const [routeKey, entry] of Object.entries(routes)) {
      // Tombstoned routes were unwired but kept alive so already-running
      // agent processes can still proxy through afw. They must not seed
      // the registry — the user expects the Routing UI to forget unwired
      // agents' models. The proxy still serves them via getRoutes().
      if (entry.tombstoned) continue
      const api = decoderToApi(entry.decoder)
      if (!api) continue
      const auth = authFromRoute(routeKey, entry.auth)
      const defaultEffort = defaultReasoningEffort(auth)
      desiredProviders.push({
        id: routeKey,
        label: routeKey,
        baseUrl: entry.upstream,
        api,
        auth,
        origin: 'seeded',
        seededFrom: routeKey,
        ...(defaultEffort ? { reasoningEffort: defaultEffort } : {}),
      })
      const declaredIds = new Set<string>()
      if (entry.harvest) {
        desiredModels.push(harvestedToModel(routeKey, entry.harvest))
        declaredIds.add(entry.harvest.id)
      }
      // Wildcard (OAuth) agents whose model list otherwise only grows
      // from observed traffic — pre-seed the well-known source-model ids
      // up front so the Routing UI can render per-source-model rows
      // before the first request flows. Idempotent: the (providerId, id)
      // dedupe in the mutateModelRegistry block below skips entries
      // already present (manual or seeded). The catalog backfill in the
      // self-heal step then refreshes their modality.
      const knownIds = knownSourceModelsFor(routeAgent(routeKey))
      if (knownIds && !entry.sourceModelId) {
        for (const id of knownIds) {
          const cat = lookupCatalogModel(id)
          desiredModels.push({
            id,
            providerId: routeKey,
            label: id,
            input: cat?.input ?? ['text'],
            origin: 'seeded',
          })
        }
      }
      if (HARVEST_ONLY_AGENTS.has(routeAgent(routeKey))) {
        harvestOnlyDesired.set(routeKey, declaredIds)
      }
      // Two intentional non-actions here:
      //   1) we do not flood from the bundled catalog — neither
      //      subscriptions nor API-key entitlements match the full
      //      catalog reliably.
      //   2) we do not call the provider's `/v1/models` — privacy
      //      contract bans unsolicited outbound calls.
      // For claude-code and codex `entry.models` is empty and stays
      // empty here; `noteObservedModel` grows their list as traffic
      // arrives. For openclaw/hermes the harvested list is treated as
      // authoritative — observation is filtered out for those agents.
    }
    // A transient routes-read failure must never wipe the registry: with
    // no desired providers there is nothing to seed and nothing to prune.
    if (desiredProviders.length === 0) return
    const desiredProviderIds = new Set(desiredProviders.map((p) => p.id))

    await mutateModelRegistry((reg) => {
      let changed = false
      const providers = [...reg.providers]
      for (const want of desiredProviders) {
        const existing = providers.find((p) => p.id === want.id)
        if (!existing) {
          providers.push(want)
          changed = true
        } else if (existing.origin === 'seeded') {
          // Backfill the reasoningEffort default when the existing seeded
          // entry was created before this field landed; a user override
          // (any value other than undefined) is preserved.
          const needsEffortBackfill =
            existing.reasoningEffort == null && want.reasoningEffort != null
          if (
            existing.baseUrl !== want.baseUrl ||
            existing.api !== want.api ||
            !sameAuth(existing.auth, want.auth) ||
            needsEffortBackfill
          ) {
            providers[providers.indexOf(existing)] = {
              ...existing,
              baseUrl: want.baseUrl,
              api: want.api,
              auth: want.auth,
              ...(needsEffortBackfill ? { reasoningEffort: want.reasoningEffort } : {}),
            }
            changed = true
          }
        }
      }

      const models = [...reg.models]
      for (const want of desiredModels) {
        // Match the (providerId, id) pair: the same model id can legitimately
        // exist under more than one provider, so finding by id alone would
        // skip seeding a harvest just because a different provider happens
        // to host a model with that name (e.g. hermes's Xiangxin-2XL-Chat
        // when the user has also added it manually under a custom provider).
        const existing = models.find((m) => m.id === want.id && m.providerId === want.providerId)
        if (!existing) {
          models.push(want)
          seen.add(want.id)
          changed = true
        } else if (existing.origin === 'seeded' && !sameModel(existing, want)) {
          // Preserve a model-level api override the user may have set.
          models[models.indexOf(existing)] = {
            ...want,
            ...(existing.api ? { api: existing.api } : {}),
          }
          changed = true
        }
      }

      // Self-heal: refresh every seeded model's modality from the bundled
      // catalog. Observed models are appended with a text-only guess (the
      // wire only reveals the model id); the catalog carries the real
      // capability. Manual models are the user's own — left untouched.
      for (let i = 0; i < models.length; i++) {
        const m = models[i]!
        if (m.origin !== 'seeded') continue
        const cat = lookupCatalogModel(m.id)
        if (!cat) continue
        const input = cat.input ?? m.input
        if (JSON.stringify(input) !== JSON.stringify(m.input)) {
          models[i] = { ...m, input }
          changed = true
        }
      }

      // Prune seeded providers whose wire route has vanished, plus the
      // seeded models orphaned by them. For harvest-only providers
      // (openclaw, hermes) we also drop seeded models not in the route's
      // declared `models[]` — that sweeps out the catalog-flood leftovers
      // and any model the user removed from openclaw's per-provider list.
      // Manual entries are untouched.
      const pruned = pruneVanishedSeeds(providers, models, desiredProviderIds, harvestOnlyDesired)
      if (pruned.pruned) changed = true

      // Re-sync the in-memory `seen` cache to the post-mutate registry.
      // Without this, a model id pruned out (catalog-flood leftover, or a
      // harvest-only provider's removed entry) would stay in `seen`
      // forever, and `noteObservedModel` would silently skip it the next
      // time the wire saw that model. The same desync hits if `seen` was
      // primed against a registry that has since been edited externally.
      seen.clear()
      for (const m of pruned.models) seen.add(m.id)

      return changed ? { ...reg, providers: pruned.providers, models: pruned.models } : undefined
    })
  } catch (err) {
    logger.warn(`routing: registry seeding failed — ${(err as Error).message}`)
  }
}

// ── note observed models ──────────────────────────────────────────

// Model ids already known (in the registry or queued for append). Guards the
// per-model_call hook so disk is touched at most once per distinct model.
const seen = new Set<string>()

/** Prime the seen-set from the registry so a restart doesn't re-scan. */
export async function primeObservedModels(): Promise<void> {
  try {
    const reg = await readModelRegistry()
    for (const m of reg.models) seen.add(m.id)
  } catch {
    // best-effort — an unprimed set just costs one redundant read per model
  }
}

/** Record a model id seen in captured traffic. Cheap and synchronous; the
 *  disk write (if any) is fired and forgotten. Safe to call on every call. */
export function noteObservedModel(agent: string, protocol: DecoderKind, modelId: string): void {
  if (modelId === '' || seen.has(modelId)) return
  if (HARVEST_ONLY_AGENTS.has(agent)) return
  seen.add(modelId)
  const api = decoderToApi(protocol)
  if (!api) return
  void appendObservedModel(agent, api, modelId).catch((err) => {
    logger.debug(`routing: observed-model append failed — ${(err as Error).message}`)
  })
}

async function appendObservedModel(agent: string, api: ModelApi, modelId: string): Promise<void> {
  await mutateModelRegistry((reg) => {
    if (reg.models.some((m) => m.id === modelId)) return undefined
    // Attach to the seeded provider for this agent's route on the matching
    // wire format; fall back to any provider that speaks that format.
    const provider =
      reg.providers.find(
        (p) => p.api === api && p.seededFrom != null && p.seededFrom.startsWith(`${agent}/`),
      ) ?? reg.providers.find((p) => p.api === api)
    if (!provider) return undefined
    // The wire only reveals the model id — fill real modality from the
    // bundled catalog, falling back to a text-only guess.
    const cat = lookupCatalogModel(modelId)
    const model: ModelEntry = {
      id: modelId,
      providerId: provider.id,
      label: modelId,
      input: cat?.input ?? ['text'],
      origin: 'seeded',
    }
    return { ...reg, models: [...reg.models, model] }
  })
}
