import { readFileSync, statSync } from 'node:fs'
import { PRICING_OVERRIDE } from '../../core/paths.ts'
import type { DecoderKind } from '../../core/routes.ts'
import { type CatalogCost, lookupCatalog, lookupCatalogAnyProvider } from './catalog.ts'

export type PricingEntry = {
  inputCostPerToken: number
  outputCostPerToken: number
  cacheReadCostPerToken?: number
  cacheWriteCostPerToken?: number
}

/**
 * Decoder → models.dev provider id. Used to scope catalog lookups so
 * "claude-sonnet" routes to the anthropic provider rather than e.g. an
 * openrouter mirror.
 */
const DECODER_PROVIDER: Partial<Record<DecoderKind, string>> = {
  anthropic: 'anthropic',
  'openai-chat': 'openai',
  'openai-responses': 'openai',
  gemini: 'google',
  bedrock: 'amazon-bedrock',
}

function catalogToEntry(c: CatalogCost): PricingEntry {
  // models.dev publishes USD per MILLION tokens. We need per token.
  const entry: PricingEntry = {
    inputCostPerToken: c.input / 1_000_000,
    outputCostPerToken: c.output / 1_000_000,
  }
  if (typeof c.cache_read === 'number') {
    entry.cacheReadCostPerToken = c.cache_read / 1_000_000
  }
  if (typeof c.cache_write === 'number') {
    entry.cacheWriteCostPerToken = c.cache_write / 1_000_000
  }
  return entry
}

// Embedded snapshot of Anthropic Claude pricing (USD per token). Checked
// against models.dev. Verify with `npm run refresh:pricing` (updates the
// bundled catalog) or enable `autoRefreshPricing`. These hand-rolled entries
// are consulted BEFORE the catalog, so keep them correct — a stale entry here
// silently shadows the fresher catalog via longest-prefix match.
//
// NOTE: Opus dropped from $15/$75 to $5/$25 (in/out) at 4.5. Entries for
// 4.5–4.8 carry the new price; 4.0/4.1 keep the legacy $15/$75. The bare
// `claude-opus-4` key is the 4.0 baseline (so dated 4.0 ids still resolve).
const ANTHROPIC: Record<string, PricingEntry> = {
  // Claude Opus 4.5+ — $5 / $25 per Mtok
  'claude-opus-4-8': {
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.000025,
    cacheReadCostPerToken: 0.0000005,
    cacheWriteCostPerToken: 0.00000625,
  },
  'claude-opus-4-7': {
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.000025,
    cacheReadCostPerToken: 0.0000005,
    cacheWriteCostPerToken: 0.00000625,
  },
  'claude-opus-4-6': {
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.000025,
    cacheReadCostPerToken: 0.0000005,
    cacheWriteCostPerToken: 0.00000625,
  },
  'claude-opus-4-5': {
    inputCostPerToken: 0.000005,
    outputCostPerToken: 0.000025,
    cacheReadCostPerToken: 0.0000005,
    cacheWriteCostPerToken: 0.00000625,
  },
  // Claude Opus 4.0 / 4.1 — legacy $15 / $75 per Mtok
  'claude-opus-4-1': {
    inputCostPerToken: 0.000015,
    outputCostPerToken: 0.000075,
    cacheReadCostPerToken: 0.0000015,
    cacheWriteCostPerToken: 0.00001875,
  },
  'claude-opus-4': {
    inputCostPerToken: 0.000015,
    outputCostPerToken: 0.000075,
    cacheReadCostPerToken: 0.0000015,
    cacheWriteCostPerToken: 0.00001875,
  },
  'claude-sonnet-4-6': {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheReadCostPerToken: 0.0000003,
    cacheWriteCostPerToken: 0.00000375,
  },
  'claude-sonnet-4-5': {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheReadCostPerToken: 0.0000003,
    cacheWriteCostPerToken: 0.00000375,
  },
  'claude-sonnet-4': {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheReadCostPerToken: 0.0000003,
    cacheWriteCostPerToken: 0.00000375,
  },
  'claude-haiku-4-5': {
    inputCostPerToken: 0.000001,
    outputCostPerToken: 0.000005,
    cacheReadCostPerToken: 0.0000001,
    cacheWriteCostPerToken: 0.00000125,
  },
  'claude-haiku-4': {
    inputCostPerToken: 0.000001,
    outputCostPerToken: 0.000005,
    cacheReadCostPerToken: 0.0000001,
    cacheWriteCostPerToken: 0.00000125,
  },
  // Claude 3.x legacy
  'claude-3-5-sonnet': {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheReadCostPerToken: 0.0000003,
    cacheWriteCostPerToken: 0.00000375,
  },
  'claude-3-5-haiku': {
    inputCostPerToken: 0.0000008,
    outputCostPerToken: 0.000004,
    cacheReadCostPerToken: 0.00000008,
    cacheWriteCostPerToken: 0.000001,
  },
  'claude-3-opus': {
    inputCostPerToken: 0.000015,
    outputCostPerToken: 0.000075,
    cacheReadCostPerToken: 0.0000015,
    cacheWriteCostPerToken: 0.00001875,
  },
}

