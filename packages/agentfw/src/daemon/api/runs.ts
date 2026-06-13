import type { Context } from 'hono'
import { countRuns, getRunDetail, listRuns } from '../store/queries.ts'
import { markOutcome, runOutcomes } from './outcome.ts'

export async function handleListRuns(c: Context): Promise<Response> {
  const agent = c.req.query('agent')?.split(',').filter(Boolean)
  const status = c.req.query('status')?.split(',').filter(Boolean)
  const sinceRaw = c.req.query('since')
  const since = sinceRaw ? Number.parseInt(sinceRaw, 10) : undefined
  const limitRaw = c.req.query('limit')
  const offsetRaw = c.req.query('offset')
  const limit = clampInt(limitRaw, 50, 1, 200)
  const offset = clampInt(offsetRaw, 0, 0, 1_000_000)

  // why: the legacy shape returned a bare array; the paged shape adds
  // a total + pagination fields. We key on whether the caller passed
  // offset/limit so existing consumers (CLI / external) keep working.
  const filters = { agent, status, since, limit, offset }
  if (offsetRaw == null && limitRaw == null) {
    const rows = await listRuns(filters)
    return c.json(await markOutcome(rows, runOutcomes))
  }

  const [rows, total] = await Promise.all([listRuns(filters), countRuns({ agent, status, since })])
  return c.json({ rows: await markOutcome(rows, runOutcomes), total, limit, offset })
}

function clampInt(raw: string | undefined, dflt: number, lo: number, hi: number): number {
  if (raw == null) return dflt
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, n))
}

export async function handleGetRun(c: Context): Promise<Response> {
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'missing run id' }, 400)
  const includeRaw = c.req.query('raw') != null
  const detail = await getRunDetail(id, { includeRaw })
  if (!detail) return c.json({ error: 'run not found' }, 404)
  return c.json(detail)
}
