import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { logger } from '../../core/logger.ts'
import { paths } from '../../core/paths.ts'
import { runMigrations } from './migrations.ts'
import * as schema from './schema.ts'

// Raw schema bootstrap. Mirrors schema.ts; idempotent with `IF NOT EXISTS`.
// The idempotent baseline below brings a fresh or legacy database up to the
// current shape; ordered, versioned forward migrations then run via
// runMigrations (migrations.ts), stamping PRAGMA user_version.
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  title       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id                  TEXT PRIMARY KEY,
  thread_id           TEXT NOT NULL,
  goal                TEXT,
  status              TEXT NOT NULL,
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  cost_usd            INTEGER,
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  cache_read_tokens   INTEGER,
  cache_write_tokens  INTEGER
);
CREATE INDEX IF NOT EXISTS runs_started_at ON runs(started_at);

CREATE TABLE IF NOT EXISTS actions (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  thread_id           TEXT NOT NULL,
  parent_action_id    TEXT,
  kind                TEXT NOT NULL,
  source_agent        TEXT NOT NULL,
  ts                  INTEGER NOT NULL,
  dur_ms              INTEGER NOT NULL,
  cost_usd            INTEGER,
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  cache_read_tokens   INTEGER,
  cache_write_tokens  INTEGER,
  risk_tags           TEXT
);
CREATE INDEX IF NOT EXISTS actions_run_ts  ON actions(run_id, ts);
CREATE INDEX IF NOT EXISTS actions_kind_ts ON actions(kind, ts);

-- Fat payload blobs live here, keyed by action id — out of the actions
-- table so aggregate scans never fault gigabytes of JSON into memory.
CREATE TABLE IF NOT EXISTS action_payloads (
  action_id   TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  raw_req     BLOB,
  raw_res     BLOB
);

CREATE TABLE IF NOT EXISTS outcomes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id       TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  thread_id       TEXT NOT NULL,
  agent           TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  value_usd_micro INTEGER NOT NULL,
  fingerprint     TEXT NOT NULL,
  tool_use_id     TEXT,
  sub_agent       TEXT,
  verified        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS outcomes_ts             ON outcomes(ts);
CREATE INDEX IF NOT EXISTS outcomes_agent_ts       ON outcomes(agent, ts);
CREATE INDEX IF NOT EXISTS outcomes_fingerprint_ts ON outcomes(fingerprint, ts);
CREATE INDEX IF NOT EXISTS outcomes_tool_use_id    ON outcomes(tool_use_id);

