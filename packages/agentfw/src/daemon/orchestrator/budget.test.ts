import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as unknown as Database.Database }))

vi.mock('../store/db.ts', () => ({
  getRawDb: async () => state.db,
}))

const { clearBudgetCache, periodStart, spendInPeriod, tokensInPeriod } = await import(
  './budget.ts'
)

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE actions (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      model       TEXT,
      ts          INTEGER NOT NULL,
      cost_usd    INTEGER,
      tokens_in   INTEGER,
      tokens_out  INTEGER
    );
  `)
  return db
}

let rowSeq = 0
function insert(
  db: Database.Database,
  fields: {
    kind?: string
    model: string | null
    ts: number
    costUsd?: number | null
    tokensIn?: number | null
    tokensOut?: number | null
  },
): void {
  db.prepare(
    'INSERT INTO actions (id, kind, model, ts, cost_usd, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    `a${rowSeq++}`,
    fields.kind ?? 'model_call',
    fields.model,
    fields.ts,
    fields.costUsd ?? null,
    fields.tokensIn ?? null,
    fields.tokensOut ?? null,
  )
}

beforeEach(() => {
  state.db = freshDb()
  clearBudgetCache()
})

describe('periodStart', () => {
  it('returns local midnight for a day period', () => {
    const now = new Date(2026, 4, 21, 15, 30, 0).getTime()
    expect(periodStart('day', now)).toBe(new Date(2026, 4, 21).getTime())
  })

  it('returns the first of the month for a month period', () => {
    const now = new Date(2026, 4, 21, 15, 30, 0).getTime()
    expect(periodStart('month', now)).toBe(new Date(2026, 4, 1).getTime())
  })
})

describe('spendInPeriod', () => {
  it('sums micro-dollar costs into USD over the period', async () => {
    const now = Date.now()
    insert(state.db, { model: 'm1', ts: now, costUsd: 2_500_000 })
    insert(state.db, { model: 'm1', ts: now, costUsd: 1_500_000 })
    expect(await spendInPeriod('m1', 'day')).toBe(4)
  })

  it('excludes spend from before the period start', async () => {
    const now = Date.now()
    const before = periodStart('day', now) - 60_000
    insert(state.db, { model: 'm2', ts: before, costUsd: 9_000_000 })
    insert(state.db, { model: 'm2', ts: now, costUsd: 1_000_000 })
    expect(await spendInPeriod('m2', 'day')).toBe(1)
  })

  it('returns 0 for a model with no captured spend', async () => {
    expect(await spendInPeriod('never-used', 'day')).toBe(0)
  })

  it('counts only model_call actions', async () => {
    const now = Date.now()
    insert(state.db, { kind: 'tool_call', model: 'm3', ts: now, costUsd: 5_000_000 })
    insert(state.db, { kind: 'model_call', model: 'm3', ts: now, costUsd: 2_000_000 })
    expect(await spendInPeriod('m3', 'day')).toBe(2)
  })

  it('caches a result until the cache is cleared', async () => {
    const now = Date.now()
    insert(state.db, { model: 'm4', ts: now, costUsd: 1_000_000 })
    expect(await spendInPeriod('m4', 'day')).toBe(1)

    insert(state.db, { model: 'm4', ts: now, costUsd: 3_000_000 })
    expect(await spendInPeriod('m4', 'day')).toBe(1)

    clearBudgetCache()
    expect(await spendInPeriod('m4', 'day')).toBe(4)
  })
})

describe('tokensInPeriod', () => {
  it('sums tokens_in + tokens_out over the period', async () => {
    const now = Date.now()
    insert(state.db, { model: 't1', ts: now, tokensIn: 1000, tokensOut: 200 })
    insert(state.db, { model: 't1', ts: now, tokensIn: 500, tokensOut: 100 })
    expect(await tokensInPeriod('t1', 'day')).toBe(1800)
  })

  it('treats null token columns as zero', async () => {
    const now = Date.now()
    insert(state.db, { model: 't2', ts: now, tokensIn: 100 }) // no tokensOut
    insert(state.db, { model: 't2', ts: now, tokensOut: 50 }) // no tokensIn
    expect(await tokensInPeriod('t2', 'day')).toBe(150)
  })

  it('excludes tokens from before the period start', async () => {
    const now = Date.now()
    const before = periodStart('day', now) - 60_000
    insert(state.db, { model: 't3', ts: before, tokensIn: 9000 })
    insert(state.db, { model: 't3', ts: now, tokensIn: 100 })
    expect(await tokensInPeriod('t3', 'day')).toBe(100)
  })

  it('counts only model_call actions', async () => {
    const now = Date.now()
    insert(state.db, { kind: 'tool_call', model: 't4', ts: now, tokensIn: 5000 })
    insert(state.db, { kind: 'model_call', model: 't4', ts: now, tokensIn: 200 })
    expect(await tokensInPeriod('t4', 'day')).toBe(200)
  })
})
