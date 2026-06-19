import { getRawDb } from '../store/db.ts'

/**
 * The error outcome of a run (or task) once chain failover is accounted for:
 *
 *   failed    — its terminal model_call (the last attempt) came back HTTP >= 400,
 *               so the error reached the client
 *   recovered — it had an errored model_call, but a later failover attempt
 *               succeeded, so the run still completed (e.g. og-coding returns
 *               504 → the `switchOn: error` chain fails over to a sibling model
 *               that returns 200)
 *   ok        — no errored model_call
 *
 * Distinguishing `recovered` from `failed` stops a successfully-recovered run
 * from reading as broken next to the model that actually served it.
 */
export type RunOutcome = 'ok' | 'recovered' | 'failed'

/**
 * Classify each entity by `keyCol` (`run_id` for runs, `thread_id` for tasks).
 *
 * The terminal attempt is always computed per run (ROW_NUMBER partitioned by
 * run_id, newest first), so a task is `failed` iff any of its runs failed
 * terminally, and `recovered` if it had errors that all recovered. One indexed
 * window query over the http_status column — no payload scan.
 */
async function outcomesBy(
  keyCol: 'run_id' | 'thread_id',
  ids: string[],
): Promise<Map<string, RunOutcome>> {
  const out = new Map<string, RunOutcome>()
  if (ids.length === 0) return out
  const raw = await getRawDb()
  const placeholders = ids.map(() => '?').join(',')
  const rows = raw
    .prepare(
      `WITH mc AS (
         SELECT ${keyCol} AS k, http_status,
                ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY ts DESC, id DESC) AS rn
         FROM actions
         WHERE kind = 'model_call' AND ${keyCol} IN (${placeholders})
       )
       SELECT k,
              MAX(CASE WHEN http_status >= 400 THEN 1 ELSE 0 END) AS any_err,
              MAX(CASE WHEN rn = 1 AND http_status >= 400 THEN 1 ELSE 0 END) AS terminal_err
       FROM mc
       GROUP BY k`,
    )
    .all(...ids) as Array<{ k: string; any_err: number; terminal_err: number }>
  for (const r of rows) {
    out.set(r.k, r.terminal_err ? 'failed' : r.any_err ? 'recovered' : 'ok')
  }
  return out
}

export const runOutcomes = (ids: string[]): Promise<Map<string, RunOutcome>> =>
  outcomesBy('run_id', ids)

export const threadOutcomes = (ids: string[]): Promise<Map<string, RunOutcome>> =>
  outcomesBy('thread_id', ids)

/** Tag each row with its `outcome`, defaulting to `ok` when unseen. */
export async function markOutcome<T extends { id: string }>(
  rows: T[],
  lookup: (ids: string[]) => Promise<Map<string, RunOutcome>>,
): Promise<Array<T & { outcome: RunOutcome }>> {
  if (rows.length === 0) return []
  const outcomes = await lookup(rows.map((r) => r.id))
  return rows.map((r) => ({ ...r, outcome: outcomes.get(r.id) ?? 'ok' }))
}
