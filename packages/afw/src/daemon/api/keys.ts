// /api/keys — the daemon side of the dashboard "Keys" view and the
// `afw key` CLI. afw API keys are auth tokens: they let an
// OpenAI/Anthropic-compatible agent reach the /v1 endpoint. The request's model
// name (one of the three tiers — see /api/tiers) selects the real model, not the
// key. Reads/mutates ~/.afw/keys.json (core/access-keys.ts).

import type { Context } from 'hono'
import {
  type AccessKeyEntry,
  DEFAULT_AGENT,
  deriveKeyId,
  findKeyByAgentInstance,
  generateToken,
  mutateAccessKeys,
  readAccessKeys,
} from '../../core/access-keys.ts'
import { DAEMON_BASE_URL, DAEMON_PORT } from '../../core/paths.ts'
import { TIERS, TIER_INFO } from '../../core/tiers.ts'

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

/** The connection details a client needs, returned alongside keys/tiers so the
 *  UI/CLI can render a copy-paste block. The OpenAI base URL ends in `/v1`;
 *  Anthropic clients use the bare host and let their SDK re-add `/v1`. The model
 *  names are the three fixed tiers. */
export function connectionInfo(): {
  baseUrl: string
  anthropicBaseUrl: string
  port: number
  modelNames: Array<{ tier: string; name: string; rank: number }>
} {
  return {
    baseUrl: `${DAEMON_BASE_URL}/v1`,
    anthropicBaseUrl: DAEMON_BASE_URL,
    port: DAEMON_PORT,
    modelNames: TIERS.map((t) => ({
      tier: t,
      name: TIER_INFO[t].display,
      rank: TIER_INFO[t].rank,
    })),
  }
}

// ── GET /api/keys[?agent=] ────────────────────────────────────────

export async function handleGetKeys(c: Context): Promise<Response> {
  const store = await readAccessKeys()
  const agent = c.req.query('agent')
  const keys = agent ? store.keys.filter((k) => k.agent === agent) : store.keys
  return c.json({ keys, connection: connectionInfo() })
}

// ── POST /api/keys ────────────────────────────────────────────────
//
// Body: { label?, agent?, instance? }. When `instance` names an existing
// (agent, instance) session key, that key is returned unchanged (idempotent) —
// this is how `afw claude` / `codex` auto-mint at most one key per directory.

export async function handlePostKey(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  if (!body) return c.json({ error: 'malformed JSON body' }, 400)
  const agent =
    typeof body.agent === 'string' && body.agent.trim() !== '' ? body.agent.trim() : DEFAULT_AGENT
  const instance =
    typeof body.instance === 'string' && body.instance.trim() !== ''
      ? body.instance.trim()
      : undefined
  const label =
    typeof body.label === 'string' && body.label.trim() !== ''
      ? body.label.trim()
      : (instance ?? agent)

  const store0 = await readAccessKeys()
  if (instance) {
    const existing = findKeyByAgentInstance(store0, agent, instance)
    if (existing) {
      return c.json({ ok: true, key: existing, created: false, connection: connectionInfo() })
    }
  }

  const entry: AccessKeyEntry = {
    id: deriveKeyId(
      label,
      store0.keys.map((k) => k.id),
    ),
    label,
    token: generateToken(store0.keys.map((k) => k.token)),
    agent,
    ...(instance ? { instance } : {}),
    createdAt: Date.now(),
  }
  const store = await mutateAccessKeys((s) => ({ ...s, keys: [...s.keys, entry] }))
  return c.json({
    ok: true,
    key: entry,
    created: true,
    keys: store.keys,
    connection: connectionInfo(),
  })
}

// ── DELETE /api/keys?id= ──────────────────────────────────────────

export async function handleDeleteKey(c: Context): Promise<Response> {
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'missing id' }, 400)
  const store = await mutateAccessKeys((s) => {
    if (!s.keys.some((k) => k.id === id)) return undefined
    return { ...s, keys: s.keys.filter((k) => k.id !== id) }
  })
  return c.json({ ok: true, keys: store.keys })
}
