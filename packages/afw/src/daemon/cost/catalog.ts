// Bundled pricing catalog. Sourced from https://models.dev/api.json
// (community-maintained). Refresh with: `npm run refresh:pricing` in
// the afw package (run by maintainer at release time). Trimmed to
// providers afw users actually hit; full catalog is ~2 MB.
//
// The cost numbers in catalog.json are USD per MILLION tokens (the
// models.dev convention). Helpers in this file convert to USD per
// token for compute.ts.

import { readFileSync, statSync } from 'node:fs'
import type { Modality } from '../../core/model-registry.ts'
import { PRICING_CATALOG_CACHE } from '../../core/paths.ts'
import catalog from './catalog.json' with { type: 'json' }

export type CatalogCost = {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}

export type CatalogModel = {
  id: string
  family: string | null
  cost: CatalogCost
  /** Input modalities from models.dev — absent for models it doesn't list. */
  input?: Modality[]
}

export type CatalogProvider = {
  id: string
  name: string
  models: CatalogModel[]
}

export const CATALOG: CatalogProvider[] = catalog as CatalogProvider[]

const BUNDLED_BY_PROVIDER = new Map<string, CatalogProvider>()
for (const p of CATALOG) BUNDLED_BY_PROVIDER.set(p.id, p)

// Runtime overlay: when the opt-in auto-refresh has written a fresher catalog
// to ~/.afw/pricing-catalog.json, it takes precedence over the bundled
// one. mtime-cached so we don't re-read/parse on every cost lookup.
let overlayCache: { mtimeMs: number; byProvider: Map<string, CatalogProvider> } | null = null

function overlayByProvider(): Map<string, CatalogProvider> | null {
  try {
    const st = statSync(PRICING_CATALOG_CACHE)
    if (overlayCache && overlayCache.mtimeMs === st.mtimeMs) return overlayCache.byProvider
    const parsed = JSON.parse(readFileSync(PRICING_CATALOG_CACHE, 'utf8')) as CatalogProvider[]
    const map = new Map<string, CatalogProvider>()
    for (const p of parsed) map.set(p.id, p)
    overlayCache = { mtimeMs: st.mtimeMs, byProvider: map }
    return map
  } catch {
    overlayCache = null
    return null
  }
}

/** All providers, overlay merged over bundled (overlay wins per id). */
function allProviders(): CatalogProvider[] {
  const overlay = overlayByProvider()
  if (!overlay) return CATALOG
  const merged = new Map(BUNDLED_BY_PROVIDER)
  for (const [id, p] of overlay) merged.set(id, p)
  return [...merged.values()]
}

function providerById(id: string): CatalogProvider | undefined {
  return overlayByProvider()?.get(id) ?? BUNDLED_BY_PROVIDER.get(id)
}

/**
 * Find a pricing entry for a (provider, model) pair. Tries:
 *   1. Exact model id match within the named provider.
 *   2. Date-suffix stripped (e.g. claude-opus-4-5-20251205 → claude-opus-4-5).
 *   3. Longest-prefix match within the provider.
 *
 * Returns undefined if no match — caller should fall back to user
 * pricing.json overrides or skip cost computation.
 */
export function lookupCatalog(providerId: string, modelId: string): CatalogCost | undefined {
  if (!modelId) return undefined
  const provider = providerById(providerId)
  if (!provider) return undefined
  return matchModel(provider, modelId)?.cost
}

/**
 * Same as lookupCatalog but scans all providers when the explicit one
 * doesn't match. Useful for OpenAI-compatible decoders where the model
 * id (e.g. "claude-opus-4-5") may belong to anthropic, openrouter,
 * fireworks, etc. — the user could be hitting any of them.
 */
export function lookupCatalogAnyProvider(modelId: string): CatalogCost | undefined {
  return lookupCatalogModel(modelId)?.cost
}

/**
 * Find a model's full catalog entry (cost + input modalities) by id,
 * scanning every provider. Used by the model registry to seed real
 * capabilities instead of defaulting observed models to text-only.
 */
export function lookupCatalogModel(modelId: string): CatalogModel | undefined {
  if (!modelId) return undefined
  for (const provider of allProviders()) {
    const hit = matchModel(provider, modelId)
    if (hit) return hit
  }
  return undefined
}

function matchModel(provider: CatalogProvider, modelId: string): CatalogModel | undefined {
  // Exact
  for (const m of provider.models) {
    if (m.id === modelId) return m
  }
  // Strip trailing date suffix
  const stripped = modelId.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '')
  if (stripped !== modelId) {
    for (const m of provider.models) {
      if (m.id === stripped) return m
    }
  }
  // Longest-prefix
  const ranked = [...provider.models].sort((a, b) => b.id.length - a.id.length)
  for (const m of ranked) {
    if (modelId.startsWith(m.id)) return m
  }
  return undefined
}
