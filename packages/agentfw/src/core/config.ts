import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { paths } from './paths.ts'

// User preferences, stored at ~/.agentfw/config.json. Distinct from
// update.json (runtime update state) — this file is only ever written in
// response to an explicit user choice.
export type CostSpikeLimits = { info: number; warn: number; high: number }

export type AgentfwConfig = {
  // Whether to check the npm registry for new versions. On by default.
  // The check sends only the package name to the public registry — no
  // user data, never our servers. Set false to disable entirely.
  updateCheck: boolean
  // Whether to install updates automatically. False until the user opts
  // in — which they are asked to do once, after their first manual update.
  autoUpdate: boolean
  // Whether the one-time "auto-update future releases?" question has been
  // answered. Until it has, the CLI and dashboard ask after an update.
  autoUpdateAsked: boolean
  // How many days of captured traces to keep. The maintenance loop prunes
  // anything older once a day so the trace store stays bounded as capture
  // grows. 0 disables pruning. Default 30.
  retentionDays: number
  // Per-call USD thresholds for the cost-spike risk tagger. A captured
  // model call at/above each bound gets the matching severity tag so the
  // dashboard can flag expensive turns. Tune to your budget; the highest
  // matching bound wins. Defaults: $1 info, $5 warn, $20 high.
  costSpikeLimits: CostSpikeLimits
  // Opt-in: refresh the model price catalog daily from LiteLLM's public
  // price list. Off by default — see PRIVACY.md. When true the daemon
  // makes one daily HTTPS GET to a public endpoint, no user data attached.
  autoRefreshPricing: boolean
  // Opt-in: correlate captured Claude Code calls with the local session
  // transcripts under ~/.claude/projects to attribute each call to its
  // window (instance) and parallel sub-agent. Off by default. Reads
  // local files only, sends nothing — see PRIVACY.md.
  correlateSessions: boolean
  // Whether first-run onboarding has been completed — either a model
  // provider was configured or the user explicitly chose passthrough.
  // Gates the launcher's setup wizard so it only runs on a fresh install.
  onboarded: boolean
}

const DEFAULTS: AgentfwConfig = {
  updateCheck: true,
  autoUpdate: false,
  autoUpdateAsked: false,
  retentionDays: 30,
  costSpikeLimits: { info: 1, warn: 5, high: 20 },
  autoRefreshPricing: false,
  correlateSessions: false,
  onboarded: false,
}

export async function readConfig(): Promise<AgentfwConfig> {
  try {
    const parsed = JSON.parse(await readFile(paths.config, 'utf8')) as Partial<AgentfwConfig>
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function updateConfig(patch: Partial<AgentfwConfig>): Promise<AgentfwConfig> {
  const next = { ...(await readConfig()), ...patch }
  await mkdir(dirname(paths.config), { recursive: true })
  await writeFile(paths.config, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}
