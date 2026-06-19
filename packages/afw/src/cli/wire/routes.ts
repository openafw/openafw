import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { paths } from '../../core/paths.ts'
import { ROUTES_VERSION, type RouteEntry, type Routes } from '../../core/routes.ts'
import { atomicWrite, fileExists } from '../backup/files.ts'

export async function readRoutes(): Promise<Routes> {
  if (!(await fileExists(paths.wire.routes))) {
    return { version: ROUTES_VERSION, routes: {} }
  }
  const text = await readFile(paths.wire.routes, 'utf8')
  const parsed = JSON.parse(text) as Routes
  if (parsed.version !== ROUTES_VERSION) {
    throw new Error(`Routes version ${parsed.version} not supported (expected ${ROUTES_VERSION})`)
  }
  return parsed
}

export async function writeRoutes(routes: Routes): Promise<void> {
  await mkdir(dirname(paths.wire.routes), { recursive: true })
  await atomicWrite(paths.wire.routes, `${JSON.stringify(routes, null, 2)}\n`)
}

export async function upsertRoutes(updates: Record<string, RouteEntry>): Promise<void> {
  const r = await readRoutes()
  for (const [key, entry] of Object.entries(updates)) {
    r.routes[key] = entry
  }
  await writeRoutes(r)
}

export async function removeRoutes(keys: string[]): Promise<void> {
  const r = await readRoutes()
  for (const key of keys) delete r.routes[key]
  await writeRoutes(r)
}

/** Route keys belonging to `agent` that are safe to prune on its next
 *  wire: this agent's own non-MCP keys not in the desired set. Never
 *  another agent's keys, never `/mcp/` keys — `removeRoutes` is
 *  destructive, so the filter must be conservative. */
export function staleRouteKeys(
  existingKeys: string[],
  agent: string,
  desired: ReadonlySet<string>,
): string[] {
  return existingKeys.filter(
    (key) => key.startsWith(`${agent}/`) && !key.includes('/mcp/') && !desired.has(key),
  )
}
