// Quota accounting for the `quota-pct` switch rule. A subscription (OAuth)
// upstream like Claude/Codex never tells afw its absolute token budget, so
// an absolute `{ kind: 'tokens' }` cap can't work for it. What it DOES return —
// on every response — is rate-limit headers reporting how much of the current
// window is left. We snapshot the most-consumed window per provider from those
// headers (`recordQuotaHeaders`, called from exec.ts on each routed upstream
// call) and `quotaUsedPct` reads it back for the pre-call switch check.
//
// Eventually consistent like budget.ts: the snapshot is from the previous
// routed call to that provider, so a burst can briefly overshoot. The exact
// header names vary by provider/plan; the pair-matching below is deliberately
// tolerant so a renamed or newly-added window still counts.

/** Latest known quota usage per provider id — the binding (most-consumed)
 *  window, as a 0–100 percentage. Account-global, so it reflects all usage of
 *  the subscription, not just afw's routed calls. */
const snapshots = new Map<string, { usedPct: number; at: number }>()

/** Parse rate-limit headers into the highest used-percentage across every
 *  limit/remaining pair found. Handles both layouts seen in the wild:
 *    - Anthropic: `anthropic-ratelimit-<bucket>-{limit,remaining}`
 *    - OpenAI:    `x-ratelimit-{limit,remaining}-<bucket>`
 *  Returns undefined when no usable pair is present. */
export function usedPctFromHeaders(headers: Headers): number | undefined {
  const buckets = new Map<string, { limit?: number; remaining?: number }>()
  const put = (bucket: string, field: 'limit' | 'remaining', raw: string) => {
    const n = Number.parseFloat(raw)
    if (!Number.isFinite(n)) return
    const b = buckets.get(bucket) ?? {}
    b[field] = n
    buckets.set(bucket, b)
  }

  headers.forEach((value, key) => {
    const k = key.toLowerCase()
    let m = /^anthropic-ratelimit-(.+)-(limit|remaining)$/.exec(k)
    if (m) {
      put(`a:${m[1]}`, m[2] as 'limit' | 'remaining', value)
      return
    }
    m = /^x-ratelimit-(limit|remaining)-(.+)$/.exec(k)
    if (m) put(`o:${m[2]}`, m[1] as 'limit' | 'remaining', value)
  })

  let maxUsed: number | undefined
  for (const { limit, remaining } of buckets.values()) {
    if (limit === undefined || remaining === undefined || limit <= 0) continue
    const used = ((limit - Math.max(0, remaining)) / limit) * 100
    if (maxUsed === undefined || used > maxUsed) maxUsed = used
  }
  return maxUsed
}

/** Record a routed upstream response's quota headers against its provider.
 *  No-op when the response carries no recognizable rate-limit headers. */
export function recordQuotaHeaders(providerId: string, headers: Headers): void {
  const usedPct = usedPctFromHeaders(headers)
  if (usedPct === undefined) return
  snapshots.set(providerId, { usedPct, at: Date.now() })
}

/** The latest known quota-used percentage for a provider, or undefined when
 *  none of its responses have carried rate-limit headers yet (so a `quota-pct`
 *  rule can't fire on missing data — we never switch blind). */
export function quotaUsedPct(providerId: string): number | undefined {
  return snapshots.get(providerId)?.usedPct
}

/** Test seam — drop all snapshots. */
export function clearQuotaSnapshots(): void {
  snapshots.clear()
}
