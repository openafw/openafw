import type { Context } from 'hono'
import type { AgentId } from '../../core/agent.ts'
import { logger } from '../../core/logger.ts'
import { type RouteEntry, findRoute } from '../../core/routes.ts'
import { policyKeyFor } from '../../core/routing-policy.ts'
import { decoderFor } from '../decoders/index.ts'
import { applyAuth } from '../orchestrator/exec.ts'
import { tryOrchestrate } from '../orchestrator/index.ts'
import { getRoutes } from '../routes/load.ts'
import { authFromRoute } from '../routing/seed.ts'
import { maskRequestBody, restoreResponseStream } from './credential-mask.ts'
import { dynamicHeadersFor } from './dynamic-headers.ts'
import { filterRequestHeaders, filterResponseHeaders } from './forward.ts'
import { beginRequest, endRequest, trackStream } from './inflight.ts'
import { isClaudeDesktopModelsRequest, synthesizeClaudeDesktopModels } from './models-list.ts'

// The legacy virtual model id afw used to seed into agent configs
// (openclaw, hermes) before the new naming convention. Kept as a
// fallback short-circuit. New wraps use `afw-<agent>-<id>`.
const AFW_VIRTUAL_MODEL_ID = 'afw'

/** Best-effort: read the top-level `model` field from a JSON request
 *  body. Returns the empty string when the body isn't JSON or has no
 *  string-typed `model`. Used by the proxy to dispatch routes. */
function readBodyModel(body: ArrayBuffer | undefined): string | undefined {
  if (!body || body.byteLength === 0) return undefined
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const m = (parsed as Record<string, unknown>).model
      if (typeof m === 'string') return m
    }
  } catch {
    // not JSON — leave as undefined; caller falls back to wildcard
  }
  return undefined
}

/** Strip a trailing display suffix like `[1m]` from a model id. These are
 *  client-side UI markers (Claude Code's 1M-context variant shows as
 *  `claude-opus-4-8[1m]`) — they are NOT real API model ids, so forwarding
 *  one upstream is a guaranteed 404. The 1M context is enabled by the beta
 *  header the client already sends, not by the model id, so stripping the
 *  suffix is safe and preserves intent. Returns the id unchanged when there's
 *  no suffix (and never blanks the model). */
export function stripModelDisplaySuffix(model: string): string {
  const stripped = model.replace(/\s*\[[^\]]*\]\s*$/, '').trim()
  return stripped.length > 0 ? stripped : model
}

/** Rewrite `body.model` to the id the upstream actually accepts, before
 *  forwarding. Two cases:
 *   - wrap-style routes carry a afw-managed id (`afw-openclaw-main`)
 *     the upstream doesn't know → swap to the route's `sourceModelId`
 *     (the real model, e.g. `og-coding`);
 *   - any agent may send a virtual display id with a `[…]` suffix
 *     (`claude-opus-4-8[1m]`) → strip it so the upstream resolves the model.
 *  No-op when the resulting id equals what the body already carries. */
export function rewriteModelForUpstream(
  body: ArrayBuffer | undefined,
  route: RouteEntry,
): ArrayBuffer | undefined {
  if (!body || body.byteLength === 0) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return body // not JSON (e.g. multipart upload) — leave it alone
  }
  if (typeof parsed !== 'object' || parsed === null) return body
  const obj = parsed as Record<string, unknown>
  const current = typeof obj.model === 'string' ? obj.model : undefined
  // Route override wins; otherwise normalize away a display suffix.
  const next = route.sourceModelId ?? (current ? stripModelDisplaySuffix(current) : undefined)
  if (!next || next === current) return body
  obj.model = next
  const re = new TextEncoder().encode(JSON.stringify(obj))
  // Copy into a clean ArrayBuffer — fetch dislikes shared Uint8Array views.
  const out = new ArrayBuffer(re.byteLength)
  new Uint8Array(out).set(re)
  return out
}

/** Split a wire-path agent segment into its (bare agent, instance) parts. The
 *  segment optionally carries a per-instance suffix minted by `afw run`:
 *  `claude-code@worker-3` → `{ agent: 'claude-code', instanceId: 'worker-3' }`.
 *  The bare agent drives route-table lookup, decoder selection, and credentials
 *  (all type-level); the instance only narrows the routing-policy key and tags
 *  the capture. An empty suffix (`claude-code@`) yields no instance. */
export function splitWireAgent(rawAgent: string): { agent: AgentId; instanceId?: string } {
  const at = rawAgent.indexOf('@')
  if (at < 0) return { agent: rawAgent as AgentId }
  const instanceId = rawAgent.slice(at + 1) || undefined
  return { agent: rawAgent.slice(0, at) as AgentId, ...(instanceId ? { instanceId } : {}) }
}

