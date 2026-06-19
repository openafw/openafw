// HTTP/SSE MCP relay. `afw wire` repoints an http/sse MCP server's `url` at
// `/wire-mcp/<agent>/<server>` here; this forwards faithfully to the real
// upstream (stored in routes.json) and tees every JSON-RPC frame into the same
// capture pipeline the stdio tap uses.
//
// Two rules, because this sits in the agent's tool path:
//   1. Forwarding is transparent — status, headers and the response stream are
//      passed through unchanged.
//   2. Capture is strictly fire-and-forget — a parse/ingest failure logs and is
//      dropped; it never blocks or breaks the proxied call.
//
// Coverage: Streamable-HTTP (single POST endpoint, JSON or SSE response) is
// fully captured. Legacy HTTP+SSE is captured on the server→client SSE stream;
// its client→server POSTs go to an absolute `endpoint` the server advertises,
// which the agent resolves against our origin and may not route back through
// this prefix — a documented partial-capture limitation.

import type { Context } from 'hono'
import { logger } from '../../core/logger.ts'
import { exactRouteKey } from '../../core/routes.ts'
import { filterRequestHeaders, filterResponseHeaders } from '../proxy/forward.ts'
import { beginRequest, endRequest, trackStream } from '../proxy/inflight.ts'
import { getRoutes } from '../routes/load.ts'
import { type McpTransport, ingestMcpFrame } from './ingest.ts'

/** Route key for an MCP server: `<agent>/mcp/<server>`. */
export function mcpRouteKey(agent: string, server: string): string {
  return exactRouteKey(agent, `mcp/${server}`)
}

export async function handleMcpRelay(c: Context): Promise<Response> {
  const agent = c.req.param('agent')
  const server = c.req.param('server')
  if (!agent || !server) return c.text('bad mcp relay path', 400)

  const route = getRoutes().routes[mcpRouteKey(agent, server)]
  if (!route?.upstream) {
    return c.text(`no MCP route for ${agent}/${server} — re-run \`afw wire\``, 502)
  }

  const reqUrl = new URL(c.req.url)
  const prefix = `/wire-mcp/${agent}/${server}`
  const rest = reqUrl.pathname.slice(prefix.length) // '' or '/sub/path'
  // Concatenate as strings — do NOT new URL(rest, base): an absolute rest
  // would clobber the upstream's own path (CLAUDE.md path-routing gotcha).
  const upstreamUrl = route.upstream.replace(/\/$/, '') + rest + reqUrl.search
  const upstreamHost = safeHost(upstreamUrl)

  const method = c.req.method
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const reqBody = hasBody ? new Uint8Array(await c.req.arrayBuffer()) : undefined

  // Capture the client→server request frame (fire-and-forget).
  if (reqBody && reqBody.length > 0) {
    captureJson(reqBody, { agent, server, transport: 'http', direction: 'request' })
  }

  let upstreamRes: Response
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method,
      headers: filterRequestHeaders(c.req.raw.headers, upstreamHost),
      body: reqBody,
      duplex: 'half',
      redirect: 'manual',
    } as RequestInit & { duplex: 'half' })
  } catch (err) {
    logger.warn(`mcp-relay: upstream fetch failed (${agent}/${server}): ${(err as Error).message}`)
    return c.text('mcp upstream unreachable', 502)
  }

  const headers = filterResponseHeaders(upstreamRes.headers)
  const contentType = upstreamRes.headers.get('content-type') ?? ''

  if (!upstreamRes.body) {
    return new Response(null, { status: upstreamRes.status, headers })
  }

  const [toClient, toCapture] = upstreamRes.body.tee()

  // Capture the server→client response frames off the tee'd branch.
  const transport: McpTransport = contentType.includes('text/event-stream') ? 'sse' : 'http'
  void captureResponse(toCapture, contentType, { agent, server, transport }).catch((err) =>
    logger.debug(`mcp-relay: capture failed (${agent}/${server}): ${(err as Error).message}`),
  )

  beginRequest()
  return new Response(trackStream(toClient, endRequest), {
    status: upstreamRes.status,
    headers,
  })
}

// ── capture helpers (never throw into the forwarding path) ──────────

function captureJson(
  bytes: Uint8Array,
  meta: {
    agent: string
    server: string
    transport: McpTransport
    direction: 'request' | 'response'
  },
): void {
  try {
    const frame = JSON.parse(new TextDecoder().decode(bytes))
    void ingestMcpFrame({ ...meta, frame, ts: Date.now() }).catch(() => {})
  } catch {
    // Non-JSON body (not a JSON-RPC frame) — nothing to capture.
  }
}

async function captureResponse(
  stream: ReadableStream<Uint8Array>,
  contentType: string,
  meta: { agent: string; server: string; transport: McpTransport },
): Promise<void> {
  const text = await collectText(stream)
  if (contentType.includes('text/event-stream')) {
    for (const frame of parseSseFrames(text)) {
      void ingestMcpFrame({
        ...meta,
        direction: 'response',
        frame,
        ts: Date.now(),
      }).catch(() => {})
    }
    return
  }
  if (contentType.includes('application/json') || text.trim().startsWith('{')) {
    try {
      const frame = JSON.parse(text)
      await ingestMcpFrame({ ...meta, direction: 'response', frame, ts: Date.now() })
    } catch {
      // not JSON — skip
    }
  }
}

/** Extract JSON-RPC frames from an SSE stream body. Each event's `data:`
 *  line(s) are concatenated and JSON-parsed; non-JSON data (e.g. a legacy
 *  `endpoint` event carrying a URL) is skipped. */
export function parseSseFrames(text: string): unknown[] {
  const out: unknown[] = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) continue
    try {
      out.push(JSON.parse(data))
    } catch {
      // keep-alive comment / endpoint URL / partial — not a frame
    }
  }
  return out
}

async function collectText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return new TextDecoder().decode(concat(chunks))
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
