import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const HOME = homedir()

/** Resolve the agentfw home directory. Honors an explicit `AGENTFW_HOME`
 *  override; otherwise `~/.agentfw`. */
function resolveHome(): string {
  return process.env.AGENTFW_HOME ?? join(HOME, '.agentfw')
}

export const AGENTFW_HOME = resolveHome()

export const paths = {
  home: AGENTFW_HOME,
  wire: {
    dir: join(AGENTFW_HOME, 'wire'),
    routes: join(AGENTFW_HOME, 'wire', 'routes.json'),
    traces: join(AGENTFW_HOME, 'wire', 'traces'),
    // Cold per-day archive files (YYYY-MM-DD.db) written when prune evicts
    // old data from the active store, so nothing is lost on retention.
    tracesArchive: join(AGENTFW_HOME, 'wire', 'traces', 'archive'),
    daemonSock: join(AGENTFW_HOME, 'wire', 'daemon.sock'),
    // PID of the running daemon — written on boot, removed on exit. Lets
    // `agentfw daemon stop/restart` find a daemon it didn't spawn itself.
    daemonPid: join(AGENTFW_HOME, 'wire', 'daemon.pid'),
  },
  backups: {
    dir: join(AGENTFW_HOME, 'backups'),
    manifest: join(AGENTFW_HOME, 'backups', 'manifest.json'),
  },
  logs: {
    dir: join(AGENTFW_HOME, 'logs'),
    daemon: join(AGENTFW_HOME, 'logs', 'daemon.log'),
    daemonErr: join(AGENTFW_HOME, 'logs', 'daemon.err'),
  },
  config: join(AGENTFW_HOME, 'config.json'),
  update: join(AGENTFW_HOME, 'update.json'),
  // Model routing & combos — see core/model-registry.ts, routing-policy.ts.
  models: join(AGENTFW_HOME, 'models.json'),
  routing: join(AGENTFW_HOME, 'routing.json'),
  secrets: join(AGENTFW_HOME, 'secrets.json'),
  // Credential-masking config — which built-in mask rules are disabled.
  // See core/masking.ts.
  masking: join(AGENTFW_HOME, 'masking.json'),
  // Tool providers (web_search backends, etc.) — see core/tool-providers.ts.
  // The agentfw-tools MCP server reads this file at request time to decide
  // which backend to use for each capability.
  toolProviders: join(AGENTFW_HOME, 'tool-providers.json'),
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

export const PRICING_OVERRIDE = join(AGENTFW_HOME, 'pricing.json')

// Runtime-refreshed pricing catalog overlay (models.dev), written by the
// opt-in auto-refresh loop. Distinct from the bundled catalog.json shipped
// in the package — this one, when present, takes precedence so prices stay
// fresh without a agentfw upgrade. Off by default (config.autoRefreshPricing).
export const PRICING_CATALOG_CACHE = join(AGENTFW_HOME, 'pricing-catalog.json')

// Port override exists for tests (smoke test spins a daemon on a throwaway
// port so it never collides with the user's real daemon on 9877). AGENTFW_PORT still honored.
export const DAEMON_PORT = (() => {
  const p = process.env.AGENTFW_PORT
  return p ? Number.parseInt(p, 10) : 9877
})()
export const DAEMON_HOST = 'localhost'
export const DAEMON_BASE_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}`
