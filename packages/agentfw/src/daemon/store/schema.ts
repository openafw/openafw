import { blob, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  title: text('title'),
  createdAt: integer('created_at').notNull(),
  /** Which running instance of the agent owns this task (wrapper-model
   *  suffix, or session id from the correlator). Null = unknown/single. */
  instanceId: text('instance_id'),
})

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id').notNull(),
    goal: text('goal'),
    status: text('status').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    costUsd: integer('cost_usd'), // micro-dollars (USD × 1e6)
    savedMicro: integer('saved_micro'), // micro-dollars saved by the cost-saver
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
  },
  (t) => ({
    startedIdx: index('runs_started_at').on(t.startedAt),
    threadStartedIdx: index('runs_thread_started').on(t.threadId, t.startedAt),
  }),
)

export const actions = sqliteTable(
  'actions',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    threadId: text('thread_id').notNull(),
    parentActionId: text('parent_action_id'),
    kind: text('kind').notNull(),
    sourceAgent: text('source_agent').notNull(),
    ts: integer('ts').notNull(),
    durMs: integer('dur_ms').notNull(),
    costUsd: integer('cost_usd'), // micro-dollars
    savedMicro: integer('saved_micro'), // micro-dollars saved by the cost-saver
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    riskTags: text('risk_tags'), // JSON array
    /** Mirrored from payload.model at ingest time so aggregate queries
     *  by model don't have to scan payload BLOBs (which can be ~1.6 MB
     *  each on Claude Code traffic — full-table json_extract took 15s
     *  before this column existed). */
    model: text('model'),
    /** Mirrored from payload.status (HTTP status) at ingest so error
     *  counts per model / per run don't require a payload scan. */
    httpStatus: integer('http_status'),
    /** Fleet dimensions (nullable). instanceId = which agent instance;
     *  subAgentId = precise delegated sub-agent (set by the correlator). */
    instanceId: text('instance_id'),
    subAgentId: text('sub_agent_id'),
    // The fat payload / raw_req / raw_res blobs live in `action_payloads`
    // (keyed by action id), so the actions table itself stays small and
    // every aggregate over it is fast regardless of how much is captured.
  },
  (t) => ({
    runIdx: index('actions_run_ts').on(t.runId, t.ts),
    kindIdx: index('actions_kind_ts').on(t.kind, t.ts),
    modelIdx: index('actions_kind_model_ts').on(t.kind, t.model, t.ts),
    threadIdx: index('actions_thread').on(t.threadId),
    instanceIdx: index('actions_instance').on(t.sourceAgent, t.instanceId, t.ts),
  }),
)

/**
 * The captured request/response payload for an action, kept out of the
 * `actions` table. Claude Code payloads run ~1.6 MB each; inline they
 * bloated every actions row and made aggregate scans fault in gigabytes.
 * Here the fat data is one PK lookup away, touched only by run-detail.
 */
export const actionPayloads = sqliteTable('action_payloads', {
  actionId: text('action_id').primaryKey(),
  payload: text('payload').notNull(), // JSON
  rawReq: blob('raw_req'),
  rawRes: blob('raw_res'),
})

/**
 * Outcomes detected at ingest time. The old query path scanned every
 * model_call payload to detect outcomes — fundamentally I/O bound on a
 * 1+ GB trace store. Persisting outcomes here turns /api/agentfw into a
 * SUM/COUNT against an indexed table (sub-100ms regardless of DB size).
 */
export const outcomes = sqliteTable(
  'outcomes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actionId: text('action_id').notNull(),
    runId: text('run_id').notNull(),
    threadId: text('thread_id').notNull(),
    agent: text('agent').notNull(),
    ts: integer('ts').notNull(),
    kind: text('kind').notNull(),
    valueUsdMicro: integer('value_usd_micro').notNull(),
    fingerprint: text('fingerprint').notNull(),
    toolUseId: text('tool_use_id'),
    subAgent: text('sub_agent'),
    verified: integer('verified').notNull().default(0),
    /** Fleet dimensions (nullable). instanceId = which agent instance;
     *  subAgentId = precise delegated sub-agent spawn id (correlator). The
     *  existing `subAgent` column stays the coarse type. */
    instanceId: text('instance_id'),
    subAgentId: text('sub_agent_id'),
  },
  (t) => ({
    tsIdx: index('outcomes_ts').on(t.ts),
    agentTsIdx: index('outcomes_agent_ts').on(t.agent, t.ts),
    fingerprintIdx: index('outcomes_fingerprint_ts').on(t.fingerprint, t.ts),
    toolUseIdIdx: index('outcomes_tool_use_id').on(t.toolUseId),
  }),
)

/**
 * Tool-use invocations extracted at ingest. Used by /api/tools (top
 * tools by call count + cost). Splits the enclosing model_call cost
 * evenly across its tool_use blocks for relative spend attribution.
 */
export const toolUses = sqliteTable(
  'tool_uses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actionId: text('action_id').notNull(),
    agent: text('agent').notNull(),
    ts: integer('ts').notNull(),
    name: text('name').notNull(),
    toolUseId: text('tool_use_id'),
    costMicroShare: integer('cost_micro_share').notNull(),
    isError: integer('is_error').notNull().default(0),
    // Pivot dimensions for the See → Agents/MCP/Skills tabs (migration v4).
    /** 'builtin' | 'mcp' | 'skill' — the tool's class. */
    category: text('category'),
    /** mcp → server name; skill → skill name; builtin → null. */
    detail: text('detail'),
    /** Which agent instance invoked it (nullable = unknown/single). */
    instanceId: text('instance_id'),
    threadId: text('thread_id'),
    runId: text('run_id'),
  },
  (t) => ({
    tsIdx: index('tool_uses_ts').on(t.ts),
    nameTsIdx: index('tool_uses_name_ts').on(t.name, t.ts),
    toolUseIdIdx: index('tool_uses_tool_use_id').on(t.toolUseId),
    instanceIdx: index('tool_uses_instance').on(t.agent, t.instanceId, t.ts),
    categoryIdx: index('tool_uses_category_detail').on(t.category, t.detail, t.ts),
    threadIdx: index('tool_uses_thread').on(t.threadId),
  }),
)

/**
 * File operations and shell executions derived from tool_use inputs at
 * ingest. The agent runs these locally; agentfw sees them as tool_use blocks
 * on the model wire. One row per file/shell tool call so a run or task can
 * report "touched these files, ran these commands".
 */
export const toolTargets = sqliteTable(
  'tool_targets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actionId: text('action_id').notNull(),
    runId: text('run_id').notNull(),
    threadId: text('thread_id').notNull(),
    agent: text('agent').notNull(),
    ts: integer('ts').notNull(),
    kind: text('kind').notNull(), // 'fs' | 'shell'
    op: text('op').notNull(), // edit | write | delete | read | exec
    target: text('target').notNull(),
    toolName: text('tool_name').notNull(),
    toolUseId: text('tool_use_id'),
  },
  (t) => ({
    runIdx: index('tool_targets_run').on(t.runId),
    threadIdx: index('tool_targets_thread').on(t.threadId),
  }),
)
