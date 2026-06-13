import { gunzipSync } from 'node:zlib'
import { type SQL, and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { getDb } from './db.ts'
import { actionPayloads, actions, runs, threads, toolTargets, toolUses } from './schema.ts'

const ANOMALOUS_MIN_COST_MICRO = 10_000 // $0.01 minimum to count as a real spend

// The model a run actually reached. In a swap/failover the parent
// (client-facing) model_call is logged at $0 and the real upstream attempt —
// the served model — carries the cost, so "costliest model_call" picks the
// model traffic actually went to, not the one the agent requested. Correlated
// on `runs.id`; valid anywhere `runs` is in scope.
const runServedModel = sql<string | null>`(
  SELECT a.model
  FROM actions a
  WHERE a.run_id = ${runs.id} AND a.kind = 'model_call' AND a.model IS NOT NULL
  ORDER BY COALESCE(a.cost_usd, 0) DESC, a.ts DESC
  LIMIT 1
)`

export type RunListItem = {
  id: string
  threadId: string
  agent: string
  status: string
  startedAt: number
  endedAt: number | null
  durMs: number | null
  costUsd: number // dollars
  tokensIn: number | null
  tokensOut: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  actionCount: number
  /** The model this run actually went to — see `runServedModel`. Null when
   *  the run captured no model_call (e.g. an MCP-only run). */
  model: string | null
  /** True when this run fanned out to upstream attempts (a routed/combo call
   *  with a routing trace worth drilling into). */
  routed: boolean
}

export type ToolTargetSummary = {
  kind: string // 'fs' | 'shell'
  op: string // edit | write | delete | read | exec
  target: string
  toolName: string
  ts: number
}

export type RunDetail = {
  run: RunListItem
  actions: ActionSummary[]
  /** File ops + shell execs derived from this run's tool_use calls. */
  toolTargets: ToolTargetSummary[]
}

export type ActionSummary = {
  id: string
  kind: string
  sourceAgent: string
  parentActionId: string | null
  ts: number
  durMs: number
  costUsd: number
  tokensIn: number | null
  tokensOut: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  riskTags: unknown[]
  payload: unknown
  /** Original wire bytes, gunzipped to text — only present when the detail
   *  was fetched with `includeRaw` and the action captured them. */
  rawReq?: string | null
  rawRes?: string | null
}

export type ListRunsOptions = {
  agent?: string[]
  since?: number // ms epoch lower bound
  status?: string[]
  threadId?: string // restrict to one task's runs
  limit?: number
  offset?: number
}

export type ThreadListItem = {
  id: string
  agent: string
  title: string | null
  startedAt: number
  endedAt: number | null
  durMs: number | null
  runCount: number
  actionCount: number
  /** The task's dominant served model — see `threadAggColumns.model`. */
  model: string | null
  costUsd: number // dollars
  savedUsd: number // dollars saved by the cost-saver (downgraded calls)
  tokensIn: number | null
  tokensOut: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  outcomeValueUsd: number // dollars
  agentfw: number // outcomeValueUsd / costUsd (0 when either is 0)
}

export type ThreadDetail = {
  thread: ThreadListItem
  runs: RunListItem[]
}

export type ListThreadsOptions = {
  agent?: string[]
  since?: number // ms epoch lower bound (on each run's startedAt)
  /** Restrict to one agent instance. `null` = the unknown/single bucket
   *  (threads with no instance id). `undefined` = no instance filter. */
  instanceId?: string | null
  limit?: number
  offset?: number
}

export type DashboardSpendBucket = {
  hour: number // ms epoch, start of hour
  costUsd: number
}

export type DashboardPerAgent = {
  agent: string
  costUsd: number
  taskCount: number
}

export type DashboardRecentRun = {
  id: string
  agent: string
  startedAt: number
  costUsd: number
  durMs: number | null
  goal: string | null
}

export type DashboardData = {
  spend: {
    last24h: number
    last7d: number
    last30d: number
    hourlyBuckets: DashboardSpendBucket[] // 24 buckets ending now, sorted ascending
  }
  leverage: {
    totalTasks24h: number
    perAgent: DashboardPerAgent[] // sorted by costUsd desc
  }
  recentActivity: DashboardRecentRun[] // last N runs, sorted by startedAt desc
}

export async function getDashboardData(): Promise<DashboardData> {
  const db = await getDb()
  const now = Date.now()
  const since24h = now - 24 * 3_600_000
  const since7d = now - 7 * 86_400_000
  const since30d = now - 30 * 86_400_000

  const totalFor = (since: number): number => {
    const row = db
      .select({ total: sql<number>`COALESCE(SUM(${runs.costUsd}), 0)` })
      .from(runs)
      .where(gte(runs.startedAt, since))
      .get()
    return (row?.total ?? 0) / 1_000_000
  }

  const last24h = totalFor(since24h)
  const last7d = totalFor(since7d)
  const last30d = totalFor(since30d)

  const hourMs = 3_600_000
  const hourlyRows = db
    .select({
      hour: sql<number>`(${runs.startedAt} / ${hourMs}) * ${hourMs}`,
      total: sql<number>`COALESCE(SUM(${runs.costUsd}), 0)`,
    })
    .from(runs)
    .where(gte(runs.startedAt, since24h))
    .groupBy(sql`${runs.startedAt} / ${hourMs}`)
    .all()

  const hourlyMap = new Map<number, number>()
  for (const r of hourlyRows) hourlyMap.set(r.hour, r.total / 1_000_000)
  const currentHour = Math.floor(now / hourMs) * hourMs
  const hourlyBuckets: DashboardSpendBucket[] = []
  for (let i = 23; i >= 0; i--) {
    const hour = currentHour - i * hourMs
    hourlyBuckets.push({ hour, costUsd: hourlyMap.get(hour) ?? 0 })
  }

  const perAgentRows = db
    .select({
      agent: threads.agentId,
      costUsd: sql<number>`COALESCE(SUM(${runs.costUsd}), 0)`,
      taskCount: sql<number>`COUNT(DISTINCT ${runs.threadId})`,
    })
    .from(runs)
    .innerJoin(threads, eq(runs.threadId, threads.id))
    .where(gte(runs.startedAt, since24h))
    .groupBy(threads.agentId)
    .all()

  const perAgent: DashboardPerAgent[] = perAgentRows
    .map((r) => ({
      agent: r.agent,
      costUsd: (r.costUsd ?? 0) / 1_000_000,
      taskCount: Number(r.taskCount),
    }))
    .sort((a, b) => b.costUsd - a.costUsd)

  const totalTasks24h = perAgent.reduce((s, a) => s + a.taskCount, 0)

  const recentRows = db
    .select({
      id: runs.id,
      agent: threads.agentId,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      costUsd: runs.costUsd,
      goal: runs.goal,
    })
    .from(runs)
    .innerJoin(threads, eq(runs.threadId, threads.id))
    .orderBy(desc(runs.startedAt))
    .limit(8)
    .all()

  const recentActivity: DashboardRecentRun[] = recentRows.map((r) => ({
    id: r.id,
    agent: r.agent,
    startedAt: r.startedAt,
    costUsd: (r.costUsd ?? 0) / 1_000_000,
    durMs: r.endedAt != null ? r.endedAt - r.startedAt : null,
    goal: r.goal,
  }))

  return {
    spend: { last24h, last7d, last30d, hourlyBuckets },
    leverage: { totalTasks24h, perAgent },
    recentActivity,
  }
}

export type AnomalousSpendRun = {
  id: string
  agent: string
  startedAt: number
  costUsd: number // dollars
  tokensOut: number
  tokensIn: number
  cacheReadTokens: number
  cacheWriteTokens: number
  actionCount: number
  model: string | null
  durMs: number | null
}

export type AnomalousSpendReport = {
  since: number
  periodTotalUsd: number // dollars
  byCostPerOutput: AnomalousSpendRun[] // worst $/output-token ratios
  byAbsoluteSpend: AnomalousSpendRun[] // biggest spends
  subsetUsd: number // dollars summed across byCostPerOutput
}

export type AnomalousSpendOptions = {
  since?: number // ms epoch lower bound
  limit?: number
}

export async function countRuns(opts: ListRunsOptions = {}): Promise<number> {
  const db = await getDb()
  const where = [] as ReturnType<typeof eq>[]
  if (opts.since) where.push(gte(runs.startedAt, opts.since))
  if (opts.agent?.length) where.push(inArray(threads.agentId, opts.agent))
  if (opts.status?.length) where.push(inArray(runs.status, opts.status))
  if (opts.threadId) where.push(eq(runs.threadId, opts.threadId))

  const baseQuery = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(runs)
    .innerJoin(threads, eq(runs.threadId, threads.id))
  const q = where.length > 0 ? baseQuery.where(and(...where)) : baseQuery
  const row = q.get()
  return row?.n ?? 0
}

export async function listRuns(opts: ListRunsOptions = {}): Promise<RunListItem[]> {
  const db = await getDb()

  const where = [] as ReturnType<typeof eq>[]
  if (opts.since) where.push(gte(runs.startedAt, opts.since))
  if (opts.agent?.length) where.push(inArray(threads.agentId, opts.agent))
  if (opts.status?.length) where.push(inArray(runs.status, opts.status))
  if (opts.threadId) where.push(eq(runs.threadId, opts.threadId))

  const baseQuery = db
    .select({
      id: runs.id,
      threadId: runs.threadId,
      agent: threads.agentId,
      status: runs.status,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      costUsd: runs.costUsd,
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
      cacheReadTokens: runs.cacheReadTokens,
      cacheWriteTokens: runs.cacheWriteTokens,
      actionCount: sql<number>`(SELECT COUNT(*) FROM actions WHERE actions.run_id = ${runs.id})`,
      model: runServedModel,
      routed: sql<number>`(SELECT EXISTS(SELECT 1 FROM actions WHERE actions.run_id = ${runs.id} AND actions.parent_action_id IS NOT NULL))`,
    })
    .from(runs)
    .innerJoin(threads, eq(runs.threadId, threads.id))

  const filtered = where.length > 0 ? baseQuery.where(and(...where)) : baseQuery
  const rows = filtered
    .orderBy(desc(runs.startedAt))
    .limit(opts.limit ?? 20)
    .offset(opts.offset ?? 0)
    .all()

  return rows.map((r) => ({
    id: r.id,
    threadId: r.threadId,
    agent: r.agent,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durMs: r.endedAt != null ? r.endedAt - r.startedAt : null,
    costUsd: r.costUsd != null ? r.costUsd / 1_000_000 : 0,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    actionCount: Number(r.actionCount),
    model: r.model,
    routed: Number(r.routed) > 0,
  }))
}

export async function findAnomalousSpend(
  opts: AnomalousSpendOptions = {},
): Promise<AnomalousSpendReport> {
  const db = await getDb()
  const since = opts.since ?? Date.now() - 30 * 86_400_000
  const limit = opts.limit ?? 10

  const baseQuery = db
    .select({
      id: runs.id,
      agent: threads.agentId,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      costUsd: runs.costUsd,
      tokensOut: runs.tokensOut,
      tokensIn: runs.tokensIn,
      cacheReadTokens: runs.cacheReadTokens,
      cacheWriteTokens: runs.cacheWriteTokens,
      actionCount: sql<number>`(SELECT COUNT(*) FROM actions WHERE actions.run_id = ${runs.id})`,
      model: runServedModel,
    })
    .from(runs)
    .innerJoin(threads, eq(runs.threadId, threads.id))

  const ratioRows = baseQuery
    .where(
      and(
        gte(runs.startedAt, since),
        gte(runs.costUsd, ANOMALOUS_MIN_COST_MICRO),
        sql`COALESCE(${runs.tokensOut}, 0) > 0`,
      ),
    )
    .orderBy(desc(sql`CAST(${runs.costUsd} AS REAL) / NULLIF(${runs.tokensOut}, 0)`))
    .limit(limit)
    .all()

  const spendRows = baseQuery
    .where(and(gte(runs.startedAt, since), gte(runs.costUsd, ANOMALOUS_MIN_COST_MICRO)))
    .orderBy(desc(runs.costUsd))
    .limit(limit)
    .all()

  const totalRow = db
    .select({
      total: sql<number>`COALESCE(SUM(${runs.costUsd}), 0)`,
    })
    .from(runs)
    .where(gte(runs.startedAt, since))
    .get()

  const periodTotalUsd = (totalRow?.total ?? 0) / 1_000_000

  const toRun = (r: (typeof ratioRows)[number]): AnomalousSpendRun => ({
    id: r.id,
    agent: r.agent,
    startedAt: r.startedAt,
    costUsd: (r.costUsd ?? 0) / 1_000_000,
    tokensOut: r.tokensOut ?? 0,
    tokensIn: r.tokensIn ?? 0,
    cacheReadTokens: r.cacheReadTokens ?? 0,
    cacheWriteTokens: r.cacheWriteTokens ?? 0,
    actionCount: Number(r.actionCount),
    model: r.model,
    durMs: r.endedAt != null ? r.endedAt - r.startedAt : null,
  })

  const byCostPerOutput = ratioRows.map(toRun)
  const subsetUsd = byCostPerOutput.reduce((sum, r) => sum + r.costUsd, 0)

  return {
    since,
    periodTotalUsd,
    byCostPerOutput,
    byAbsoluteSpend: spendRows.map(toRun),
    subsetUsd,
  }
}

export async function getRunDetail(
  runId: string,
  opts: { includeRaw?: boolean } = {},
): Promise<RunDetail | null> {
  const db = await getDb()

  const runRow = db
    .select({
      id: runs.id,
      threadId: runs.threadId,
      agent: threads.agentId,
      status: runs.status,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      costUsd: runs.costUsd,
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
      cacheReadTokens: runs.cacheReadTokens,
      cacheWriteTokens: runs.cacheWriteTokens,
      actionCount: sql<number>`(SELECT COUNT(*) FROM actions WHERE actions.run_id = ${runs.id})`,
      model: runServedModel,
    })
    .from(runs)
    .innerJoin(threads, eq(runs.threadId, threads.id))
    .where(eq(runs.id, runId))
    .get()

  if (!runRow) return null

  const actionRows = db
    .select({
      id: actions.id,
      kind: actions.kind,
      sourceAgent: actions.sourceAgent,
      parentActionId: actions.parentActionId,
      ts: actions.ts,
      durMs: actions.durMs,
      costUsd: actions.costUsd,
      tokensIn: actions.tokensIn,
      tokensOut: actions.tokensOut,
      cacheReadTokens: actions.cacheReadTokens,
      cacheWriteTokens: actions.cacheWriteTokens,
      riskTags: actions.riskTags,
      payload: actionPayloads.payload,
      rawReq: actionPayloads.rawReq,
      rawRes: actionPayloads.rawRes,
    })
    .from(actions)
    .leftJoin(actionPayloads, eq(actionPayloads.actionId, actions.id))
    .where(eq(actions.runId, runId))
    .orderBy(actions.ts)
    .all()

  const targetRows = db
    .select({
      kind: toolTargets.kind,
      op: toolTargets.op,
      target: toolTargets.target,
      toolName: toolTargets.toolName,
      ts: toolTargets.ts,
    })
    .from(toolTargets)
    .where(eq(toolTargets.runId, runId))
    .orderBy(asc(toolTargets.ts), asc(toolTargets.id))
    .all()

  return {
    run: {
      id: runRow.id,
      threadId: runRow.threadId,
      agent: runRow.agent,
      status: runRow.status,
      startedAt: runRow.startedAt,
      endedAt: runRow.endedAt,
      durMs: runRow.endedAt != null ? runRow.endedAt - runRow.startedAt : null,
      costUsd: runRow.costUsd != null ? runRow.costUsd / 1_000_000 : 0,
      tokensIn: runRow.tokensIn,
      tokensOut: runRow.tokensOut,
      cacheReadTokens: runRow.cacheReadTokens,
      cacheWriteTokens: runRow.cacheWriteTokens,
      actionCount: Number(runRow.actionCount),
      model: runRow.model,
      routed: actionRows.some((a) => a.parentActionId != null),
    },
    toolTargets: targetRows,
    actions: actionRows.map((a) => ({
      id: a.id,
      kind: a.kind,
      sourceAgent: a.sourceAgent,
      parentActionId: a.parentActionId,
      ts: a.ts,
      durMs: a.durMs,
      costUsd: a.costUsd != null ? a.costUsd / 1_000_000 : 0,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      cacheReadTokens: a.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens,
      riskTags: a.riskTags ? (JSON.parse(a.riskTags) as unknown[]) : [],
      payload: a.payload != null ? (JSON.parse(a.payload) as unknown) : null,
      ...(opts.includeRaw ? { rawReq: gunzipText(a.rawReq), rawRes: gunzipText(a.rawRes) } : {}),
    })),
  }
}

/** Gunzip a stored raw blob to text, or null when absent/corrupt. */
function gunzipText(blob: unknown): string | null {
  if (!Buffer.isBuffer(blob) || blob.length === 0) return null
  try {
    return gunzipSync(blob).toString('utf8')
  } catch {
    return null
  }
}

// ── threads (= tasks) ─────────────────────────────────────────────
//
// A task is a thread: one correlated conversation/goal. These roll up over
// `runs` (which carry the money — see writer) keyed by thread_id, so totals
// stay correct without touching the fat payload sidecar. Per-thread outcome
// value comes from the outcomes table (which also carries thread_id), giving
// a per-task T = value / cost.

// The shared aggregate projection for one thread. `actions` count and
// `outcomes` value are correlated subqueries keyed on the thread id — the
// same raw-SQL idiom listRuns/findAnomalousSpend use for per-run counts.
const threadAggColumns = {
  id: threads.id,
  agent: threads.agentId,
  title: threads.title,
  startedAt: sql<number>`MIN(${runs.startedAt})`,
  endedAt: sql<number>`MAX(COALESCE(${runs.endedAt}, ${runs.startedAt}))`,
  runCount: sql<number>`COUNT(${runs.id})`,
  costUsd: sql<number>`COALESCE(SUM(${runs.costUsd}), 0)`,
  savedMicro: sql<number>`COALESCE(SUM(${runs.savedMicro}), 0)`,
  tokensIn: sql<number>`COALESCE(SUM(${runs.tokensIn}), 0)`,
  tokensOut: sql<number>`COALESCE(SUM(${runs.tokensOut}), 0)`,
  cacheReadTokens: sql<number>`COALESCE(SUM(${runs.cacheReadTokens}), 0)`,
  cacheWriteTokens: sql<number>`COALESCE(SUM(${runs.cacheWriteTokens}), 0)`,
  actionCount: sql<number>`(SELECT COUNT(*) FROM actions WHERE actions.thread_id = ${threads.id})`,
  // The task's dominant served model — costliest model_call across all its
  // runs (same "served, not requested" logic as `runServedModel`). A task
  // that mixes models (planner + downgraded subagents) shows the costliest
  // one here; the per-run rows in the detail view reveal the rest.
  model: sql<string | null>`(
    SELECT a.model FROM actions a
    WHERE a.thread_id = ${threads.id} AND a.kind = 'model_call' AND a.model IS NOT NULL
    ORDER BY COALESCE(a.cost_usd, 0) DESC, a.ts DESC
    LIMIT 1
  )`,
  outcomeValueMicro: sql<number>`(SELECT COALESCE(SUM(value_usd_micro), 0) FROM outcomes WHERE outcomes.thread_id = ${threads.id})`,
} as const

type ThreadAggRow = {
  id: string
  agent: string
  title: string | null
  startedAt: number
  endedAt: number
  runCount: number
  costUsd: number
  savedMicro: number
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  cacheWriteTokens: number
  actionCount: number
  model: string | null
  outcomeValueMicro: number
}

function mapThreadRow(r: ThreadAggRow): ThreadListItem {
  const costUsd = (r.costUsd ?? 0) / 1_000_000
  const outcomeValueUsd = (r.outcomeValueMicro ?? 0) / 1_000_000
  return {
    id: r.id,
    agent: r.agent,
    title: r.title,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durMs: r.endedAt != null && r.startedAt != null ? r.endedAt - r.startedAt : null,
    runCount: Number(r.runCount),
    actionCount: Number(r.actionCount),
    model: r.model,
    costUsd,
    savedUsd: (r.savedMicro ?? 0) / 1_000_000,
    tokensIn: Number(r.tokensIn),
    tokensOut: Number(r.tokensOut),
    cacheReadTokens: Number(r.cacheReadTokens),
    cacheWriteTokens: Number(r.cacheWriteTokens),
    outcomeValueUsd,
    agentfw: costUsd > 0 && outcomeValueUsd > 0 ? outcomeValueUsd / costUsd : 0,
  }
}

export async function countThreads(opts: ListThreadsOptions = {}): Promise<number> {
  const db = await getDb()
  const where = [] as ReturnType<typeof eq>[]
  if (opts.since) where.push(gte(runs.startedAt, opts.since))
  if (opts.agent?.length) where.push(inArray(threads.agentId, opts.agent))

  const base = db
    .select({ n: sql<number>`COUNT(DISTINCT ${runs.threadId})` })
    .from(runs)
    .innerJoin(threads, eq(runs.threadId, threads.id))
  const q = where.length > 0 ? base.where(and(...where)) : base
  const row = q.get()
  return row?.n ?? 0
}

export async function listThreads(opts: ListThreadsOptions = {}): Promise<ThreadListItem[]> {
  const db = await getDb()
  const where: SQL[] = []
  if (opts.since) where.push(gte(runs.startedAt, opts.since))
  if (opts.agent?.length) where.push(inArray(threads.agentId, opts.agent))
  if (opts.instanceId !== undefined) {
    where.push(
      opts.instanceId === null
        ? isNull(threads.instanceId)
        : eq(threads.instanceId, opts.instanceId),
    )
  }

  const base = db
    .select(threadAggColumns)
    .from(runs)
    .innerJoin(threads, eq(runs.threadId, threads.id))
  const filtered = where.length > 0 ? base.where(and(...where)) : base
  const rows = filtered
    .groupBy(threads.id)
    .orderBy(desc(sql`MIN(${runs.startedAt})`))
    .limit(opts.limit ?? 20)
    .offset(opts.offset ?? 0)
    .all()

  return rows.map(mapThreadRow)
}

export async function getThreadDetail(threadId: string): Promise<ThreadDetail | null> {
  const db = await getDb()
  const row = db
    .select(threadAggColumns)
    .from(runs)
    .innerJoin(threads, eq(runs.threadId, threads.id))
    .where(eq(threads.id, threadId))
    .groupBy(threads.id)
    .get()

  if (!row) return null

  // Reuse the run projection so each run links to #/run/:id unchanged.
  const runRows = await listRuns({ threadId, limit: 10_000 })
  return { thread: mapThreadRow(row), runs: runRows }
}

// ── See: agent instances / MCP / skills ────────────────────────────
//
// Pivots captured activity by agent instance (source_agent + instance_id).
// instance_id is nullable (bare agent, no `@instance` / wrapper suffix); a null
// collapses into one "unknown" bucket per agent — represented as instanceId:null
// in the result and round-tripped through the API key encoding. MCP/skill/tool
// usage comes from the tool_uses table the writer now populates at ingest.

// `agent || US || instance` — a stable composite distinct-count key (US = the
// unit-separator control char, which can't appear in an agent/instance id).
const instanceComposite = sql<string>`${toolUses.agent} || char(31) || COALESCE(${toolUses.instanceId}, '')`

export type AgentInstanceItem = {
  agent: string
  instanceId: string | null
  taskCount: number
  actionCount: number
  costUsd: number
  firstSeen: number
  lastActive: number
  mcpCount: number
  skillCount: number
  toolCount: number
}

export async function listAgentInstances(): Promise<AgentInstanceItem[]> {
  const db = await getDb()

  // Core per-instance aggregates from the small actions table.
  const coreRows = db
    .select({
      agent: actions.sourceAgent,
      instanceId: actions.instanceId,
      taskCount: sql<number>`COUNT(DISTINCT ${actions.threadId})`,
      actionCount: sql<number>`COUNT(*)`,
      costMicro: sql<number>`COALESCE(SUM(${actions.costUsd}), 0)`,
      firstSeen: sql<number>`MIN(${actions.ts})`,
      lastActive: sql<number>`MAX(${actions.ts})`,
    })
    .from(actions)
    .groupBy(actions.sourceAgent, sql`COALESCE(${actions.instanceId}, '')`)
    .all()

  // Distinct MCP / skill / tool counts per instance, from tool_uses.
  const tuRows = db
    .select({
      agent: toolUses.agent,
      instanceId: toolUses.instanceId,
      mcpCount: sql<number>`COUNT(DISTINCT CASE WHEN ${toolUses.category} = 'mcp' THEN ${toolUses.detail} END)`,
      skillCount: sql<number>`COUNT(DISTINCT CASE WHEN ${toolUses.category} = 'skill' THEN ${toolUses.detail} END)`,
      toolCount: sql<number>`COUNT(DISTINCT ${toolUses.name})`,
    })
    .from(toolUses)
    .groupBy(toolUses.agent, sql`COALESCE(${toolUses.instanceId}, '')`)
    .all()

  const tuByKey = new Map(tuRows.map((r) => [`${r.agent}${r.instanceId ?? ''}`, r]))

  return coreRows
    .map((r) => {
      const tu = tuByKey.get(`${r.agent}${r.instanceId ?? ''}`)
      return {
        agent: r.agent,
        instanceId: r.instanceId ?? null,
        taskCount: Number(r.taskCount),
        actionCount: Number(r.actionCount),
        costUsd: (r.costMicro ?? 0) / 1_000_000,
        firstSeen: r.firstSeen,
        lastActive: r.lastActive,
        mcpCount: Number(tu?.mcpCount ?? 0),
        skillCount: Number(tu?.skillCount ?? 0),
        toolCount: Number(tu?.toolCount ?? 0),
      }
    })
    .sort((a, b) => b.lastActive - a.lastActive)
}

export type NameCount = { name: string; count: number; category?: string }

export type AgentInstanceDetail = {
  agent: string
  instanceId: string | null
  mcpServers: NameCount[]
  skills: NameCount[]
  tools: NameCount[]
  tasks: ThreadListItem[]
}

export async function getInstanceDetail(
  agent: string,
  instanceId: string | null,
): Promise<AgentInstanceDetail | null> {
  const db = await getDb()
  const instWhere =
    instanceId === null ? isNull(toolUses.instanceId) : eq(toolUses.instanceId, instanceId)
  const scope = and(eq(toolUses.agent, agent), instWhere)

  // group tool_uses for this instance by detail (mcp/skill) and by name (tools).
  const byDetail = (category: string): NameCount[] =>
    db
      .select({ name: toolUses.detail, count: sql<number>`COUNT(*)` })
      .from(toolUses)
      .where(and(scope, eq(toolUses.category, category), isNotNull(toolUses.detail)))
      .groupBy(toolUses.detail)
      .orderBy(desc(sql`COUNT(*)`))
      .all()
      .map((r) => ({ name: r.name ?? 'unknown', count: Number(r.count) }))

  const mcpServers = byDetail('mcp')
  const skills = byDetail('skill')
  const tools = db
    .select({
      name: toolUses.name,
      category: toolUses.category,
      count: sql<number>`COUNT(*)`,
    })
    .from(toolUses)
    .where(scope)
    .groupBy(toolUses.name)
    .orderBy(desc(sql`COUNT(*)`))
    .all()
    .map((r) => ({ name: r.name, count: Number(r.count), category: r.category ?? undefined }))

  const tasks = await listThreads({ agent: [agent], instanceId, limit: 1000 })

  // Nothing recorded for this instance at all → 404.
  if (tools.length === 0 && tasks.length === 0) return null
  return { agent, instanceId, mcpServers, skills, tools, tasks }
}

export type McpServerItem = {
  server: string
  callCount: number
  errorCount: number
  methodCount: number
  instanceCount: number
  taskCount: number
  lastActive: number
}

export async function listMcpServers(): Promise<McpServerItem[]> {
  const db = await getDb()
  return db
    .select({
      server: toolUses.detail,
      callCount: sql<number>`COUNT(*)`,
      errorCount: sql<number>`COALESCE(SUM(${toolUses.isError}), 0)`,
      methodCount: sql<number>`COUNT(DISTINCT ${toolUses.name})`,
      instanceCount: sql<number>`COUNT(DISTINCT ${instanceComposite})`,
      taskCount: sql<number>`COUNT(DISTINCT ${toolUses.threadId})`,
      lastActive: sql<number>`MAX(${toolUses.ts})`,
    })
    .from(toolUses)
    .where(and(eq(toolUses.category, 'mcp'), isNotNull(toolUses.detail)))
    .groupBy(toolUses.detail)
    .orderBy(desc(sql`COUNT(*)`))
    .all()
    .map((r) => ({
      server: r.server ?? 'unknown',
      callCount: Number(r.callCount),
      errorCount: Number(r.errorCount),
      methodCount: Number(r.methodCount),
      instanceCount: Number(r.instanceCount),
      taskCount: Number(r.taskCount),
      lastActive: r.lastActive,
    }))
}

export type SkillItem = {
  skill: string
  useCount: number
  instanceCount: number
  taskCount: number
  lastActive: number
}

export async function listSkills(): Promise<SkillItem[]> {
  const db = await getDb()
  return db
    .select({
      skill: toolUses.detail,
      useCount: sql<number>`COUNT(*)`,
      instanceCount: sql<number>`COUNT(DISTINCT ${instanceComposite})`,
      taskCount: sql<number>`COUNT(DISTINCT ${toolUses.threadId})`,
      lastActive: sql<number>`MAX(${toolUses.ts})`,
    })
    .from(toolUses)
    .where(and(eq(toolUses.category, 'skill'), isNotNull(toolUses.detail)))
    .groupBy(toolUses.detail)
    .orderBy(desc(sql`COUNT(*)`))
    .all()
    .map((r) => ({
      skill: r.skill ?? 'unknown',
      useCount: Number(r.useCount),
      instanceCount: Number(r.instanceCount),
      taskCount: Number(r.taskCount),
      lastActive: r.lastActive,
    }))
}

// ── risk findings (the Guard surface) ──────────────────────────────

export type RiskFinding = {
  actionId: string
  runId: string
  agent: string
  kind: string
  ts: number
  tag: string
  severity: 'info' | 'warn' | 'high'
  detail?: unknown
}

type StoredRiskTag = { tag?: string; severity?: string; detail?: unknown }

/** Flatten every risk tag the detector pipeline attached to a captured action
 *  into one finding per (action, tag), most recent first. Scans only actions
 *  whose `risk_tags` column is a non-empty JSON array — cheap, no payload read.
 *  `limit` bounds the number of actions inspected. */
export async function listRiskFindings(opts: { limit?: number } = {}): Promise<RiskFinding[]> {
  const db = await getDb()
  const rows = db
    .select({
      id: actions.id,
      runId: actions.runId,
      agent: actions.sourceAgent,
      kind: actions.kind,
      ts: actions.ts,
      riskTags: actions.riskTags,
    })
    .from(actions)
    .where(and(isNotNull(actions.riskTags), ne(actions.riskTags, '[]')))
    .orderBy(desc(actions.ts))
    .limit(opts.limit ?? 200)
    .all()

  const findings: RiskFinding[] = []
  for (const r of rows) {
    let tags: StoredRiskTag[] = []
    try {
      const parsed = JSON.parse(r.riskTags ?? '[]')
      if (Array.isArray(parsed)) tags = parsed as StoredRiskTag[]
    } catch {
      // malformed JSON — skip this action's tags
    }
    for (const t of tags) {
      if (!t || typeof t.tag !== 'string') continue
      // The tool-result prompt-injection detector is gated off (it over-flagged,
      // notably `prompt-injection:exfiltration`). Hide its historical findings so
      // stale false positives don't linger in the Guard view.
      if (t.tag.startsWith('prompt-injection')) continue
      const severity = t.severity === 'high' || t.severity === 'warn' ? t.severity : 'info'
      findings.push({
        actionId: r.id,
        runId: r.runId,
        agent: r.agent,
        kind: r.kind,
        ts: r.ts,
        tag: t.tag,
        severity,
        detail: t.detail,
      })
    }
  }
  return findings
}
