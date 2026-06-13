// In-memory cache for the text↔multimodal split. When a request is routed to a
// text-only model, its images are stripped to `[Image #N]` placeholders and the
// bytes parked here; the vision loop looks them back up by ordinal to service
// each `view_image` tool call. Keyed by a transient per-request id — never
// persisted, never written to disk. A bounded LRU with a short TTL so a leaked
// request id (the loop crashed before dropRequest) cannot grow unbounded.

import { nanoid } from 'nanoid'
import type { IRImageSource } from '../translate/ir.ts'

const MAX_ENTRIES = 100
const TTL_MS = 5 * 60_000

type Entry = { source: IRImageSource; expiresAt: number }

// Map iteration order is insertion order — the first key is the oldest, which
// is what LRU eviction and a `get` re-insert both rely on.
const store = new Map<string, Entry>()

/** A fresh transient request id — namespaces one request's images. */
export function newRequestId(): string {
  return nanoid()
}

function keyOf(requestId: string, ordinal: number): string {
  return `${requestId}#${ordinal}`
}

function evictExpired(now: number): void {
  for (const [k, e] of store) {
    if (e.expiresAt <= now) store.delete(k)
  }
}

/** Park one image under a request id and its 1-based ordinal. */
export function putImage(requestId: string, ordinal: number, source: IRImageSource): void {
  const now = Date.now()
  evictExpired(now)
  store.set(keyOf(requestId, ordinal), { source, expiresAt: now + TTL_MS })
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

/** Look up a cached image, refreshing its LRU position and TTL. Undefined when
 *  the ordinal was never cached or its entry has expired. */
export function getImage(requestId: string, ordinal: number): IRImageSource | undefined {
  const key = keyOf(requestId, ordinal)
  const entry = store.get(key)
  if (!entry) return undefined
  const now = Date.now()
  if (entry.expiresAt <= now) {
    store.delete(key)
    return undefined
  }
  // Re-insert so the entry moves to the most-recently-used end.
  store.delete(key)
  entry.expiresAt = now + TTL_MS
  store.set(key, entry)
  return entry.source
}

/** Drop every image cached for a request — called when its vision loop ends. */
export function dropRequest(requestId: string): void {
  const prefix = `${requestId}#`
  for (const k of [...store.keys()]) {
    if (k.startsWith(prefix)) store.delete(k)
  }
}
