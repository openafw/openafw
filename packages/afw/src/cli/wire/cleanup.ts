// Symmetric cleanup for `afw unwire`. Wire writes to five state stores
// — manifest, routes.json, secrets.json, models.json (seeded), and
// (transitively, via the user) routing.json. Unwire reverts the agent's
// own config + manifest entries; this module handles the rest.
//
// Two variants:
//   • tombstoneAgentWireState — default `afw unwire` path (daemon stays
//     up). Marks routes tombstoned (proxy still serves them so live agent
//     processes can keep proxying through afw until they restart),
//     prunes the registry / routing-policy entries as if the routes were
//     gone, and **removes the captured secrets** so afw no longer
//     holds the agent's credential. Live processes will fail upstream
//     after the next restart anyway (their config is now restored); we
//     prefer that small window of broken passthrough over leaving stale
//     credentials in `~/.afw/secrets.json`.
//   • cleanupAgentWireState — `afw unwire --stop-daemon` path. Hard-
//     deletes routes + secrets + the seeded registry rows + dead routing
//     rules. The daemon is going away; nothing live can be using them.
//
// The contract for the hard-delete path is "wire-authored entries only":
//   • routes.json keys with prefix "<agent>/" — wire-authored, all removed.
//   • secrets.json refs "provider:<routeKey>" for those keys — wire-captured,
//     useless without the route, all removed.
//   • models.json providers with origin='seeded' for the removed routes
//     (and their orphaned seeded models) — pruned via the same logic
//     `seedFromRoutes` uses at daemon startup. Manual entries are untouched.
//   • routing.json agent entries keyed on the removed routes — strictly the
//     user's own configuration, NOT wire-authored, but a swap rule that
//     points at a dead route is dead noise. We drop those entries (= same
//     as `afw route set <key> --passthrough`).

import { logger } from '../../core/logger.ts'
import {
  type ModelEntry,
  type ProviderEntry,
  mutateModelRegistry,
} from '../../core/model-registry.ts'
import { mutateRoutingPolicy } from '../../core/routing-policy.ts'
import { readSecrets, removeSecret } from '../../core/secrets.ts'
import { pruneVanishedSeeds } from '../../daemon/routing/seed.ts'
import { readRoutes, removeRoutes, writeRoutes } from './routes.ts'

export type CleanupReport = {
  routes: string[]
  secrets: string[]
  providers: string[]
  models: string[]
  routings: string[]
}

const EMPTY: CleanupReport = {
  routes: [],
  secrets: [],
  providers: [],
  models: [],
  routings: [],
}

/** Soft variant for the default `afw unwire` path (daemon stays up).
 *  Marks the agent's routes tombstoned instead of deleting them, so any
 *  already-running agent process can keep proxying through afw until
 *  it restarts. Registry seeds and routing-policy swap rules referencing
 *  those routes are pruned as if the routes had vanished — this is what
 *  hides the agent's providers and models from the Routing UI. Captured
 *  secrets are also deleted — afw should not hold an unwired agent's
 *  credential, even if a live process could still use it.
 *  Idempotent: re-tombstoning a tombstoned route is a no-op. */
export async function tombstoneAgentWireState(agent: string): Promise<CleanupReport> {
  const report: CleanupReport = {
    ...EMPTY,
    routes: [],
    secrets: [],
    providers: [],
    models: [],
    routings: [],
  }

  const existing = await readRoutes()
  const toTombstone = Object.keys(existing.routes).filter((k) => k.startsWith(`${agent}/`))
  if (toTombstone.length === 0) return report
  // Mark every <agent>/* key tombstoned in a single write. The fs-watcher
  // will fire `seedFromRoutes`, which now skips tombstoned routes and
  // prunes the registry — but we also prune explicitly below to cover the
  // case where ALL routes end up tombstoned (seedFromRoutes' transient-
  // failure guard would otherwise skip pruning).
  const next = { ...existing, routes: { ...existing.routes } }
  let changed = false
  for (const key of toTombstone) {
    const e = next.routes[key]
    if (!e || e.tombstoned) continue
    next.routes[key] = { ...e, tombstoned: true }
    changed = true
  }
  if (changed) await writeRoutes(next)
  report.routes = toTombstone

  // Drop the captured secrets for these routes. `provider:<routeKey>` is
  // the only ref shape wire captures. Check existence first so the report
  // only lists refs we actually deleted.
  const existingSecrets = await readSecrets()
  for (const key of toTombstone) {
    const ref = `provider:${key}`
    if (!(ref in existingSecrets.secrets)) continue
    await removeSecret(ref)
    report.secrets.push(ref)
  }

  // Treat tombstoned routes as vanished for registry-pruning purposes.
  const surviving = new Set(
    Object.entries(next.routes)
      .filter(([, v]) => !v.tombstoned)
      .map(([k]) => k),
  )

  await mutateModelRegistry((reg) => {
    const pruned = pruneVanishedSeeds(reg.providers, reg.models, surviving)
    if (!pruned.pruned) return undefined
    const keptProvIds = new Set(pruned.providers.map((p: ProviderEntry) => p.id))
    const keptModelIds = new Set(pruned.models.map((m: ModelEntry) => m.id))
    report.providers = reg.providers.filter((p) => !keptProvIds.has(p.id)).map((p) => p.id)
    report.models = reg.models.filter((m) => !keptModelIds.has(m.id)).map((m) => m.id)
    return { ...reg, providers: pruned.providers, models: pruned.models }
  })

  await mutateRoutingPolicy((policy) => {
    const nextAgents: Record<string, (typeof policy.agents)[string]> = {}
    const removed: string[] = []
    for (const [k, v] of Object.entries(policy.agents)) {
      if (toTombstone.includes(k)) removed.push(k)
      else nextAgents[k] = v
    }
    if (removed.length === 0) return undefined
    report.routings = removed
    return { ...policy, agents: nextAgents }
  })

  return report
}

