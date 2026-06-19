// The three fixed model tiers — ~/.afw/tiers.json. afw exposes exactly
// three model names over its /v1 endpoint, named after Starbucks cup sizes from
// low to high: Tall, Grande, Venti. The user maps each tier to one of their
// configured models (a single model, a token-limit failover chain, or a Fusion
// combo). A request's `model` field selects the tier; the API key is only auth.
// Reuses the routing policy's AgentRouting so the orchestrator executes a tier
// exactly like any other route.

import { readFile } from 'node:fs/promises'
import { atomicWrite, fileExists } from './atomic-file.ts'
import { paths } from './paths.ts'
import { type AgentRouting, normalizeRouting } from './routing-policy.ts'

export const TIERS_VERSION = 1 as const

/** Internal tier ids, ordered low → high. */
export type Tier = 'tall' | 'grande' | 'venti'

export const TIERS: readonly Tier[] = ['tall', 'grande', 'venti'] as const

/** Display name (the canonical model name clients send) + accepted aliases.
 *  The Starbucks cup sizes are canonical; lowercase / size-word aliases are
 *  accepted too. Matching is case-insensitive (see tierForModelName). */
export const TIER_INFO: Record<Tier, { display: string; rank: number; aliases: string[] }> = {
  tall: { display: 'Tall', rank: 1, aliases: ['tall', 'small'] },
  grande: { display: 'Grande', rank: 2, aliases: ['grande', 'medium'] },
  venti: { display: 'Venti', rank: 3, aliases: ['venti', 'large'] },
}

/** The canonical model name (display) for a tier. */
export function tierDisplay(tier: Tier): string {
  return TIER_INFO[tier].display
}

/** The three canonical model names, low → high. */
export function tierModelNames(): string[] {
  return TIERS.map(tierDisplay)
}

const ALIAS_TO_TIER = new Map<string, Tier>()
for (const t of TIERS) {
  for (const a of TIER_INFO[t].aliases) ALIAS_TO_TIER.set(a.toLowerCase(), t)
}

/** Resolve a request's `model` field to a tier, or undefined when it isn't one
 *  of the three names (or their aliases). Case-insensitive; Chinese names match
 *  exactly. */
export function tierForModelName(name: string): Tier | undefined {
  return ALIAS_TO_TIER.get(name.trim().toLowerCase())
}

export type TierConfig = {
  version: typeof TIERS_VERSION
  /** Per-tier routing. A tier absent here is unmapped (requests for it 400). */
  tiers: Partial<Record<Tier, AgentRouting>>
}

export const EMPTY_TIERS: TierConfig = { version: TIERS_VERSION, tiers: {} }

export function tierRouting(config: TierConfig, tier: Tier): AgentRouting | undefined {
  return config.tiers[tier]
}

// ── parse / normalize ─────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function normalizeTiers(raw: unknown): TierConfig {
  if (!isObj(raw)) return { ...EMPTY_TIERS }
  if (raw.version !== TIERS_VERSION) {
    throw new Error(
      `tiers.json version ${String(raw.version)} not supported (expected ${TIERS_VERSION})`,
    )
  }
  const tiers: Partial<Record<Tier, AgentRouting>> = {}
  if (isObj(raw.tiers)) {
    for (const t of TIERS) {
      const routing = normalizeRouting(raw.tiers[t])
      // A passthrough target means "unmapped" — drop it so the proxy 400s with
      // a clear "configure this tier" message rather than silently falling
      // through to a non-existent upstream.
      if (routing && routing.target.kind !== 'passthrough') tiers[t] = routing
    }
  }
  return { version: TIERS_VERSION, tiers }
}

// ── read / write ──────────────────────────────────────────────────

export async function readTiers(): Promise<TierConfig> {
  if (!(await fileExists(paths.tiers))) return { ...EMPTY_TIERS }
  return normalizeTiers(JSON.parse(await readFile(paths.tiers, 'utf8')))
}

export async function writeTiers(config: TierConfig): Promise<void> {
  await atomicWrite(paths.tiers, `${JSON.stringify(config, null, 2)}\n`)
}

let writeChain: Promise<unknown> = Promise.resolve()

/** Serialized read-modify-write — see model-registry.ts mutateModelRegistry. */
export function mutateTiers(
  fn: (config: TierConfig) => TierConfig | undefined,
): Promise<TierConfig> {
  const next = writeChain.then(async () => {
    const config = await readTiers()
    const updated = fn(config)
    if (updated) await writeTiers(updated)
    return updated ?? config
  })
  writeChain = next.catch(() => {})
  return next
}
