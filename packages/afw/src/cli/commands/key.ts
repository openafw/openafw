// `afw key` — mint and manage afw API keys. A key is a SHORT local
// identifier that distinguishes one agent (or agent session) from another — not
// a security secret. Each key names the agent it represents. App/daemon agents
// (OpenClaw, Hermes) present their key to the /v1 endpoint and request a tier
// model name (Tall / Grande / Venti); launch-per-task agents (Claude Code,
// Codex) get a session key auto-minted on launch.

import process from 'node:process'
import { Command } from 'commander'
import type { AccessKeyEntry } from '../../core/access-keys.ts'
import type { AgentId } from '../../core/agent.ts'
import { logger } from '../../core/logger.ts'
import type { RoutingTarget } from '../../core/routing-policy.ts'
import { ensureDaemonRunning } from '../launch/daemon-autostart.ts'
import { daemonFetch } from '../util/daemon-client.ts'
import { promptText } from '../util/prompt.ts'

type Connection = {
  baseUrl: string
  anthropicBaseUrl: string
  port: number
  modelNames: Array<{ tier: string; name: string; rank: number }>
}
type KeysResponse = { keys: AccessKeyEntry[]; connection: Connection }
type CreateResponse = { key: AccessKeyEntry; created?: boolean; connection: Connection }
type TierRow = { tier: string; display: string; rank: number; target?: RoutingTarget }
type TiersResponse = { tiers: TierRow[] }

function describeTarget(t: RoutingTarget | undefined): string {
  if (!t || t.kind === 'passthrough') return 'not mapped — run `afw tier`'
  if (t.kind === 'composite') return `fusion ${t.comboId}`
  if (t.kind === 'chain') {
    return t.members.length === 1
      ? t.members[0]!.modelId
      : `${t.members.map((m) => m.modelId).join(' → ')} (failover)`
  }
  return 'not mapped'
}

/** Render the copy-paste block: base URLs, the API key, and the three model
 *  names with what each currently maps to. */
export function renderConnectionBlock(
  key: AccessKeyEntry,
  conn: Connection,
  tiers: TierRow[],
): string {
  const byTier = new Map(tiers.map((t) => [t.tier, t]))
  const modelLines = conn.modelNames.map((m) => {
    const t = byTier.get(m.tier)
    return `    ${m.name.padEnd(8)} → ${describeTarget(t?.target)}`
  })
  return [
    `✓ API key "${key.label}" (${key.agent}) ready.`,
    '',
    '  Point this agent at afw:',
    '',
    `    Base URL (OpenAI-compatible):  ${conn.baseUrl}`,
    `    Base URL (Anthropic):          ${conn.anthropicBaseUrl}`,
    `    API key:                       ${key.token}`,
    '',
    '  Model names (low → high) and what they route to:',
    ...modelLines,
  ].join('\n')
}

/** Create a key via the daemon and print the connection block. */
export async function createAndShowKey(opts: {
  label?: string
  agent?: AgentId
}): Promise<AccessKeyEntry> {
  const res = await daemonFetch<CreateResponse>('POST', '/api/keys', {
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.agent ? { agent: opts.agent } : {}),
  })
  const { tiers } = await daemonFetch<TiersResponse>('GET', '/api/tiers')
  logger.print('')
  logger.print(renderConnectionBlock(res.key, res.connection, tiers))
  return res.key
}

/** Find-or-create the session key for a launch-per-task agent's directory
 *  instance. Idempotent server-side. Returns the key and whether it was new. */
export async function ensureSessionKey(
  agent: AgentId,
  instance: string,
): Promise<{ key: AccessKeyEntry; created: boolean }> {
  const res = await daemonFetch<CreateResponse>('POST', '/api/keys', {
    agent,
    instance,
    label: instance,
  })
  return { key: res.key, created: res.created !== false }
}

/** Fetch the keys for one agent (or all when agent is omitted). */
export async function listKeysFor(agent?: AgentId): Promise<AccessKeyEntry[]> {
  const path = agent ? `/api/keys?agent=${encodeURIComponent(agent)}` : '/api/keys'
  return (await daemonFetch<KeysResponse>('GET', path)).keys
}

/** Print a key list (id, token, agent/instance, last-used). */
export function printKeyList(keys: AccessKeyEntry[]): void {
  for (const k of keys) {
    const used = k.lastUsedAt ? new Date(k.lastUsedAt).toISOString().slice(0, 10) : 'never'
    const who = k.instance ? `${k.agent}@${k.instance}` : k.agent
    logger.print(`  ${k.id.padEnd(18)} ${k.token.padEnd(12)} ${who.padEnd(24)} used:${used}`)
  }
}

// ── subcommands ───────────────────────────────────────────────────

const addCmd = new Command('add')
  .description('Mint an API key (a short local identifier) for an agent.')
  .option('--label <name>', 'key label')
  .option('--agent <id>', 'agent this key represents (default: byok)')
  .action(async (opts: { label?: string; agent?: string }) => {
    try {
      await ensureDaemonRunning()
      const label = opts.label ?? (await promptText('Key label', 'default'))
      await createAndShowKey({ label: label || 'default', agent: opts.agent })
    } catch (e) {
      logger.print(`error: ${(e as Error).message}`)
      process.exitCode = 1
    }
  })

const listCmd = new Command('list')
  .description('List the API keys afw has issued.')
  .option('--agent <id>', 'only this agent')
  .action(async (opts: { agent?: string }) => {
    try {
      const keys = await listKeysFor(opts.agent)
      if (keys.length === 0) {
        logger.print('No keys yet — create one with `afw key add`.')
        return
      }
      printKeyList(keys)
    } catch (e) {
      logger.print(`error: ${(e as Error).message}`)
      process.exitCode = 1
    }
  })

const showCmd = new Command('show')
  .description('Print the connection details (URL, key, model names) for one key.')
  .argument('<id>', 'key id (see `afw key list`)')
  .action(async (id: string) => {
    try {
      const { keys, connection } = await daemonFetch<KeysResponse>('GET', '/api/keys')
      const key = keys.find((k) => k.id === id)
      if (!key) {
        logger.print(`unknown key "${id}". See \`afw key list\`.`)
        process.exitCode = 1
        return
      }
      const { tiers } = await daemonFetch<TiersResponse>('GET', '/api/tiers')
      logger.print(renderConnectionBlock(key, connection, tiers))
    } catch (e) {
      logger.print(`error: ${(e as Error).message}`)
      process.exitCode = 1
    }
  })

const rmCmd = new Command('rm')
  .description('Revoke an API key.')
  .argument('<id>', 'key id (see `afw key list`)')
  .action(async (id: string) => {
    try {
      await daemonFetch('DELETE', `/api/keys?id=${encodeURIComponent(id)}`)
      logger.print(`✓ revoked key ${id}`)
    } catch (e) {
      logger.print(`error: ${(e as Error).message}`)
      process.exitCode = 1
    }
  })

export const keyCommand = new Command('key')
  .description('Mint and manage afw API keys (short local agent identifiers).')
  .addCommand(addCmd)
  .addCommand(listCmd)
  .addCommand(showCmd)
  .addCommand(rmCmd)
