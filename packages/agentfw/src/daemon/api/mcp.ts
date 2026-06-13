import type { Context } from 'hono'
import { listMcpServers } from '../store/queries.ts'

/** GET /api/mcp — MCP servers captured across all instances, aggregated. The
 *  See → MCP tab. */
export async function handleListMcp(c: Context): Promise<Response> {
  return c.json({ servers: await listMcpServers() })
}