// OpenAI public pricing (USD per token). Same caveat as ANTHROPIC.
const OPENAI: Record<string, PricingEntry> = {
  'gpt-4o': {
    inputCostPerToken: 0.0000025,
    outputCostPerToken: 0.00001,
    cacheReadCostPerToken: 0.00000125,
  },
  'gpt-4o-mini': {
    inputCostPerToken: 0.00000015,
    outputCostPerToken: 0.0000006,
    cacheReadCostPerToken: 0.000000075,
  },
  'gpt-4-turbo': {
    inputCostPerToken: 0.00001,
    outputCostPerToken: 0.00003,
  },
  'gpt-4': {
    inputCostPerToken: 0.00003,
    outputCostPerToken: 0.00006,
  },
  'gpt-3.5-turbo': {
    inputCostPerToken: 0.0000005,
    outputCostPerToken: 0.0000015,
  },
  'o1-preview': {
    inputCostPerToken: 0.000015,
    outputCostPerToken: 0.00006,
  },
  'o1-mini': {
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000012,
  },
}

type DecoderTable = Record<string, PricingEntry>
type UserPricing = Partial<Record<DecoderKind | 'any', DecoderTable>>

// why: cache the parsed user override and invalidate on mtime change so edits
// to ~/.agentfw/pricing.json are picked up without a daemon restart.
let userCache: { mtimeMs: number; data: UserPricing } | null = null

function loadUserPricing(): UserPricing {
  try {
    const st = statSync(PRICING_OVERRIDE)
    if (userCache && userCache.mtimeMs === st.mtimeMs) return userCache.data
    const raw = readFileSync(PRICING_OVERRIDE, 'utf8')
    const parsed = JSON.parse(raw) as UserPricing
    userCache = { mtimeMs: st.mtimeMs, data: parsed }
    return parsed
  } catch {
    userCache = null
    return {}
  }
}

function lookupIn(table: DecoderTable, model: string): PricingEntry | undefined {
  const exact = table[model]
  if (exact) return exact
  const stripped = model.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '')
  const stripMatch = table[stripped]
  if (stripMatch) return stripMatch
  const keys = Object.keys(table).sort((a, b) => b.length - a.length)
  for (const k of keys) {
    if (model.startsWith(k)) return table[k]
  }
  return undefined
}

export function pricingFor(decoder: DecoderKind, model: string): PricingEntry | undefined {
  if (!model) return undefined

  // 1. User override wins (per-decoder, then 'any').
  const user = loadUserPricing()
  const userScoped = user[decoder]
  if (userScoped) {
    const hit = lookupIn(userScoped, model)
    if (hit) return hit
  }
  const userAny = user.any
  if (userAny) {
    const hit = lookupIn(userAny, model)
    if (hit) return hit
  }

  // 2. Hand-rolled tables (kept around because models.dev occasionally
  // lags behind Anthropic / OpenAI release announcements — these
  // entries override the catalog when present).
  const hardcoded =
    decoder === 'anthropic'
      ? ANTHROPIC
      : decoder === 'openai-chat' || decoder === 'openai-responses'
        ? OPENAI
        : undefined
  if (hardcoded) {
    const hit = lookupIn(hardcoded, model)
    if (hit) return hit
  }

  // 3. models.dev catalog (bundled — 22 mainstream providers). Scope by
  // decoder when we have a mapping, otherwise scan all providers.
  const providerId = DECODER_PROVIDER[decoder]
  if (providerId) {
    const hit = lookupCatalog(providerId, model)
    if (hit) return catalogToEntry(hit)
  }
  // For openai-chat decoder against a non-OpenAI host (vLLM,
  // openrouter, groq, deepseek, …) the model id often matches another
  // provider entry. Fall through to a global scan.
  const global = lookupCatalogAnyProvider(model)
  if (global) return catalogToEntry(global)

  return undefined
}