CREATE TABLE IF NOT EXISTS tool_uses (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id         TEXT NOT NULL,
  agent             TEXT NOT NULL,
  ts                INTEGER NOT NULL,
  name              TEXT NOT NULL,
  tool_use_id       TEXT,
  cost_micro_share  INTEGER NOT NULL,
  is_error          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tool_uses_ts          ON tool_uses(ts);
CREATE INDEX IF NOT EXISTS tool_uses_name_ts     ON tool_uses(name, ts);
CREATE INDEX IF NOT EXISTS tool_uses_tool_use_id ON tool_uses(tool_use_id);

-- File operations and shell executions derived from tool_use block inputs
-- (the agent runs them locally; agentfw sees them on the model wire). One
-- row per Edit/Write/Bash-style tool call, so a task can answer "which
-- files did this touch, what commands did it run".
CREATE TABLE IF NOT EXISTS tool_targets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id     TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  agent         TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  kind          TEXT NOT NULL,   -- 'fs' | 'shell'
  op            TEXT NOT NULL,   -- edit | write | delete | read | exec
  target        TEXT NOT NULL,   -- file path or command line
  tool_name     TEXT NOT NULL,
  tool_use_id   TEXT
);
CREATE INDEX IF NOT EXISTS tool_targets_run    ON tool_targets(run_id);
CREATE INDEX IF NOT EXISTS tool_targets_thread ON tool_targets(thread_id);
`

function ensureColumns(
  raw: Database.Database,
  table: string,
  columns: Record<string, string>,
): void {
  const existing = raw
    .prepare(`PRAGMA table_info(${table})`)
    .all() as { name: string }[]
  const have = new Set(existing.map((c) => c.name))
  for (const [name, type] of Object.entries(columns)) {
    if (!have.has(name)) {
      raw.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
    }
  }
}

// why: the old schema kept payload / raw_req / raw_res inline on the
// actions table — ~1.6 MB/row of JSON that bloated every row and made
// aggregate scans fault gigabytes into memory. This one-time migration
// moves the blobs to the action_payloads sidecar and drops the fat
// columns. Idempotent (skipped once `actions.payload` is gone) and
// atomic — a failure rolls back to the old, fully working schema.
function migratePayloadSidecar(raw: Database.Database): void {
  const cols = raw.prepare('PRAGMA table_info(actions)').all() as {
    name: string
  }[]
  if (!cols.some((c) => c.name === 'payload')) return
  logger.info('store: moving payloads to the action_payloads sidecar…')
  const t0 = performance.now()
  raw.transaction(() => {
    raw.exec(
      `INSERT OR IGNORE INTO action_payloads (action_id, payload, raw_req, raw_res)
       SELECT id, payload, raw_req, raw_res FROM actions`,
    )
    raw.exec('ALTER TABLE actions DROP COLUMN payload')
    raw.exec('ALTER TABLE actions DROP COLUMN raw_req')
    raw.exec('ALTER TABLE actions DROP COLUMN raw_res')
  })()
  logger.info(
    `store: payload sidecar migration done in ${(
      performance.now() - t0
    ).toFixed(0)}ms`,
  )
}

// why: one-time population of actions.model from payload JSON for rows
// captured before the model column existed. json_extract over the whole
// table is slow on large stores, so probe first and only run when needed.
function backfillModelColumn(raw: Database.Database): void {
  const needsBackfill = raw
    .prepare(
      "SELECT 1 FROM actions WHERE kind = 'model_call' AND model IS NULL LIMIT 1",
    )
    .get() as unknown
  if (!needsBackfill) return
  logger.info('store: backfilling actions.model from payload (one-time)…')
  const t0 = performance.now()
  raw.exec(
    `UPDATE actions SET model = (
       SELECT json_extract(p.payload, '$.model')
       FROM action_payloads p WHERE p.action_id = actions.id
     ) WHERE kind = 'model_call' AND model IS NULL`,
  )
  logger.info(`store: backfill done in ${(performance.now() - t0).toFixed(0)}ms`)
}

/**
 * Bring a raw database up to the current schema: idempotent table/index
 * creation, additive column migrations, and the one-time model backfill.
 * Safe on a fresh, partial, or already-current database. This is the single
 * migration entry point — exercised directly by the migration tests.
 */
export function applySchema(raw: Database.Database): void {
  raw.exec(INIT_SQL)
  ensureColumns(raw, 'runs', {
    cache_read_tokens: 'INTEGER',
    cache_write_tokens: 'INTEGER',
  })
  ensureColumns(raw, 'actions', {
    cache_read_tokens: 'INTEGER',
    cache_write_tokens: 'INTEGER',
    model: 'TEXT',
    http_status: 'INTEGER',
  })
  migratePayloadSidecar(raw)
  raw.exec(
    'CREATE INDEX IF NOT EXISTS actions_kind_model_ts ON actions(kind, model, ts)',
  )
  // why: the actions table carries ~1.6 MB payload BLOBs per row. Any
  // aggregate that reads a non-indexed column pulls those fat rows and —
  // because better-sqlite3 is synchronous — freezes the whole daemon for
  // seconds (a 2.8 GB / 2.4k-row store took 5–60 s, killing keep-warm).
  // This covering index carries every small column the /api/agentfw
  // aggregates touch, so their GROUP BY scans are index-only and never
  // read a payload.
  raw.exec(
    `CREATE INDEX IF NOT EXISTS actions_agg ON actions(
       ts, kind, run_id, thread_id, source_agent, model, http_status,
       cost_usd, tokens_in, tokens_out, cache_read_tokens,
       cache_write_tokens, dur_ms)`,
  )
  // why: each of these mirrors the column order a specific aggregate's
  // GROUP BY / JOIN wants AND carries the columns it reads — so the query
  // planner picks a covering, index-only scan instead of its preferred
  // (but non-covering) index that would fault in fat payload rows.
  raw.exec(
    `CREATE INDEX IF NOT EXISTS actions_run_agg ON actions(
       run_id, ts, cost_usd, http_status, thread_id, source_agent)`,
  )
  raw.exec(
    `CREATE INDEX IF NOT EXISTS actions_kind_agg ON actions(
       kind, ts, model, cost_usd, http_status, tokens_in, tokens_out,
       cache_read_tokens, id, thread_id)`,
  )
  raw.exec('CREATE INDEX IF NOT EXISTS actions_id_model ON actions(id, model)')
  raw.exec(
    'CREATE INDEX IF NOT EXISTS tool_uses_action_id ON tool_uses(action_id)',
  )
  // why: per-task (thread) rollups group runs by thread_id and sub-count
  // actions by thread_id. These keep listThreads/getThreadDetail index-only.
  raw.exec(
    'CREATE INDEX IF NOT EXISTS runs_thread_started ON runs(thread_id, started_at)',
  )
  raw.exec('CREATE INDEX IF NOT EXISTS actions_thread ON actions(thread_id)')
  backfillModelColumn(raw)
  backfillHttpStatus(raw)

  // Ordered, versioned forward migrations on top of the idempotent baseline.
  runMigrations(raw)
}

// why: one-time population of actions.http_status from payload JSON for
// model_call rows captured before the column existed — so per-model and
// per-run error counts work over historical data.
function backfillHttpStatus(raw: Database.Database): void {
  const needsBackfill = raw
    .prepare(
      "SELECT 1 FROM actions WHERE kind = 'model_call' AND http_status IS NULL LIMIT 1",
    )
    .get() as unknown
  if (!needsBackfill) return
  logger.info('store: backfilling actions.http_status from payload (one-time)…')
  const t0 = performance.now()
  raw.exec(
    `UPDATE actions SET http_status = (
       SELECT json_extract(p.payload, '$.status')
       FROM action_payloads p WHERE p.action_id = actions.id
     ) WHERE kind = 'model_call' AND http_status IS NULL`,
  )
  logger.info(
    `store: http_status backfill done in ${(performance.now() - t0).toFixed(0)}ms`,
  )
}

export type Db = BetterSQLite3Database<typeof schema>

let cached: { db: Db; raw: Database.Database } | undefined

export async function getDb(): Promise<Db> {
  if (cached) return cached.db
  const path = traceDbPath()
  await mkdir(dirname(path), { recursive: true })
  const raw = new Database(path)
  raw.pragma('journal_mode = WAL')
  raw.pragma('synchronous = NORMAL')
  applySchema(raw)
  const db = drizzle(raw, { schema })
  cached = { db, raw }
  logger.debug(`store: opened ${path}`)
  return db
}

export async function getRawDb(): Promise<Database.Database> {
  if (!cached) await getDb()
  if (!cached) throw new Error('db not initialised')
  return cached.raw
}

export function closeDb(): void {
  cached?.raw.close()
  cached = undefined
}

function traceDbPath(): string {
  // v0.1: single file. v0.2 will rotate per day (`YYYY-MM-DD.db`).
  return join(paths.wire.traces, 'traces.db')
}