/** Drop every wire-authored state row for `agent`. Idempotent: a second
 *  call with the same agent is a no-op and returns an empty report. */
export async function cleanupAgentWireState(agent: string): Promise<CleanupReport> {
  const report: CleanupReport = {
    ...EMPTY,
    routes: [],
    secrets: [],
    providers: [],
    models: [],
    routings: [],
  }

  // 1. routes.json — collect this agent's route keys, remove them, and
  //    derive the survivor set so the registry prune knows what stays.
  const existing = await readRoutes()
  const toRemove = Object.keys(existing.routes).filter((k) => k.startsWith(`${agent}/`))
  if (toRemove.length === 0) return report
  await removeRoutes(toRemove)
  report.routes = toRemove
  const surviving = new Set(Object.keys(existing.routes).filter((k) => !toRemove.includes(k)))

  // 2. secrets.json — `provider:<routeKey>` is the only ref shape wire
  //    captures. Check existence first so the report only lists refs we
  //    actually deleted (removeSecret is a no-op on absent refs, but we
  //    don't want to claim a deletion we didn't perform).
  const existingSecrets = await readSecrets()
  for (const key of toRemove) {
    const ref = `provider:${key}`
    if (!(ref in existingSecrets.secrets)) continue
    await removeSecret(ref)
    report.secrets.push(ref)
  }

  // 3. models.json — explicit prune. `seedFromRoutes` skips when no
  //    routes survive (its transient-failure guard), so we can't rely on
  //    it to clean the last agent. Pass the survivor set directly.
  await mutateModelRegistry((reg) => {
    const pruned = pruneVanishedSeeds(reg.providers, reg.models, surviving)
    if (!pruned.pruned) return undefined
    // Surface the actual ids we dropped so the report is honest.
    const keptProvIds = new Set(pruned.providers.map((p: ProviderEntry) => p.id))
    const keptModelIds = new Set(pruned.models.map((m: ModelEntry) => m.id))
    report.providers = reg.providers.filter((p) => !keptProvIds.has(p.id)).map((p) => p.id)
    report.models = reg.models.filter((m) => !keptModelIds.has(m.id)).map((m) => m.id)
    return { ...reg, providers: pruned.providers, models: pruned.models }
  })

  // 4. routing.json — drop user swap rules pointing at dead routes.
  //    Strategies (which are not keyed by routeKey) are untouched.
  await mutateRoutingPolicy((policy) => {
    const next: Record<string, (typeof policy.agents)[string]> = {}
    const removed: string[] = []
    for (const [k, v] of Object.entries(policy.agents)) {
      if (toRemove.includes(k)) removed.push(k)
      else next[k] = v
    }
    if (removed.length === 0) return undefined
    report.routings = removed
    return { ...policy, agents: next }
  })

  return report
}

/** Pretty-print the cleanup summary as logger lines. Caller passes the
 *  per-agent indent string used elsewhere in the unwire output. */
export function logCleanup(agent: string, r: CleanupReport, indent = '      '): void {
  const parts: string[] = []
  if (r.routes.length > 0) parts.push(`${r.routes.length} route(s)`)
  if (r.providers.length > 0) parts.push(`${r.providers.length} provider(s)`)
  if (r.models.length > 0) parts.push(`${r.models.length} model(s)`)
  if (r.secrets.length > 0) parts.push(`${r.secrets.length} secret(s)`)
  if (r.routings.length > 0) parts.push(`${r.routings.length} routing rule(s)`)
  if (parts.length === 0) return
  logger.print(`${indent}ⓘ ${agent} cleaned: ${parts.join(', ')}`)
}
