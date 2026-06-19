// Budget accounting for chain switch rules. `spendInPeriod` sums the cost of
// every captured model_call for a model id over the current day or month —
// the figure a `{ kind: 'budget' }` SwitchRule compares against.
// `tokensInPeriod` is the same shape for `{ kind: 'tokens' }`, summing
// tokens_in + tokens_out.
//
// Eventually consistent under concurrency: results are cached for 10 s and
// routed children are written after the response is built, so a burst can
// briefly overshoot the limit. Accepted for v1 — the rule is "switch around
// $100", not a hard cap (see the plan's risks section).

import type { SwitchPeriod } from '../../core/routing-policy.ts'
import { getRawDb } from '../store/db.ts'

/** The epoch-ms window start a period sums usage from: the local-time day or
 *  month start, or — for a rolling window — `now` minus its hour span. */
export function periodStart(period: SwitchPeriod, now: number = Date.now()): number {
  if (typeof period === 'object') return now - period.rollingHours * 3_600_000
  const d = new Date(now)
  if (period === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/** A stable cache key for a period — the rolling form keys by its hour span. */
function periodKey(period: SwitchPeriod): string {
  return typeof period === 'object' ? `r${period.rollingHours}` : period
}

/** Human-readable period for log lines (`day`, `month`, `5h`). */
export function periodLabel(period: SwitchPeriod): string {
  return typeof period === 'object' ? `${period.rollingHours}h` : period
}

const CACHE_TTL_MS = 10_000
const spendCache = new Map<string, { value: number; at: number }>()
const tokenCache = new Map<string, { value: number; at: number }>()

/** Total USD spent on `modelId` since the start of the period. */
export async function spendInPeriod(modelId: string, period: SwitchPeriod): Promise<number> {
  const now = Date.now()
  const key = `${periodKey(period)}:${modelId}`
  const hit = spendCache.get(key)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value

  const raw = await getRawDb()
  const row = raw
    .prepare(
      "SELECT SUM(cost_usd) AS total FROM actions WHERE kind = 'model_call' AND model = ? AND ts >= ?",
    )
    .get(modelId, periodStart(period, now)) as { total: number | null } | undefined

  // cost_usd is stored in micro-dollars (USD × 1e6).
  const usd = (row?.total ?? 0) / 1_000_000
  spendCache.set(key, { value: usd, at: now })
  return usd
}

/** Total tokens (input + output) spent on `modelId` since the start of the
 *  period — the figure a `{ kind: 'tokens' }` SwitchRule compares against. */
export async function tokensInPeriod(modelId: string, period: SwitchPeriod): Promise<number> {
  const now = Date.now()
  const key = `${periodKey(period)}:${modelId}`
  const hit = tokenCache.get(key)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value

  const raw = await getRawDb()
  const row = raw
    .prepare(
      'SELECT SUM(COALESCE(tokens_in,0) + COALESCE(tokens_out,0)) AS total ' +
        "FROM actions WHERE kind = 'model_call' AND model = ? AND ts >= ?",
    )
    .get(modelId, periodStart(period, now)) as { total: number | null } | undefined

  const tokens = row?.total ?? 0
  tokenCache.set(key, { value: tokens, at: now })
  return tokens
}

/** Drop the spend + token caches — test seam, and called after a config
 *  change so a freshly edited rule is evaluated against live numbers. */
export function clearBudgetCache(): void {
  spendCache.clear()
  tokenCache.clear()
}
