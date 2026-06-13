// Versioned, ordered schema migrations. The baseline schema is created
// idempotently by applySchema (db.ts); this runner applies any ordered
// migrations whose version is newer than the database's `user_version`, then
// stamps it. Future non-additive schema changes go here as numbered steps
// instead of more ad-hoc `ALTER`s scattered through applySchema — each runs
// exactly once, in order, inside a transaction.

import type Database from 'better-sqlite3'
import { logger } from '../../core/logger.ts'

export type Migration = {
  version: number
  name: string
  up: (raw: Database.Database) => void
}

// Current schema version. Bump when adding a migration. Fresh databases run
// INIT_SQL (baseline) then these migrations in order, so a new column added
// here lands on both fresh and existing DBs via the same path.
export const SCHEMA_VERSION = 4

export const MIGRATIONS: Migration[] = [
  {
    // Fleet dimensions: which running instance of an agent, and which
    // delegated sub-agent, a row belongs to. Nullable + back-compatible —
    // existing rows read as null and degrade to the per-type view.
    // instance_id: wire-derivable (wrapper-model) or back-filled by the
    // session correlator. sub_agent_id: precise spawn id from correlation
    // (distinct from outcomes.sub_agent, which stays the coarse type).
    version: 2,
    name: 'agent instance + sub-agent dimensions',
    up: (raw) => {
      raw.exec('ALTER TABLE actions  ADD COLUMN instance_id  TEXT')
      raw.exec('ALTER TABLE actions  ADD COLUMN sub_agent_id TEXT')
      raw.exec('ALTER TABLE threads  ADD COLUMN instance_id  TEXT')
      raw.exec('ALTER TABLE outcomes ADD COLUMN instance_id  TEXT')
      raw.exec('ALTER TABLE outcomes ADD COLUMN sub_agent_id TEXT')
      raw.exec(
        'CREATE INDEX IF NOT EXISTS actions_instance ON actions(source_agent, instance_id, ts)',
      )
    },
  },
  {
    // Subagent cost-saver: dollars saved on each downgraded call (the
    // requested model's cost minus the served cheaper model's). Nullable +
    // back-compatible — existing rows read as null (no savings recorded).
    // Stored on both runs (fast per-task/run rollups, like cost_usd) and
    // actions (per-call detail).
    version: 3,
    name: 'subagent cost-saver savings',
    up: (raw) => {
      raw.exec('ALTER TABLE runs    ADD COLUMN saved_micro INTEGER')
      raw.exec('ALTER TABLE actions ADD COLUMN saved_micro INTEGER')
    },
  },
  {
    // See → Agents/MCP/Skills: pivot dimensions on the (previously stub,
    // never-populated) tool_uses table. The writer now extracts one row per
    // tool_use at ingest; these columns let the new tabs GROUP BY without
    // touching the fat payload sidecar. Additive + nullable — forward-only
    // (historical rows stay empty; trace data is pruned by retentionDays).
    version: 4,
    name: 'tool_uses pivot dimensions',
    up: (raw) => {
      raw.exec('ALTER TABLE tool_uses ADD COLUMN category    TEXT')
      raw.exec('ALTER TABLE tool_uses ADD COLUMN detail      TEXT')
      raw.exec('ALTER TABLE tool_uses ADD COLUMN instance_id TEXT')
      raw.exec('ALTER TABLE tool_uses ADD COLUMN thread_id   TEXT')
      raw.exec('ALTER TABLE tool_uses ADD COLUMN run_id      TEXT')
      raw.exec('CREATE INDEX IF NOT EXISTS tool_uses_instance ON tool_uses(agent, instance_id, ts)')
      raw.exec(
        'CREATE INDEX IF NOT EXISTS tool_uses_category_detail ON tool_uses(category, detail, ts)',
      )
      raw.exec('CREATE INDEX IF NOT EXISTS tool_uses_thread ON tool_uses(thread_id)')
    },
  },
]

function userVersion(raw: Database.Database): number {
  return Number(raw.pragma('user_version', { simple: true })) || 0
}

/**
 * Apply every migration newer than the DB's current version, in order, each
 * in its own transaction, then stamp `user_version` to `target`. Idempotent:
 * re-running applies nothing once the DB is current. Migrations list is a
 * parameter so it can be unit-tested with fixtures.
 */
export function runMigrations(
  raw: Database.Database,
  migrations: Migration[] = MIGRATIONS,
  target: number = SCHEMA_VERSION,
): void {
  const current = userVersion(raw)
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version)

  for (const m of pending) {
    raw.transaction(() => m.up(raw))()
    logger.info(`store: applied migration ${m.version} — ${m.name}`)
  }

  const highest = Math.max(target, ...migrations.map((m) => m.version), current)
  if (highest > current) raw.pragma(`user_version = ${highest}`)
}
