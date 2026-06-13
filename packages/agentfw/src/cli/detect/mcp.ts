import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'
import type { AgentId } from '../../core/agent.ts'
import { newBackupId } from '../../core/ids.ts'
import { type BackupEntry, type ChangeRecord, MANIFEST_VERSION } from '../../core/manifest.ts'
import { DAEMON_BASE_URL, paths } from '../../core/paths.ts'
import { atomicWrite, backupCopy, fileExists, sha256OfString } from '../backup/files.ts'
import { applyJsonUpdate, parseJsonc } from '../rewrite/jsonc.ts'

export type McpServerEntry = {
  type?: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  [key: string]: unknown
}

export type WrappedMcpEntry = {
  command: string
  args: string[]
}

/**
 * Compute how to invoke agentfw-tap for wrapping an MCP server. Detects
 * dev (.ts source) vs prod (binary on $PATH) by inspecting how the
 * currently-running CLI was invoked.
 */
export function tapInvocation(opts: { agent: AgentId; server: string }): {
  command: string
  args: string[]
} {
  const entry = process.argv[1]
  if (!entry) throw new Error('agentfw-tap: cannot resolve current entry path')

  const isTs = entry.endsWith('.ts')
  const wrapArgs = ['--agent', opts.agent, '--server', opts.server, '--']

  if (isTs) {
    const realAgentfw = safeRealpath(entry)
    const tapEntry = realAgentfw.replace(/\/agentfw\.ts$/, '/tap.ts')
    return {
      command: process.execPath,
      args: ['--experimental-strip-types', tapEntry, ...wrapArgs],
    }
  }

  // Production: npm install -g @openguardrails/agentfw puts agentfw-tap on $PATH
  return { command: 'agentfw-tap', args: wrapArgs }
}

// The stdio-tap bin names this build understands when detecting existing
// wraps — the current `agentfw-tap` plus the legacy `agentfw-tap` so
// pre-rename wiring is still recognized and can be unwired/re-wired.
const TAP_BIN_NAMES = ['agentfw-tap', 'agentfw-tap']
const TOOLS_BIN_NAMES = ['agentfw-tools', 'agentfw-tools']

/**
 * Build the wrapped command/args for a stdio MCP server. Preserves the
 * original command and args by appending them after the `--` separator.
 */
export function wrapStdioCommand(
  original: McpServerEntry,
  agent: AgentId,
  server: string,
): WrappedMcpEntry {
  const tap = tapInvocation({ agent, server })
  const origCommand = original.command ?? ''
  const origArgs = original.args ?? []
  return {
    command: tap.command,
    args: [...tap.args, origCommand, ...origArgs],
  }
}

/** Path segment for the MCP relay — distinct from the model-proxy `/wire/`. */
export const MCP_RELAY_PREFIX = 'wire-mcp'

/**
 * The local relay URL an http/sse MCP server's `url` is repointed at. The
 * daemon's relay forwards to the real upstream (recorded in routes.json) and
 * captures every JSON-RPC frame.
 */
export function mcpRelayUrl(agent: AgentId, server: string): string {
  return `${DAEMON_BASE_URL}/${MCP_RELAY_PREFIX}/${agent}/${encodeURIComponent(server)}`
}

/** True when a url already points at the agentfw MCP relay (idempotency). */
export function isRelayedUrl(url: string | undefined): boolean {
  return typeof url === 'string' && url.includes(`/${MCP_RELAY_PREFIX}/`)
}

/**
 * Is this entry already a agentfw-tap wrap? Used for idempotency in detect.
 */
export function isAlreadyWrapped(entry: McpServerEntry): boolean {
  if (!entry.command) return false
  if (TAP_BIN_NAMES.includes(entry.command)) return true
  // Dev: `node --experimental-strip-types /path/tap.ts --agent ...`
  if (entry.command === process.execPath) {
    return (entry.args ?? []).some((a) => a.endsWith('/tap.ts'))
  }
  return false
}

/**
 * The mcpServers config key used for the agentfw-provided tool surface
 * (web_search, etc.). Short, lowercase, no hyphens — agents fold this
 * into `mcp__agentfw__<tool>` when surfacing tools to the model. The
 * legacy `agentfw` key is still recognized (see TOOLS_MCP_KEYS) so a config
 * wired before the rename is detected and cleanly re-wired/unwired.
 */
export const AGENTFW_TOOLS_MCP_KEY = 'agentfw'

