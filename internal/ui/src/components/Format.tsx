export function Time({ ms }: { ms: number }) {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    <span title={d.toISOString()}>
      {pad(d.getHours())}:{pad(d.getMinutes())}:{pad(d.getSeconds())}
    </span>
  )
}

export function Duration({ ms }: { ms: number | null }) {
  if (ms == null) return <>—</>
  if (ms < 1000) return <>{ms}ms</>
  if (ms < 60_000) return <>{(ms / 1000).toFixed(1)}s</>
  return <>{(ms / 60_000).toFixed(1)}m</>
}

export function Tokens({
  tokensIn,
  tokensOut,
}: { tokensIn: number | null; tokensOut: number | null }) {
  if (tokensIn == null && tokensOut == null) return <>—</>
  return (
    <>
      {tokensIn ?? 0}/{tokensOut ?? 0}
    </>
  )
}

export function Cache({
  read,
  write,
}: {
  read: number | null
  write: number | null
}) {
  const r = read ?? 0
  const w = write ?? 0
  if (r === 0 && w === 0) return <>—</>
  return (
    <span title={`${r} read, ${w} write`}>
      {compact(r)}/{compact(w)}
    </span>
  )
}

function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}K`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** Compact token count for headline figures (e.g. 12.3K, 1.1M). agentfw
 *  reports usage in tokens, never dollars. */
export function compactTokens(n: number): string {
  return compact(n)
}

export function shortId(id: string): string {
  const dash = id.indexOf('_')
  return dash < 0 ? id.slice(0, 10) : `${id.slice(0, dash + 1)}${id.slice(dash + 1, dash + 9)}`
}

/** Compact T value: <1 → 2dp, <100 → 1dp, else rounded with separators. */
export function formatThomas(t: number): string {
  if (t === 0) return '0'
  if (t < 1) return t.toFixed(2)
  if (t < 100) return t.toFixed(1)
  return Math.round(t).toLocaleString()
}
