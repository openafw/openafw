import type { Context } from 'hono'
import { detectPlan, runUnwire, runWire } from '../../cli/wire/orchestrate.ts'
import type { AgentId } from '../../core/agent.ts'
import { getRoutes } from '../routes/load.ts'
import { getDriftReport } from '../wire/watcher.ts'

export function handleWireStatus(c: Context): Response {
  const entries = getDriftReport()
  const drifted = entries.filter((e) => e.drifted)
  // "Wired" means the proxy will accept traffic for the agent — that's
  // determined by routes.json, not the backup manifest. For most agents
  // the two coincide (wire writes config, manifest records the change),
  // but manual-mode agents like claude-desktop with zero MCP servers
  // produce no backup entry at all: their wire output is just the route
  // and a secret. Without this union the badge would never flip.
  // Tombstoned routes are skipped — they exist only so already-running
  // agent processes can still proxy through; the user's intent on
  // unwire was to forget the agent.
  const wiredAgents = new Set<string>(entries.map((e) => e.agent))
  for (const [routeKey, entry] of Object.entries(getRoutes().routes)) {
    if (entry.tombstoned) continue
    const slash = routeKey.indexOf('/')
    const agent = slash > 0 ? routeKey.slice(0, slash) : routeKey
    wiredAgents.add(agent)
  }
  return c.json({
    watching: entries.length,
    driftedCount: drifted.length,
    wiredAgents: [...wiredAgents].sort(),
    entries: entries.map((e) => ({
      path: e.path,
      agent: e.agent,
      drifted: e.drifted,
      reason: e.reason,
      lastChecked: e.lastChecked,
    })),
  })
}

// ── GET /api/wire/detect ──────────────────────────────────────────

export async function handleWireDetect(c: Context): Promise<Response> {
  const only = parseAgentList(c.req.query('agents'))
  const plan = await detectPlan(only)
  return c.json(plan)
}

// ── POST /api/wire/run ────────────────────────────────────────────

export async function handleWireRun(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  const only = parseAgentList(body?.agents)
  // why: the dashboard runs in the same daemon process as the agent
  // restarts apply would trigger. Force noApply to true so the daemon
  // never tries to restart e.g. itself via launchctl from inside an
  // HTTP handler. The Apply plan is still returned for the UI to show.
  const result = await runWire({ only, noApply: true })
  return c.json(result)
}

// ── POST /api/wire/unwire ─────────────────────────────────────────

export async function handleWireUnwire(c: Context): Promise<Response> {
  const body = await jsonBody(c)
  const agents = parseAgentList(body?.agents)
  if (!agents || agents.length === 0) {
    return c.json({ error: 'agents is required' }, 400)
  }
  const force = body?.force === true
  // why: --stop-daemon is intentionally NOT exposed via HTTP — it would
  // kill the dashboard's own server out from under the user.
  const result = await runUnwire({ agents, force })
  return c.json(result)
}

// ── helpers ───────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json()
    return isObj(body) ? body : null
  } catch {
    return null
  }
}

/** Accept either a comma-separated string ("claude-code,codex") or a
 *  JSON array of strings. Returns undefined for empty/missing input. */
function parseAgentList(input: unknown): AgentId[] | undefined {
  if (input === undefined || input === null || input === '') return undefined
  if (Array.isArray(input)) {
    const ids = input.filter((v): v is string => typeof v === 'string' && v !== '')
    return ids.length > 0 ? (ids as AgentId[]) : undefined
  }
  if (typeof input === 'string') {
    const ids = input
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    return ids.length > 0 ? (ids as AgentId[]) : undefined
  }
  return undefined
}
