import type { Context } from 'hono'
import { listSkills } from '../store/queries.ts'

/** GET /api/skills — skills (the `Skill` tool) used across all instances,
 *  aggregated. The See → Skills tab. */
export async function handleListSkills(c: Context): Promise<Response> {
  return c.json({ skills: await listSkills() })
}
