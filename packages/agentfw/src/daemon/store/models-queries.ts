import { and, eq, gt, gte, isNotNull, sql } from 'drizzle-orm'
import { getDb } from './db.ts'
import { actions, threads } from './schema.ts'

export type RecentModelRow = {
  agent: string
  model: string
  uses: number
  errorCount: number
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costMicro: number
  lastUsed: number
}

/**
 * Distinct (agent, model) pairs seen in the last `sinceMs` window with
 * aggregate usage. Used by the Models page to show the user what's
 * actually flowing through agentfw so they know what to price.
 */
export async function recentModels(sinceMs: number): Promise<RecentModelRow[]> {
  const db = await getDb()
  // why: previously this used json_extract(payload, '$.model') which forced
  // SQLite to read the full payload BLOB (~1.6MB per row on Claude Code
  // traffic) just to find one field — 15s on a 30d window. Now we read the
  // mirrored model column and rely on the actions_kind_model_ts index.
  const rows = db
    .select({
      agent: threads.agentId,
      model: actions.model,
      uses: sql<number>`COUNT(*)`,
      errorCount: sql<number>`COALESCE(SUM(CASE WHEN ${actions.httpStatus} >= 400 THEN 1 ELSE 0 END), 0)`,
      tokensIn: sql<number>`COALESCE(SUM(${actions.tokensIn}), 0)`,
      tokensOut: sql<number>`COALESCE(SUM(${actions.tokensOut}), 0)`,
      cacheReadTokens: sql<number>`COALESCE(SUM(${actions.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<number>`COALESCE(SUM(${actions.cacheWriteTokens}), 0)`,
      costMicro: sql<number>`COALESCE(SUM(${actions.costUsd}), 0)`,
      lastUsed: sql<number>`MAX(${actions.ts})`,
    })
    .from(actions)
    .innerJoin(threads, eq(actions.threadId, threads.id))
    .where(
      and(
        eq(actions.kind, 'model_call'),
        gte(actions.ts, sinceMs),
        isNotNull(actions.model),
      ),
    )
    .groupBy(threads.agentId, actions.model)
    .all()

  return rows
    .filter((r): r is RecentModelRow => typeof r.model === 'string' && r.model.length > 0)
    .sort((a, b) => b.uses - a.uses)
}

/**
 * The smallest model-call input-token count observed for an agent in the last
 * `sinceMs` window — a proxy for the agent's baseline context (system prompt +
 * tool schemas + project files, before any conversation history). Used at
 * launch to decide whether lowering Claude Code's auto-compaction window would
 * fire on the very first prompt. Null when there's no usable traffic yet.
 */
export async function baselineInputTokens(
  agent: string,
  sinceMs: number,
): Promise<number | null> {
  const db = await getDb()
  const row = db
    .select({ minIn: sql<number>`MIN(${actions.tokensIn})` })
    .from(actions)
    .innerJoin(threads, eq(actions.threadId, threads.id))
    .where(
      and(
        eq(actions.kind, 'model_call'),
        eq(threads.agentId, agent),
        gte(actions.ts, sinceMs),
        gt(actions.tokensIn, 0),
      ),
    )
    .get()
  return row && typeof row.minIn === 'number' && row.minIn > 0 ? row.minIn : null
}
