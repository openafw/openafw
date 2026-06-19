import type { Context } from 'hono'
import { getInstanceDetail, listAgentInstances } from '../store/queries.ts'

// One agent instance's URL key: `<agent>~<instanceId>`, each part
// percent-encoded; an empty instance part is the null (unknown/single) bucket.
// `~` is URL-unreserved and never appears in an agent id or an instance slug.
const SEP = '~'

export function encodeInstanceKey(agent: string, instanceId: string | null): string {
  return `${encodeURIComponent(agent)}${SEP}${instanceId === null ? '' : encodeURIComponent(instanceId)}`
}

export function parseInstanceKey(key: string): { agent: string; instanceId: string | null } | null {
  const i = key.indexOf(SEP)
  if (i < 0) return null
  const agent = decodeURIComponent(key.slice(0, i))
  if (!agent) return null
  const rest = key.slice(i + 1)
  return { agent, instanceId: rest === '' ? null : decodeURIComponent(rest) }
}

/** GET /api/instances — agent instances (sourceAgent + instanceId) with their
 *  task / MCP / skill / tool counts. The See → Agents tab. */
export async function handleListInstances(c: Context): Promise<Response> {
  const rows = await listAgentInstances()
  return c.json({
    instances: rows.map((r) => ({ ...r, key: encodeInstanceKey(r.agent, r.instanceId) })),
  })
}

/** GET /api/instances/:key — one instance's MCP servers / skills / tools + tasks. */
export async function handleGetInstance(c: Context): Promise<Response> {
  const key = c.req.param('key')
  const parsed = key ? parseInstanceKey(key) : null
  if (!parsed) return c.json({ error: 'malformed instance key' }, 400)
  const detail = await getInstanceDetail(parsed.agent, parsed.instanceId)
  if (!detail) return c.json({ error: 'instance not found' }, 404)
  return c.json({ ...detail, key: encodeInstanceKey(parsed.agent, parsed.instanceId) })
}
