import type { Context } from 'hono'
import { countThreads, getThreadDetail, listThreads } from '../store/queries.ts'
import { markOutcome, runOutcomes, threadOutcomes } from './outcome.ts'

export async function handleListThreads(c: Context): Promise<Response> {
  const agent = c.req.query('agent')?.split(',').filter(Boolean)
  const sinceRaw = c.req.query('since')
  const since = sinceRaw ? Number.parseInt(sinceRaw, 10) : undefined
  const limitRaw = c.req.query('limit')
  const offsetRaw = c.req.query('offset')
  const limit = clampInt(limitRaw, 50, 1, 200)
  const offset = clampInt(offsetRaw, 0, 0, 1_000_000)

  // Same shape duality as /runs: a bare array for the legacy/CLI caller, the
  // paged envelope when offset/limit are passed.
  const filters = { agent, since, limit, offset }
  if (offsetRaw == null && limitRaw == null) {
    const rows = await listThreads(filters)
    return c.json(await markOutcome(rows, threadOutcomes))
  }

  const [rows, total] = await Promise.all([listThreads(filters), countThreads({ agent, since })])
  return c.json({ rows: await markOutcome(rows, threadOutcomes), total, limit, offset })
}

export async function handleGetThread(c: Context): Promise<Response> {
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'missing thread id' }, 400)
  const detail = await getThreadDetail(id)
  if (!detail) return c.json({ error: 'task not found' }, 404)
  // Enrich with the outcome on both the task and its runs, matching the list
  // endpoints so the detail view can badge failures vs failover-recoveries
  // consistently.
  const [thread] = await markOutcome([detail.thread], threadOutcomes)
  const runs = await markOutcome(detail.runs, runOutcomes)
  return c.json({ thread, runs })
}

function clampInt(raw: string | undefined, dflt: number, lo: number, hi: number): number {
  if (raw == null) return dflt
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, n))
}
