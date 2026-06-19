// The afw API-key endpoint — mounted at /v1/* (see daemon/server.ts). A
// generic OpenAI/Anthropic-compatible agent points its base URL here and sends
// an afw-issued token (Bearer or x-api-key) plus one of the three fixed
// model names (Tall / Grande / Venti — see core/tiers.ts). The token authenticates;
// the model name selects the tier; the tier's user-configured target decides
// which real model the call is routed to. Unlike /wire/<agent>/*, the agent
// name never appears in the URL.

import type { Context } from 'hono'
import {
  type AccessKeyEntry,
  findKeyByToken,
  mutateAccessKeys,
  readAccessKeys,
} from '../../core/access-keys.ts'
import { logger } from '../../core/logger.ts'
import type { DecoderKind } from '../../core/routes.ts'
import {
  type Tier,
  readTiers,
  tierForModelName,
  tierModelNames,
  tierRouting,
} from '../../core/tiers.ts'
import { tryOrchestrate } from '../orchestrator/index.ts'
import { getAccessKeys, getTiers } from '../routing/load.ts'

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Pull the presented token from the standard auth headers an OpenAI
 *  (`Authorization: Bearer`) or Anthropic (`x-api-key`) client sends. */
export function tokenFromHeaders(h: Headers): string {
  const auth = h.get('authorization')
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (m?.[1]) return m[1].trim()
  }
  return (h.get('x-api-key') ?? '').trim()
}

/** Map the request path to the inbound wire protocol the client speaks. */
export function decoderForPath(path: string): DecoderKind | undefined {
  if (path.endsWith('/chat/completions')) return 'openai-chat'
  if (path.endsWith('/responses')) return 'openai-responses'
  if (path.endsWith('/messages')) return 'anthropic'
  return undefined
}

/** Best-effort read of the top-level `model` from a JSON request body. */
function readBodyModel(body: ArrayBuffer | undefined): string {
  if (!body || body.byteLength === 0) return ''
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown
    if (parsed && typeof parsed === 'object') {
      const m = (parsed as Record<string, unknown>).model
      if (typeof m === 'string') return m
    }
  } catch {
    // not JSON
  }
  return ''
}

// Throttle lastUsedAt persistence so a busy key doesn't rewrite keys.json (and
// trip the config watcher's reload) on every single call. In-memory only.
const lastStampedAt = new Map<string, number>()
const STAMP_INTERVAL_MS = 60_000

function stampUsed(key: AccessKeyEntry): void {
  const now = Date.now()
  const prev = lastStampedAt.get(key.id) ?? 0
  if (now - prev < STAMP_INTERVAL_MS) return
  lastStampedAt.set(key.id, now)
  void mutateAccessKeys((store) => ({
    ...store,
    keys: store.keys.map((k) => (k.id === key.id ? { ...k, lastUsedAt: now } : k)),
  })).catch(() => {})
}

/** Synthesize the OpenAI-shaped model list a client may GET to populate its
 *  picker — the three fixed tier names. */
function modelsList(): Response {
  return new Response(
    JSON.stringify({
      object: 'list',
      data: tierModelNames().map((id) => ({ id, object: 'model', owned_by: 'afw' })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

export async function handleKeyRequest(c: Context): Promise<Response> {
  const req = c.req.raw
  const token = tokenFromHeaders(req.headers)
  if (!token) {
    return jsonError(401, 'afw: missing API key (send it as Authorization: Bearer or x-api-key)')
  }
  // Fast path: the hot in-memory cache (kept fresh by the config watcher). On a
  // miss, re-read keys.json once — a key minted moments ago may not have hit the
  // (debounced) watcher yet, and we don't want a just-created key to 401.
  let key = findKeyByToken(getAccessKeys(), token)
  if (!key) key = findKeyByToken(await readAccessKeys(), token)
  if (!key) return jsonError(401, 'afw: unknown API key')

  const restPath = new URL(c.req.url).pathname // already starts with /v1/…

  // Model-list discovery — answered locally, never routed upstream.
  if (req.method === 'GET' && restPath.endsWith('/models')) {
    stampUsed(key)
    return modelsList()
  }

  const decoder = decoderForPath(restPath)
  if (!decoder) {
    return jsonError(
      404,
      `afw: unsupported path "${restPath}" — use /v1/chat/completions, /v1/responses, or /v1/messages`,
    )
  }

  const reqBody = req.body ? await req.arrayBuffer() : undefined

  // Tier selection: the request's model name must be one of Tall / Grande / Venti.
  const requested = readBodyModel(reqBody)
  const tier: Tier | undefined = tierForModelName(requested)
  if (!tier) {
    return jsonError(
      400,
      `afw: unknown model "${requested}" — use one of ${tierModelNames().join(', ')}`,
    )
  }
  // Cache first; on a miss re-read from disk once so a tier mapped moments ago
  // (before the debounced watcher fired) isn't reported as unmapped.
  let routing = tierRouting(getTiers(), tier)
  if (!routing) routing = tierRouting(await readTiers(), tier)
  if (!routing) {
    return jsonError(
      400,
      `afw: the "${requested}" tier is not mapped to a model yet — set it with \`afw tier\` or the dashboard.`,
    )
  }

  // Attribute the call to the key's agent + the key id (so the dashboard
  // groups behaviour per key, which is per agent/session).
  const orchestrated = await tryOrchestrate({
    agent: key.agent,
    provider: requested,
    routeKey: `${key.agent}/${key.id}`,
    policyKey: `${key.agent}/${key.id}`,
    instanceId: key.id,
    decoder,
    reqMethod: req.method,
    restPath,
    reqHeaders: req.headers,
    reqBody,
    routingOverride: routing,
  })
  if (orchestrated) {
    stampUsed(key)
    return orchestrated
  }

  // The tier's target couldn't be executed (e.g. its model was deleted and it
  // collapsed to passthrough). There is no upstream to fall through to here.
  logger.warn(`keys: ${key.id} could not route ${requested}→${tier} (target unresolved)`)
  return jsonError(
    502,
    `afw: the "${requested}" tier is not bound to a usable model (its target may have been removed). Re-map it with \`afw tier\` or the dashboard.`,
  )
}
