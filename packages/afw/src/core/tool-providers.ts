// Tool providers — backends that fulfill capabilities the routed model
// can't provide itself. The first capability is `web_search`; future
// kinds will follow the same shape (`web_fetch`, `browser`, ...). Each
// provider names a backend (DuckDuckGo HTML, Brave API, SearXNG,
// Tavily) and the credentials / base URL it needs.
//
// Parallel in spirit to the model registry: providers are where a
// capability comes from, the registry of available "boxes" the user
// can point routing decisions at. The afw-tools MCP binary reads
// this file at request time to pick which backend executes a given
// tool call — so the user can swap backends without restarting the
// agent (Claude Desktop's MCP server stays running; only the next
// `web_search` call sees the new backend).

import { readFile } from 'node:fs/promises'
import { atomicWrite, fileExists } from './atomic-file.ts'
import { paths } from './paths.ts'

export const TOOL_PROVIDERS_VERSION = 1 as const

/** Capability fulfilled by this provider. One provider = one capability. */
export type ToolKind = 'web_search'

/** The concrete backend implementation. The MCP binary dispatches on
 *  this value when the provider is active. */
export type SearchBackend = 'duckduckgo' | 'brave' | 'searxng' | 'tavily' | 'baidu'

export type ToolProvider = {
  id: string
  label: string
  kind: ToolKind
  backend: SearchBackend
  /** SearXNG instance URL, or custom Brave/Tavily base — backend-defined. */
  baseUrl?: string
  /** Secrets ref (`tool-provider:<id>`) when the backend needs an API
   *  key. Absent for keyless backends (DuckDuckGo, public SearXNG). */
  authRef?: string
  /** USD per call. Optional — keyless backends (DuckDuckGo,
   *  self-hosted SearXNG) leave it absent / 0; paid backends like
   *  Baidu or Tavily set it so each captured tool_call action carries
   *  the right cost and the run rolls up properly. */
  costPerCall?: number
  /** `seeded` = bundled default (the built-in DDG entry); `manual` =
   *  user-added or user-modified. The seed step never overwrites a
   *  manual entry. */
  origin: 'seeded' | 'manual'
}

export type ToolProviders = {
  version: typeof TOOL_PROVIDERS_VERSION
  providers: ToolProvider[]
  /** Per-kind active provider id. Determines which provider the MCP
   *  binary uses for each capability. Absent → the first provider of
   *  that kind in `providers` (the seeded default) wins. */
  active: Partial<Record<ToolKind, string>>
}

/** Seeded default — a keyless DuckDuckGo backend so first-run users
 *  have a working `web_search` without any setup. Quality is mediocre
 *  vs Brave/Tavily but it costs nothing and never asks for an account. */
export const SEEDED_DDG: ToolProvider = {
  id: 'ddg',
  label: 'DuckDuckGo (built-in)',
  kind: 'web_search',
  backend: 'duckduckgo',
  origin: 'seeded',
}

export const EMPTY_STORE: ToolProviders = {
  version: TOOL_PROVIDERS_VERSION,
  providers: [SEEDED_DDG],
  active: {},
}

// ── parse / normalize ─────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const KINDS: ToolKind[] = ['web_search']
const BACKENDS: SearchBackend[] = ['duckduckgo', 'brave', 'searxng', 'tavily', 'baidu']

function normalizeProvider(raw: unknown): ToolProvider | undefined {
  if (!isObj(raw)) return undefined
  if (typeof raw.id !== 'string' || raw.id === '') return undefined
  if (!KINDS.includes(raw.kind as ToolKind)) return undefined
  if (!BACKENDS.includes(raw.backend as SearchBackend)) return undefined
  return {
    id: raw.id,
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : raw.id,
    kind: raw.kind as ToolKind,
    backend: raw.backend as SearchBackend,
    ...(typeof raw.baseUrl === 'string' && raw.baseUrl !== '' ? { baseUrl: raw.baseUrl } : {}),
    ...(typeof raw.authRef === 'string' && raw.authRef !== '' ? { authRef: raw.authRef } : {}),
    ...(typeof raw.costPerCall === 'number' && raw.costPerCall >= 0
      ? { costPerCall: raw.costPerCall }
      : {}),
    origin: raw.origin === 'manual' ? 'manual' : 'seeded',
  }
}

export function normalizeToolProviders(raw: unknown): ToolProviders {
  if (!isObj(raw)) return { ...EMPTY_STORE, providers: [SEEDED_DDG] }
  const providers = Array.isArray(raw.providers)
    ? raw.providers.map(normalizeProvider).filter((p): p is ToolProvider => p != null)
    : []
  // Always include the seeded DDG fallback if no DDG-equivalent entry exists
  // — the MCP binary should never be left without a working backend.
  if (!providers.some((p) => p.kind === 'web_search')) providers.push(SEEDED_DDG)

  const active: Partial<Record<ToolKind, string>> = {}
  if (isObj(raw.active)) {
    for (const k of KINDS) {
      const v = (raw.active as Record<string, unknown>)[k]
      if (typeof v === 'string' && v !== '') active[k] = v
    }
  }
  return { version: TOOL_PROVIDERS_VERSION, providers, active }
}

// ── read / write ──────────────────────────────────────────────────

export async function readToolProviders(): Promise<ToolProviders> {
  if (!(await fileExists(paths.toolProviders))) return { ...EMPTY_STORE, providers: [SEEDED_DDG] }
  return normalizeToolProviders(JSON.parse(await readFile(paths.toolProviders, 'utf8')))
}

export async function writeToolProviders(store: ToolProviders): Promise<void> {
  await atomicWrite(paths.toolProviders, `${JSON.stringify(store, null, 2)}\n`)
}

let writeChain: Promise<unknown> = Promise.resolve()

/** Serialized read-modify-write — see model-registry.ts mutateModelRegistry. */
export function mutateToolProviders(
  fn: (store: ToolProviders) => ToolProviders | undefined,
): Promise<ToolProviders> {
  const next = writeChain.then(async () => {
    const store = await readToolProviders()
    const updated = fn(store)
    if (updated) await writeToolProviders(updated)
    return updated ?? store
  })
  writeChain = next.catch(() => {})
  return next
}

// ── lookup helpers ────────────────────────────────────────────────

/** Active provider for a kind — explicit `active[kind]` wins, then
 *  the first provider of that kind, then undefined (caller falls back
 *  to "no backend, return an error to the tool caller"). */
export function activeProviderFor(store: ToolProviders, kind: ToolKind): ToolProvider | undefined {
  const explicit = store.active[kind]
  if (explicit) {
    const hit = store.providers.find((p) => p.id === explicit && p.kind === kind)
    if (hit) return hit
  }
  return store.providers.find((p) => p.kind === kind)
}