export function restPathForWireRequest(pathname: string, rawAgent: string): string {
  const prefix = `/wire/${rawAgent}`
  return pathname.slice(prefix.length) || '/'
}

export async function handleWireRequest(c: Context): Promise<Response> {
  // The raw segment is what the URL path actually contains, so path-stripping
  // must use it; the split drives routing + capture.
  const rawAgent = c.req.param('agent')
  if (!rawAgent) {
    return new Response(JSON.stringify({ error: 'afw: malformed route' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }
  const { agent, instanceId } = splitWireAgent(rawAgent)

  const req = c.req.raw

  // Claude Desktop fetches /v1/models at launch to populate its model
  // picker. The picker only accepts claude-* IDs, so afw synthesizes
  // the list from the user's routing policy instead of proxying the
  // upstream's catalog. Must intercept BEFORE the route lookup — there
  // may be no route yet on first use, and we never want to proxy this
  // particular call upstream regardless.
  {
    const reqUrl = new URL(c.req.url)
    const restPath = restPathForWireRequest(reqUrl.pathname, rawAgent)
    if (req.method === 'GET' && isClaudeDesktopModelsRequest(agent, restPath)) {
      const body = await synthesizeClaudeDesktopModels()
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
  }

  // LLM request bodies are bounded; buffering is cheaper than streaming
  // gymnastics and lets the decoder see the prompt without re-reading.
  const reqBody = req.body ? await req.arrayBuffer() : undefined

  // Body-model dispatch: find route by `(agent, body.model)`, falling back
  // to the agent-wide wildcard. Wildcard matches when the body has no model
  // field or names something not specifically routed.
  const bodyModel = readBodyModel(reqBody) ?? ''
  const route = findRoute(getRoutes().routes, agent, bodyModel)
  if (!route) {
    const key = bodyModel ? `${agent}/${bodyModel}` : `${agent}/*`
    logger.warn(`proxy: no route for ${key}`)
    return new Response(JSON.stringify({ error: 'afw: no route registered', routeKey: key }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
  }
  const routeKey = route.sourceModelId ? `${agent}/${bodyModel}` : `${agent}/*`
  // The policy lookup is keyed by the *source* model (body.model), so a
  // wildcard route like `claude-code/*` can carry per-model overrides
  // — `claude-code/claude-opus-4-7` etc. routingFor falls back to the
  // wildcard when no exact entry exists. routeKey above is preserved
  // for capture/attribution (it pins to the seeded provider). When the
  // request carries an instance, the policy key narrows to it first
  // (`<agent>@<instance>/<model>`) with graceful fall-through to the
  // type-level key — see routingFor.
  const policyKey = policyKeyFor(agent, bodyModel, instanceId)

  // Strip /wire/<agent> to get the upstream-relative path.
  //
  // We deliberately do NOT use `new URL(restPath, base)` here: when restPath
  // starts with '/' (which it always does), URL() treats it as absolute and
  // throws away the path component of `base`. That silently corrupts
  // upstreams like "https://example.com/v1/gateway" into "https://example.com/…".
  // Manual string concat preserves the base path.
  const reqUrl = new URL(c.req.url)
  const restPath = restPathForWireRequest(reqUrl.pathname, rawAgent)
  const upstreamBase = route.upstream.replace(/\/$/, '')
  const restWithSlash = restPath.startsWith('/') ? restPath : `/${restPath}`
  const upstreamUrl = new URL(upstreamBase + restWithSlash + reqUrl.search)

  // Routing seam: when this route is configured to swap models, the
  // orchestrator owns the upstream call. Otherwise fall through to the
  // byte-identical passthrough path below.
  const orchestrated = await tryOrchestrate({
    agent,
    provider: bodyModel || '*',
    routeKey,
    policyKey,
    ...(instanceId ? { instanceId } : {}),
    decoder: route.decoder,
    reqMethod: req.method,
    restPath: restWithSlash,
    reqHeaders: req.headers,
    reqBody,
  })
  if (orchestrated) return orchestrated

  // Reverse the virtual-model handshake before the byte-for-byte forward:
  // `model: "afw"` in the body → the route's recorded original model id.
  const forwardBody = rewriteModelForUpstream(reqBody, route)

  // Credential masking: swap real secrets (API keys, wallet keys, …) for fixed
  // fakes before the body leaves the machine, so neither the model provider nor
  // any API relay ever sees them. Opt-in and scoped to the provider the user
  // enabled rules for — passthrough hits the seeded provider whose id IS the
  // routeKey. The real values are restored in the response stream below.
  const masked = maskRequestBody(forwardBody, routeKey)
  const sendBody = masked?.body ?? forwardBody

  const headers = filterRequestHeaders(req.headers, upstreamUrl.host)
  // afw-managed credentials: when wire captured an auth for this
  // route, inject afw's own copy (from secrets.json / OAuth store)
  // and drop whatever auth header the agent itself sent. The agent's
  // config can hold a placeholder — afw is the source of truth.
  // Routes with no captured auth fall back to byte-identical passthrough,
  // plus the codex-specific `chatgpt-account-id` injection.
  if (route.auth) {
    await applyAuth(headers, authFromRoute(routeKey, route.auth), routeKey)
  } else {
    const extra = await dynamicHeadersFor(agent)
    for (const [k, v] of Object.entries(extra)) headers.set(k, v)
  }

  // why: keep this debug log behind AFW_DEBUG_HEADERS=1 — it's
  // invaluable for diagnosing auth/upstream issues but we don't want
  // header values leaking into logs by default.
  if (process.env.AFW_DEBUG_HEADERS === '1') {
    const headerSummary: Record<string, string> = {}
    headers.forEach((v, k) => {
      const lk = k.toLowerCase()
      headerSummary[lk] =
        lk === 'authorization' || lk === 'cookie' ? `${v.slice(0, 16)}…<redacted>` : v
    })
    logger.info(
      `proxy debug: ${routeKey} → ${upstreamUrl.toString()} headers=${JSON.stringify(headerSummary)}`,
    )
  }

  const upstreamReq = new Request(upstreamUrl.toString(), {
    method: req.method,
    headers,
    body: sendBody,
  })

  const t0 = performance.now()
  // why: count this request as in-flight from just before the upstream
  // fetch until its response body is fully delivered. The update machinery
  // waits for the in-flight count to hit zero before restarting the daemon.
  beginRequest()
  let upstreamRes: Response
  try {
    upstreamRes = await fetch(upstreamReq)
  } catch (err) {
    endRequest()
    logger.error(`proxy: upstream fetch failed for ${routeKey}: ${(err as Error).message}`)
    return new Response(
      JSON.stringify({
        error: 'afw: upstream fetch failed',
        detail: (err as Error).message,
      }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )
  }

  const decoder = decoderFor(route.decoder)
  if (!decoder || !upstreamRes.body) {
    if (!upstreamRes.body) {
      endRequest()
      return new Response(null, {
        status: upstreamRes.status,
        headers: filterResponseHeaders(upstreamRes.headers),
      })
    }
    return new Response(trackStream(restoreResponseStream(upstreamRes.body, masked), endRequest), {
      status: upstreamRes.status,
      headers: filterResponseHeaders(upstreamRes.headers),
    })
  }

  // Tee the response body: one branch streams to the client, the other to the
  // decoder. Never block the client on decoding.
  const [toClient, toDecoder] = upstreamRes.body.tee()
  const upstreamHeaders = upstreamRes.headers

  void decoder
    .decode({
      agent,
      // decoder.decode's `provider` field is a label for capture only —
      // use the body model id (or '*' for wildcards) so the trace
      // database still has a per-request bucket.
      provider: bodyModel || '*',
      // Passthrough hits the seeded provider that mirrors this wired
      // route — its id IS the routeKey, by construction in seed.ts.
      // Naming the provider on the packet lets the UI render the
      // captured call as `provider/model`.
      providerId: routeKey,
      upstreamUrl: upstreamUrl.toString(),
      reqMethod: req.method,
      reqHeaders: req.headers,
      // Capture what actually went upstream — model field already
      // un-virtualised, credentials already masked — so the trace stores the
      // bytes the upstream saw and no real secret lands in the local DB. The
      // decoder gets the pre-swap model value as `clientModel`.
      reqBody: sendBody,
      clientModel: bodyModel || undefined,
      ...(instanceId ? { instanceId } : {}),
      resStatus: upstreamRes.status,
      resHeaders: upstreamHeaders,
      resBody: toDecoder,
      startedAt: t0,
      ...(masked?.edits.length ? { guardEdits: masked.edits } : {}),
    })
    .catch((err) => {
      logger.error(`decoder ${route.decoder} failed: ${(err as Error).message}`)
    })

  return new Response(trackStream(restoreResponseStream(toClient, masked), endRequest), {
    status: upstreamRes.status,
    headers: filterResponseHeaders(upstreamHeaders),
  })
}
