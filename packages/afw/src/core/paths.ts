import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const HOME = homedir()

/** Resolve the afw home directory. Honors an explicit `AFW_HOME`
 *  override; otherwise `~/.afw`. */
function resolveHome(): string {
  return process.env.AFW_HOME ?? join(HOME, '.afw')
}

export const AFW_HOME = resolveHome()

export const paths = {
  home: AFW_HOME,
  wire: {
    dir: join(AFW_HOME, 'wire'),
    routes: join(AFW_HOME, 'wire', 'routes.json'),
    traces: join(AFW_HOME, 'wire', 'traces'),
    // Cold per-day archive files (YYYY-MM-DD.db) written when prune evicts
    // old data from the active store, so nothing is lost on retention.
    tracesArchive: join(AFW_HOME, 'wire', 'traces', 'archive'),
    daemonSock: join(AFW_HOME, 'wire', 'daemon.sock'),
    // PID of the running daemon — written on boot, removed on exit. Lets
    // `afw daemon stop/restart` find a daemon it didn't spawn itself.
    daemonPid: join(AFW_HOME, 'wire', 'daemon.pid'),
  },
  backups: {
    dir: join(AFW_HOME, 'backups'),
    manifest: join(AFW_HOME, 'backups', 'manifest.json'),
  },
  logs: {
    dir: join(AFW_HOME, 'logs'),
    daemon: join(AFW_HOME, 'logs', 'daemon.log'),
    daemonErr: join(AFW_HOME, 'logs', 'daemon.err'),
  },
  config: join(AFW_HOME, 'config.json'),
  update: join(AFW_HOME, 'update.json'),
  // Model routing & combos — see core/model-registry.ts, routing-policy.ts.
  models: join(AFW_HOME, 'models.json'),
  routing: join(AFW_HOME, 'routing.json'),
  secrets: join(AFW_HOME, 'secrets.json'),
  // afw's OWN OAuth token store. afw runs its own subscription logins
  // (`afw oauth login …`) and persists the resulting tokens here — it never
  // reads or writes Claude Code's Keychain / Codex's auth.json. The orchestrator
  // reads + co-refreshes these at request time. See cli/oauth/ + daemon/orchestrator/oauth/.
  oauth: {
    dir: join(AFW_HOME, 'oauth'),
    claudeCode: join(AFW_HOME, 'oauth', 'claude-code.json'),
    codex: join(AFW_HOME, 'oauth', 'codex.json'),
  },
  // afw-issued API keys — auth tokens a generic OpenAI/Anthropic-compatible
  // agent presents to the /v1 wire. See core/access-keys.ts.
  keys: join(AFW_HOME, 'keys.json'),
  // The three fixed model tiers (Tall/Grande/Venti) → each user-mapped to a
  // model/chain/fusion. The /v1 endpoint selects a tier by request model name.
  // See core/tiers.ts.
  tiers: join(AFW_HOME, 'tiers.json'),
  // Credential-masking config — which built-in mask rules are disabled.
  // See core/masking.ts.
  masking: join(AFW_HOME, 'masking.json'),
  // OGR gateway policy — composition + per-detector config the deployer owns.
  // afw is the OGR *gateway* altitude; this file drives its detectors. See
  // daemon/ogr/. Absent → the bundled default policy is used.
  ogrPolicy: join(AFW_HOME, 'ogr.policy.json'),
  // Tool providers (web_search backends, etc.) — see core/tool-providers.ts.
  // The afw-tools MCP server reads this file at request time to decide
  // which backend to use for each capability.
  toolProviders: join(AFW_HOME, 'tool-providers.json'),
  agent: {
    claudeCode: {
      settings: join(HOME, '.claude', 'settings.json'),
      legacy: join(HOME, '.claude.json'),
    },
    claudeDesktop: {
      root: join(HOME, 'Library', 'Application Support', 'Claude'),
      mcpConfig: join(
        HOME,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json',
      ),
    },
    openclaw: join(HOME, '.openclaw', 'openclaw.json'),
    opencode: join(HOME, '.config', 'opencode', 'opencode.json'),
    hermes: {
      config: join(HOME, '.hermes', 'config.yaml'),
      env: join(HOME, '.hermes', '.env'),
    },
    codex: {
      config: join(HOME, '.codex', 'config.toml'),
      auth: join(HOME, '.codex', 'auth.json'),
    },
    cursor: {
      darwin: join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json'),
      linux: join(HOME, '.config', 'Cursor', 'User', 'settings.json'),
    },
    gemini: join(HOME, '.gemini', '.env'),
  },
} as const

export const PRICING_OVERRIDE = join(AFW_HOME, 'pricing.json')

// Runtime-refreshed pricing catalog overlay (models.dev), written by the
// opt-in auto-refresh loop. Distinct from the bundled catalog.json shipped
// in the package — this one, when present, takes precedence so prices stay
// fresh without a afw upgrade. Off by default (config.autoRefreshPricing).
export const PRICING_CATALOG_CACHE = join(AFW_HOME, 'pricing-catalog.json')

// Port override exists for tests (smoke test spins a daemon on a throwaway
// port so it never collides with the user's real daemon on 9877). AFW_PORT still honored.
export const DAEMON_PORT = (() => {
  const p = process.env.AFW_PORT
  return p ? Number.parseInt(p, 10) : 9877
})()
export const DAEMON_HOST = 'localhost'
export const DAEMON_BASE_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}`
