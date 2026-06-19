// /api/tool-providers — the daemon side of the Control · Tool Providers
// UI and the `afw tool` CLI. Reads and mutates tool-providers.json
// (which the afw-tools MCP binary also reads at request time, so
// changes here take effect on the next tool call without restarting
// the agent).
//
// Secrets follow the same write-only pattern as model providers: the
// UI sends an API key in, but only ever gets back the set of refs that
// exist — never a value.

import type { Context } from 'hono'
import { readSecrets, removeSecret, secretRefs, setSecret } from '../../core/secrets.ts'
import {
  type SearchBackend,
  type ToolKind,
  type ToolProvider,
  mutateToolProviders,
  readToolProviders,
} from '../../core/tool-providers.ts'

const BACKENDS: SearchBackend[] = ['duckduckgo', 'brave', 'searxng', 'tavily', 'baidu']
const KINDS: ToolKind[] = ['web_search']
const KEYED_BACKENDS = new Set<SearchBackend>(['brave', 'tavily', 'baidu'])

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

// ── GET /api/tool-providers ───────────────────────────────────────

export async function handleGetToolProviders(c: Context): Promise<Response> {
  const store = await readToolProviders()
  const secrets = await readSecrets()
  return c.json({
    providers: store.providers,
    active: store.active,
    secretRefs: secretRefs(secrets),
  })
}

// ── POST /api/tool-providers ──────────────────────────────────────

/** Upsert a tool provider. For keyed backends (brave, tavily) the key
 *  is persisted under `tool-provider:<id>`; the provider entry stores
 *  only the ref. Editing without re-typing the key keeps the existing
 *  secret untouched (parity with the model-provider POST). */
export async function handlePostToolProvider(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)

  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (!id) return c.json({ error: 'id required' }, 400)
  if (!KINDS.includes(body.kind as ToolKind)) {
    return c.json({ error: `kind must be one of ${KINDS.join(', ')}` }, 400)
  }
  if (!BACKENDS.includes(body.backend as SearchBackend)) {
    return c.json({ error: `backend must be one of ${BACKENDS.join(', ')}` }, 400)
  }
  const backend = body.backend as SearchBackend

  let authRef: string | undefined
  if (KEYED_BACKENDS.has(backend)) {
    const valueRef = `tool-provider:${id}`
    if (typeof body.apiKey === 'string' && body.apiKey !== '') {
      await setSecret(valueRef, body.apiKey)
    }
    authRef = valueRef
  }

  const provider: ToolProvider = {
    id,
    label: typeof body.label === 'string' && body.label !== '' ? body.label : id,
    kind: body.kind as ToolKind,
    backend,
    ...(typeof body.baseUrl === 'string' && body.baseUrl !== '' ? { baseUrl: body.baseUrl } : {}),
    ...(authRef ? { authRef } : {}),
    ...(typeof body.costPerCall === 'number' && body.costPerCall >= 0
      ? { costPerCall: body.costPerCall }
      : {}),
    origin: 'manual',
  }

  const store = await mutateToolProviders((s) => ({
    ...s,
    providers: [...s.providers.filter((p) => p.id !== id), provider],
  }))
  return c.json({ ok: true, providers: store.providers })
}

// ── DELETE /api/tool-providers?id= ────────────────────────────────

export async function handleDeleteToolProvider(c: Context): Promise<Response> {
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'missing id' }, 400)
  const store = await mutateToolProviders((s) => {
    const providers = s.providers.filter((p) => p.id !== id)
    // Clear `active` pointer if it referenced the deleted provider —
    // otherwise activeProviderFor would silently fall back to the
    // first remaining provider of the same kind, which can mask intent.
    const active = { ...s.active }
    for (const k of KINDS) if (active[k] === id) delete active[k]
    return { ...s, providers, active }
  })
  await removeSecret(`tool-provider:${id}`)
  return c.json({ ok: true, providers: store.providers, active: store.active })
}

// ── POST /api/tool-providers/active ───────────────────────────────

/** Set which provider id is "active" for a given kind. The MCP binary
 *  reads this to decide which backend handles the next call. */
export async function handlePostActiveToolProvider(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)
  const kind = body.kind
  if (!KINDS.includes(kind as ToolKind)) {
    return c.json({ error: `kind must be one of ${KINDS.join(', ')}` }, 400)
  }
  const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : ''
  const store = await mutateToolProviders((s) => {
    const active = { ...s.active }
    if (providerId === '') {
      delete active[kind as ToolKind]
    } else {
      const exists = s.providers.some((p) => p.id === providerId && p.kind === kind)
      if (!exists) return undefined
      active[kind as ToolKind] = providerId
    }
    return { ...s, active }
  })
  return c.json({ ok: true, active: store.active })
}
