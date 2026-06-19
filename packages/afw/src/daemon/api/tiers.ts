// /api/tiers — the daemon side of the dashboard "Models" mapping and the
// `afw tier` CLI. afw exposes three fixed model names (Tall/Grande/Venti);
// here the user maps each to one of their configured models — a single model, a
// token-limit failover chain, or a Fusion combo. Reads/mutates
// ~/.afw/tiers.json (core/tiers.ts).

import type { Context } from 'hono'
import { findCombo, findModel, readModelRegistry } from '../../core/model-registry.ts'
import type { AgentRouting } from '../../core/routing-policy.ts'
import {
  TIERS,
  TIER_INFO,
  type Tier,
  mutateTiers,
  readTiers,
  tierForModelName,
} from '../../core/tiers.ts'
import { connectionInfo } from './keys.ts'
import { normalizeTargetInput } from './routing.ts'

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

/** Accept a tier id (`tall`) or any model-name alias (`Grande`, `grande`). */
function resolveTier(raw: unknown): Tier | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const s = raw.trim()
  if ((TIERS as readonly string[]).includes(s)) return s as Tier
  return tierForModelName(s)
}

/** Validate that a target references models/combos that exist. */
async function validateTarget(routing: AgentRouting): Promise<string | undefined> {
  const reg = await readModelRegistry()
  const { target } = routing
  if (target.kind === 'chain') {
    for (const m of target.members) {
      if (!findModel(reg, m.modelId, m.providerId)) {
        return `unknown ${m.providerId ? `model "${m.providerId}/${m.modelId}"` : `model "${m.modelId}"`}`
      }
    }
  }
  if (target.kind === 'composite' && !findCombo(reg, target.comboId)) {
    return `unknown combination model "${target.comboId}"`
  }
  if (target.kind === 'passthrough') {
    return 'a tier must map to a model, a failover chain, or a fusion combo'
  }
  return undefined
}

// ── GET /api/tiers ────────────────────────────────────────────────

export async function handleGetTiers(c: Context): Promise<Response> {
  const config = await readTiers()
  const tiers = TIERS.map((t) => ({
    tier: t,
    display: TIER_INFO[t].display,
    rank: TIER_INFO[t].rank,
    ...(config.tiers[t] ? { target: config.tiers[t]?.target } : {}),
  }))
  return c.json({ tiers, connection: connectionInfo() })
}

// ── POST /api/tiers ───────────────────────────────────────────────

export async function handlePostTier(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)
  const tier = resolveTier(body.tier)
  if (!tier) {
    return c.json({ error: `tier must be one of ${TIERS.join(', ')} (or a model name)` }, 400)
  }
  const target = normalizeTargetInput(body.target)
  if ('error' in target) return c.json({ error: target.error }, 400)
  const routing: AgentRouting = { target }
  const targetErr = await validateTarget(routing)
  if (targetErr) return c.json({ error: targetErr }, 400)

  const config = await mutateTiers((cfg) => ({
    ...cfg,
    tiers: { ...cfg.tiers, [tier]: routing },
  }))
  return c.json({ ok: true, tiers: config.tiers })
}

// ── DELETE /api/tiers?tier= ───────────────────────────────────────

export async function handleDeleteTier(c: Context): Promise<Response> {
  const tier = resolveTier(c.req.query('tier'))
  if (!tier) return c.json({ error: 'missing or unknown tier' }, 400)
  const config = await mutateTiers((cfg) => {
    if (!(tier in cfg.tiers)) return undefined
    const tiers = { ...cfg.tiers }
    delete tiers[tier]
    return { ...cfg, tiers }
  })
  return c.json({ ok: true, tiers: config.tiers })
}
