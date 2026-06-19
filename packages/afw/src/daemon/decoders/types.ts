import type { AgentId } from '../../core/agent.ts'
import type { Orchestration } from '../../core/packet.ts'

export type DecodeInput = {
  agent: AgentId
  provider: string
  /** The actual provider id this call hit (e.g. `claude-code/*`,
   *  `og-text`). The legacy `provider` field above is a per-request
   *  label (body model id or `'*'`) — this one is the registry key, so
   *  the captured packet can name the (providerId, model) pair the
   *  upstream actually saw. */
  providerId?: string
  upstreamUrl: string
  reqMethod: string
  reqHeaders: Headers
  reqBody?: ArrayBuffer
  /** The client's original `body.model` before any afw-side swap.
   *  Captured by the proxy at the moment the request arrives, before
   *  `swapVirtualModelForPassthrough` mutates `reqBody`. Set on the
   *  packet so the UI can show "asked X → upstream Y" when routing or
   *  virtualisation changed the model. Empty string when the request
   *  had no `model` field (e.g. /v1/models GET). */
  clientModel?: string
  /** Wire-derived agent instance — the `@<instance>` path segment minted
   *  by `afw run`. Authoritative when present; otherwise the
   *  capture falls back to the wrapper-model suffix. */
  instanceId?: string
  resStatus: number
  resHeaders: Headers
  resBody: ReadableStream<Uint8Array>
  /** performance.now() value at request start. */
  startedAt: number
  /** Set when the routing orchestrator produced this call. */
  orchestration?: Orchestration
}

export interface Decoder {
  decode(input: DecodeInput): Promise<void>
}

/** Snapshot a `Headers` instance into a plain object for the captured
 *  `errorHeaders` payload. `set-cookie` is dropped (would leak upstream
 *  session state and is never load-bearing for debugging a 4xx); values
 *  longer than 1 KB are truncated so a misbehaving header can't bloat
 *  the stored payload. Used by every decoder that captures a non-2xx. */
export function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return
    out[key] = value.length > 1024 ? `${value.slice(0, 1024)}…` : value
  })
  return out
}

/** Tee a response stream so a decoder can both parse it and capture the
 *  original raw bytes (for `--raw` / replay). Returns the branch to parse
 *  from plus a promise of the full raw bytes; the raw branch is drained
 *  concurrently so neither side deadlocks on backpressure. */
export function teeForRaw(body: ReadableStream<Uint8Array>): {
  parse: ReadableStream<Uint8Array>
  raw: Promise<Uint8Array>
} {
  const [a, b] = body.tee()
  return { parse: a, raw: drainStream(b) }
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}
