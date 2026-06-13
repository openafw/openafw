import type { Context } from 'hono'
import { listRiskFindings } from '../store/queries.ts'

/** GET /api/risk — flattened detector findings across captured traffic, most
 *  recent first. Powers the dashboard's Guard view. */
export async function handleListRisk(c: Context): Promise<Response> {
  const limitRaw = c.req.query('limit')
  const n = limitRaw ? Number.parseInt(limitRaw, 10) : 200
  const limit = Number.isFinite(n) ? Math.max(1, Math.min(1000, n)) : 200
  const findings = await listRiskFindings({ limit })
  return c.json({ findings, total: findings.length })
}
