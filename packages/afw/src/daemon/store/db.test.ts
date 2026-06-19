import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { applySchema } from './db.ts'
import { type Migration, SCHEMA_VERSION, runMigrations } from './migrations.ts'

// Migration safety net. `applySchema` is the single migration entry point;
// a release that breaks it would corrupt or half-migrate every user's
// database on auto-update. These tests run it against fresh, repeated, and
// old-schema databases — all in-memory, no filesystem.

let db: Database.Database | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

function tableNames(raw: Database.Database): Set<string> {
  const rows = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string
  }[]
  return new Set(rows.map((r) => r.name))
}

function columnNames(raw: Database.Database, table: string): Set<string> {
  const rows = raw.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string
  }[]
  return new Set(rows.map((r) => r.name))
}

function indexNames(raw: Database.Database): Set<string> {
  const rows = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
    name: string
  }[]
  return new Set(rows.map((r) => r.name))
}

describe('applySchema', () => {
  it('creates the full schema on a fresh database', () => {
    db = new Database(':memory:')
    applySchema(db)

    const tables = tableNames(db)
    for (const t of ['threads', 'runs', 'actions', 'action_payloads', 'outcomes', 'tool_uses']) {
      expect(tables.has(t), `table ${t} missing`).toBe(true)
    }
    expect(columnNames(db, 'actions').has('model')).toBe(true)
    expect(columnNames(db, 'actions').has('http_status')).toBe(true)
    expect(columnNames(db, 'actions').has('cache_read_tokens')).toBe(true)
    expect(columnNames(db, 'runs').has('cache_write_tokens')).toBe(true)
    // the fat payload lives in the sidecar, never on the actions row
    expect(columnNames(db, 'actions').has('payload')).toBe(false)

    // per-task (thread) rollup indexes
    expect(indexNames(db).has('runs_thread_started')).toBe(true)
    expect(indexNames(db).has('actions_thread')).toBe(true)

    // fleet dimensions added by migration v2
    expect(columnNames(db, 'actions').has('instance_id')).toBe(true)
    expect(columnNames(db, 'actions').has('sub_agent_id')).toBe(true)
    expect(columnNames(db, 'threads').has('instance_id')).toBe(true)
    expect(columnNames(db, 'outcomes').has('instance_id')).toBe(true)
    expect(indexNames(db).has('actions_instance')).toBe(true)

    // tool_uses pivot dimensions added by migration v4
    for (const c of ['category', 'detail', 'instance_id', 'thread_id', 'run_id']) {
      expect(columnNames(db, 'tool_uses').has(c)).toBe(true)
    }
    expect(indexNames(db).has('tool_uses_instance')).toBe(true)
    expect(indexNames(db).has('tool_uses_category_detail')).toBe(true)
  })

  it('is idempotent — running twice keeps data and does not throw', () => {
    db = new Database(':memory:')
    applySchema(db)
    db.prepare('INSERT INTO threads (id, agent_id, created_at) VALUES (?, ?, ?)').run(
      't1',
      'claude-code',
      1,
    )

    expect(() => applySchema(db as Database.Database)).not.toThrow()

    const row = db.prepare('SELECT count(*) AS c FROM threads').get() as {
      c: number
    }
    expect(row.c).toBe(1)
  })

  it('upgrades a pre-outcomes / pre-model database without data loss', () => {
    db = new Database(':memory:')
    // An old (pre-v0.3) schema: runs + actions without the newer columns,
    // and no outcomes / tool_uses tables at all.
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, goal TEXT,
        status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
        cost_usd INTEGER, tokens_in INTEGER, tokens_out INTEGER
      );
      CREATE TABLE actions (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        parent_action_id TEXT, kind TEXT NOT NULL, source_agent TEXT NOT NULL,
        ts INTEGER NOT NULL, dur_ms INTEGER NOT NULL, cost_usd INTEGER,
        tokens_in INTEGER, tokens_out INTEGER, risk_tags TEXT,
        payload TEXT NOT NULL, raw_req BLOB, raw_res BLOB
      );
    `)
    db.prepare(
      `INSERT INTO actions
         (id, run_id, thread_id, kind, source_agent, ts, dur_ms, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'a1',
      'r1',
      't1',
      'model_call',
      'claude-code',
      1,
      10,
      JSON.stringify({ model: 'claude-opus-4-7' }),
    )

    applySchema(db)

    // new tables now exist
    expect(tableNames(db).has('outcomes')).toBe(true)
    expect(tableNames(db).has('tool_uses')).toBe(true)
    // new columns added to existing tables
    expect(columnNames(db, 'actions').has('model')).toBe(true)
    expect(columnNames(db, 'actions').has('http_status')).toBe(true)
    expect(columnNames(db, 'actions').has('cache_read_tokens')).toBe(true)
    expect(columnNames(db, 'runs').has('cache_read_tokens')).toBe(true)
    // the old row survived the upgrade
    const a = db.prepare('SELECT id, model FROM actions WHERE id = ?').get('a1') as {
      id: string
      model: string | null
    }
    expect(a.id).toBe('a1')
    // and the one-time backfill populated model from the payload JSON
    expect(a.model).toBe('claude-opus-4-7')

    // the fat payload was moved off the actions row into the sidecar
    expect(tableNames(db).has('action_payloads')).toBe(true)
    expect(columnNames(db, 'actions').has('payload')).toBe(false)
    expect(columnNames(db, 'actions').has('raw_req')).toBe(false)
    const moved = db.prepare('SELECT payload FROM action_payloads WHERE action_id = ?').get('a1') as
      | { payload: string }
      | undefined
    expect(moved).toBeDefined()
    expect(JSON.parse(moved?.payload ?? '{}').model).toBe('claude-opus-4-7')
  })

  it('stamps the schema version on a fresh database', () => {
    db = new Database(':memory:')
    applySchema(db)
    const v = Number(db.pragma('user_version', { simple: true }))
    expect(v).toBe(SCHEMA_VERSION)
  })

  it('runMigrations applies pending steps in order, exactly once', () => {
    db = new Database(':memory:')
    applySchema(db)
    // Use versions well above SCHEMA_VERSION so they're pending after the
    // real baseline migrations applySchema already ran.
    const applied: number[] = []
    const fixtures: Migration[] = [
      { version: 11, name: 'c', up: () => applied.push(11) },
      {
        version: 10,
        name: 'b',
        up: (raw) => raw.exec('ALTER TABLE runs ADD COLUMN test_col TEXT'),
      },
    ]
    runMigrations(db, fixtures, 11)
    expect(applied).toEqual([11]) // both ran in order; v10 added the column
    expect(columnNames(db, 'runs').has('test_col')).toBe(true)
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(11)

    // Re-running applies nothing (already at version 11).
    applied.length = 0
    runMigrations(db, fixtures, 11)
    expect(applied).toEqual([])
  })

  it('leaves an already-current database untouched on re-open', () => {
    db = new Database(':memory:')
    applySchema(db)
    const before = db
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'index'")
      .get() as { c: number }

    applySchema(db)

    const after = db
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'index'")
      .get() as { c: number }
    expect(after.c).toBe(before.c)
  })
})
