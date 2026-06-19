// Minimal text-table formatter. No deps.

export function formatTable(headers: string[], rows: string[][]): string {
  const cols = headers.length
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))

  const renderRow = (cells: string[]) =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd()

  const lines: string[] = []
  lines.push(renderRow(headers))
  lines.push(renderRow(widths.map((w) => '─'.repeat(w))))
  for (const r of rows) {
    const padded: string[] = []
    for (let i = 0; i < cols; i++) padded[i] = r[i] ?? ''
    lines.push(renderRow(padded))
  }
  return lines.join('\n')
}

export function shortId(id: string): string {
  // Take the prefix + first 8 chars of the random part.
  const dash = id.indexOf('_')
  if (dash < 0) return id.slice(0, 10)
  return `${id.slice(0, dash + 1)}${id.slice(dash + 1, dash + 9)}`
}

export function formatTime(ms: number): string {
  const d = new Date(ms)
  // YYYY-MM-DD HH:mm:ss (local)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export function formatTokens(tin: number | null, tout: number | null): string {
  if (tin == null && tout == null) return '—'
  return `${tin ?? 0}/${tout ?? 0}`
}

export function formatCache(read: number | null, write: number | null): string {
  if ((read == null || read === 0) && (write == null || write === 0)) return '—'
  return `${compact(read ?? 0)}/${compact(write ?? 0)}`
}

/**
 * Three pricing-relevant token buckets shown as `cached/fresh/out`.
 *   cached = cacheReadTokens          (cache hit — cheapest)
 *   fresh  = tokensIn + cacheWriteTokens (non-cache-hit — full or 1.25×)
 *   out    = tokensOut
 * Storage is normalized at decoder write-time, so tokensIn is always
 * fresh input only (never includes cache traffic).
 */
export function formatTokenBuckets(
  tokensIn: number | null,
  tokensOut: number | null,
  cacheReadTokens: number | null,
  cacheWriteTokens: number | null,
): string {
  const cached = cacheReadTokens ?? 0
  const fresh = (tokensIn ?? 0) + (cacheWriteTokens ?? 0)
  const out = tokensOut ?? 0
  if (cached === 0 && fresh === 0 && out === 0) return '—'
  return `${compact(cached)}/${compact(fresh)}/${compact(out)}`
}

function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}K`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}