/** Keys this build recognizes as the agentfw tools MCP — current plus the
 *  pre-rename `agentfw` key, so existing wiring is still found. */
export const TOOLS_MCP_KEYS = ['agentfw', 'agentfw'] as const

/**
 * Compute how to invoke the agentfw-tools stdio MCP server. Mirrors
 * tapInvocation so dev (.ts source via --experimental-strip-types)
 * and prod (binary on $PATH installed by npm) both work.
 */
export function agentfwToolsInvocation(): WrappedMcpEntry {
  const entry = process.argv[1]
  if (!entry) throw new Error('agentfw-tools: cannot resolve current entry path')

  const isTs = entry.endsWith('.ts')
  if (isTs) {
    const realAgentfw = safeRealpath(entry)
    const toolsEntry = realAgentfw.replace(/\/agentfw\.ts$/, '/tools.ts')
    return {
      command: process.execPath,
      args: ['--experimental-strip-types', toolsEntry],
    }
  }
  return { command: 'agentfw-tools', args: [] }
}

/**
 * True when this entry is already a agentfw-tools MCP — covers both dev
 * (node --experimental-strip-types /…/tools.ts) and prod (`agentfw-tools`
 * on $PATH). Used for idempotency at wire time so we don't double-write.
 */
export function isAgentfwToolsEntry(entry: McpServerEntry): boolean {
  if (!entry.command) return false
  if (TOOLS_BIN_NAMES.includes(entry.command)) return true
  if (entry.command === process.execPath) {
    return (entry.args ?? []).some((a) => a.endsWith('/tools.ts'))
  }
  return false
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

type McpConfigShape = {
  mcpServers?: Record<string, McpServerEntry>
  [key: string]: unknown
}

/**
 * Add an `mcpServers.agentfw` entry to a JSON(C) config file so the
 * agent picks up the agentfw-provided tool surface (web_search,
 * web_fetch, …). Idempotent — bails out when an entry already exists
 * and matches. Creates the file with `{}` content when missing. The
 * returned BackupEntry records a surgical reverse-replay so unwire
 * removes only the agentfw key, leaving the user's other mcpServers
 * (and the file itself) intact.
 *
 * Used by detectors whose agent already speaks MCP via mcpServers
 * (claude-code, claude-desktop, …). Each detector knows its own
 * config file path; the rest of the dance is identical, so it lives
 * here as one function instead of being copy-pasted per detector.
 */
export async function injectAgentfwToolsMcp(
  agent: AgentId,
  filePath: string,
): Promise<BackupEntry | null> {
  const exists = await fileExists(filePath)
  let originalText = ''
  let parsed: McpConfigShape | undefined
  if (exists) {
    originalText = await readFile(filePath, 'utf8')
    parsed = parseJsonc<McpConfigShape>(originalText)
    const existing = parsed?.mcpServers?.[AGENTFW_TOOLS_MCP_KEY]
    if (existing && isAgentfwToolsEntry(existing)) return null
  }

  const inv = agentfwToolsInvocation()
  const newEntry = { command: inv.command, args: inv.args }

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(paths.backups.dir, ts, agent)
  const backupPath = join(backupDir, basename(filePath))
  if (exists) {
    await backupCopy(filePath, backupPath)
  } else {
    await atomicWrite(backupPath, '')
  }

  const originalSha = sha256OfString(originalText)

  let text = originalText === '' ? '{}\n' : originalText
  const changes: ChangeRecord[] = []
  if (!parsed?.mcpServers) {
    text = applyJsonUpdate(text, ['mcpServers'], {})
    changes.push({ type: 'create-path', jsonPointer: '/mcpServers' })
  }
  text = applyJsonUpdate(text, ['mcpServers', AGENTFW_TOOLS_MCP_KEY], newEntry)
  changes.push({
    type: 'set',
    jsonPointer: `/mcpServers/${AGENTFW_TOOLS_MCP_KEY}`,
    fromAbsent: true,
    to: newEntry,
  })

  await atomicWrite(filePath, text)
  const rewrittenSha = sha256OfString(text)

  return {
    id: newBackupId(),
    agent,
    originalPath: filePath,
    backupPath,
    originalSha256: originalSha,
    rewrittenSha256: rewrittenSha,
    wiredAt: Date.now(),
    changes,
    manifestVersion: MANIFEST_VERSION,
  }
}
