import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentId } from '../../core/agent.ts'
import { newBackupId } from '../../core/ids.ts'
import { type BackupEntry, type ChangeRecord, MANIFEST_VERSION } from '../../core/manifest.ts'
import { paths } from '../../core/paths.ts'
import { atomicWrite, backupCopy, fileExists, sha256OfString } from '../backup/files.ts'
import { revertEntries } from '../backup/restore.ts'
import { applyJsonUpdate, getValueAt, parseJsonc, parseTree } from '../rewrite/jsonc.ts'
import { decoderFor } from '../wire/decoder-for.ts'
import { afwUrlFor } from '../wire/url.ts'
import { buildWireSecrets, captureClaudeCodeCredentials } from './credentials.ts'
import {
  type McpServerEntry,
  injectAfwToolsMcp,
  isAlreadyWrapped,
  isRelayedUrl,
  mcpRelayUrl,
  wrapStdioCommand,
} from './mcp.ts'
import type {
  Detection,
  Detector,
  PlannedEndpoint,
  PlannedMcpServer,
  UnwireOptions,
  WireOutcome,
} from './types.ts'

const AGENT: AgentId = 'claude-code'
const ANTHROPIC_DEFAULT = 'https://api.anthropic.com'

type ClaudeSettings = {
  env?: Record<string, string>
  [key: string]: unknown
}

type ClaudeLegacy = {
  mcpServers?: Record<string, McpServerEntry>
  [key: string]: unknown
}

export const claudeCodeDetector: Detector = {
  agent: AGENT,
  mode: 'launch-per-task',

  async detect(): Promise<Detection | null> {
    const settingsPath = paths.agent.claudeCode.settings
    const legacyPath = paths.agent.claudeCode.legacy

    const settingsExists = await fileExists(settingsPath)
    const legacyExists = await fileExists(legacyPath)
    if (!settingsExists && !legacyExists) return null

    const configPaths: string[] = []
    const endpoints: PlannedEndpoint[] = []
    const mcpServers: PlannedMcpServer[] = []
    const caveats: string[] = []

    // 1. Endpoint redirect lives in ~/.claude/settings.json (env block)
    if (settingsExists) {
      configPaths.push(settingsPath)
      const settings = await readJson<ClaudeSettings>(settingsPath)
      const currentBaseUrl = (settings?.env?.ANTHROPIC_BASE_URL ?? '').trim() || ANTHROPIC_DEFAULT
      const isAlreadyWired = currentBaseUrl.startsWith('http://localhost:9877/wire/')
      const upstream = isAlreadyWired ? ANTHROPIC_DEFAULT : currentBaseUrl
      const afwBaseUrl = afwUrlFor(AGENT)
      endpoints.push({
        // Wildcard route — claude-code talks anthropic-messages with
        // many models (claude-opus-4-7, claude-haiku-*, etc.) that grow
        // by observation. One route covers them all.
        modelId: '*',
        originalBaseUrl: currentBaseUrl,
        afwBaseUrl,
        upstream,
        decoder: decoderFor(upstream),
        configLocation: '/env/ANTHROPIC_BASE_URL',
        filePath: settingsPath,
        active: true,
      })
      if (isAlreadyWired) {
        caveats.push('settings.json already points at afw; re-wire is idempotent.')
      }
    }

    // 2. MCP servers live in ~/.claude.json under `mcpServers`
    if (legacyExists) {
      const legacy = await readJson<ClaudeLegacy>(legacyPath)
      const servers = legacy?.mcpServers ?? {}
      if (Object.keys(servers).length > 0 && !configPaths.includes(legacyPath)) {
        configPaths.push(legacyPath)
      }

      let alreadyWrapped = 0
      for (const [name, server] of Object.entries(servers)) {
        const transport: 'stdio' | 'http' | 'sse' =
          server.type === 'http' || server.type === 'sse' ? server.type : 'stdio'
        // Idempotency: stdio wraps via afw-tap; http/sse repoint url at the relay.
        if (transport === 'stdio' ? isAlreadyWrapped(server) : isRelayedUrl(server.url)) {
          alreadyWrapped++
          continue
        }
        // An http/sse entry with no url has nothing to relay — skip quietly.
        if (transport !== 'stdio' && !server.url) continue
        mcpServers.push({
          name,
          transport,
          filePath: legacyPath,
          configLocation: `/mcpServers/${name}`,
          originalCommand: server.command,
          originalArgs: server.args,
          originalUrl: server.url,
          env: server.env,
        })
      }
      if (alreadyWrapped > 0) {
        caveats.push(`${alreadyWrapped} MCP server(s) already wired by afw.`)
      }
    }

    // Capture the agent's own credential so the orchestrator can inject it
    // for cross-agent routes (and same-provider routes afw now manages).
    const creds = await captureClaudeCodeCredentials()
    for (const ep of endpoints) {
      // claude-code's credential capture returns a Map keyed by the
      // legacy 'anthropic' provider name. With the new schema we don't
      // track provider separately, but there's only one credential per
      // agent here, so take the first.
      const c = creds.values().next().value
      if (c) ep.auth = c.auth
    }

    return {
      agent: AGENT,
      mode: 'launch-per-task',
      configPaths,
      endpoints,
      mcpServers,
      caveats,
    }
  },

  async wire(detection: Detection): Promise<WireOutcome> {
    const backupEntries: BackupEntry[] = []
    const allChanges: ChangeRecord[] = []

    // 1. settings.json env redirect (skip if already wired — idempotent)
    const ep = detection.endpoints[0]
    if (ep && ep.originalBaseUrl !== ep.afwBaseUrl) {
      const entry = await wireEnvRedirect(ep)
      backupEntries.push(entry)
      allChanges.push(...entry.changes)
    }

    // 2. ~/.claude.json mcpServers wraps
    if (detection.mcpServers.length > 0) {
      const entry = await wireMcpServers(detection.mcpServers)
      if (entry) {
        backupEntries.push(entry)
        allChanges.push(...entry.changes)
      }
    }

    // 3. Inject mcpServers.afw so the agent picks up afw's local
    //    tool surface (web_search, web_fetch, …) regardless of routing.
    //    Idempotent + file-creating; same machinery as claude-desktop.
    const toolsEntry = await injectAfwToolsMcp(AGENT, paths.agent.claudeCode.legacy)
    if (toolsEntry) {
      backupEntries.push(toolsEntry)
      allChanges.push(...toolsEntry.changes)
    }

    const captured = await captureClaudeCodeCredentials()
    return {
      backupEntries,
      changes: allChanges,
      secrets: buildWireSecrets(AGENT, detection.endpoints, captured),
    }
  },

  async unwire(entries: BackupEntry[], opts?: UnwireOptions) {
    return revertEntries(entries, AGENT, opts)
  },
}

async function wireEnvRedirect(ep: PlannedEndpoint): Promise<BackupEntry> {
  const settingsPath = ep.filePath
  const originalText = await readFile(settingsPath, 'utf8')
  const originalSha = sha256OfString(originalText)

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(paths.backups.dir, ts, AGENT)
  const backupPath = join(backupDir, 'settings.json')
  await backupCopy(settingsPath, backupPath)

  // Record the pre-wire structure so revert can tell "restore the user's
  // own base_url" apart from "delete the key afw added".
  const tree = parseTree(originalText)
  const envExisted = tree ? getValueAt(tree, ['env']) !== undefined : false
  const priorBaseUrl = tree ? getValueAt<string>(tree, ['env', 'ANTHROPIC_BASE_URL']) : undefined

  const newText = applyJsonUpdate(originalText, ['env', 'ANTHROPIC_BASE_URL'], ep.afwBaseUrl)

  await atomicWrite(settingsPath, newText)
  const rewrittenSha = sha256OfString(newText)

  const changes: ChangeRecord[] = []
  if (!envExisted) {
    changes.push({ type: 'create-path', jsonPointer: '/env' })
  }
  changes.push(
    priorBaseUrl === undefined
      ? { type: 'set', jsonPointer: ep.configLocation, fromAbsent: true, to: ep.afwBaseUrl }
      : { type: 'set', jsonPointer: ep.configLocation, from: priorBaseUrl, to: ep.afwBaseUrl },
  )

  return {
    id: newBackupId(),
    agent: AGENT,
    originalPath: settingsPath,
    backupPath,
    originalSha256: originalSha,
    rewrittenSha256: rewrittenSha,
    wiredAt: Date.now(),
    changes,
    manifestVersion: MANIFEST_VERSION,
  }
}

async function wireMcpServers(plans: PlannedMcpServer[]): Promise<BackupEntry | null> {
  if (plans.length === 0) return null
  const first = plans[0]
  if (!first) return null
  const filePath = first.filePath
  if (plans.some((p) => p.filePath !== filePath)) {
    throw new Error('claude-code: MCP plans across multiple files not supported')
  }

  const originalText = await readFile(filePath, 'utf8')
  const originalSha = sha256OfString(originalText)

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(paths.backups.dir, ts, AGENT)
  const backupPath = join(backupDir, 'claude.json')
  await backupCopy(filePath, backupPath)

  let text = originalText
  const changes: ChangeRecord[] = []
  for (const plan of plans) {
    if (plan.transport === 'http' || plan.transport === 'sse') {
      // http/sse: repoint `url` at the local relay. `type` stays as-is.
      // A plain `set` change (not wrap-mcp, which only restores command/args)
      // so unwire restores the original url via the generic reversal.
      const relayUrl = mcpRelayUrl(AGENT, plan.name)
      text = applyJsonUpdate(text, ['mcpServers', plan.name, 'url'], relayUrl)
      changes.push({
        type: 'set',
        jsonPointer: `/mcpServers/${plan.name}/url`,
        from: plan.originalUrl,
        to: relayUrl,
      })
      continue
    }
    const wrapped = wrapStdioCommand(
      { command: plan.originalCommand, args: plan.originalArgs },
      AGENT,
      plan.name,
    )
    text = applyJsonUpdate(text, ['mcpServers', plan.name, 'command'], wrapped.command)
    text = applyJsonUpdate(text, ['mcpServers', plan.name, 'args'], wrapped.args)
    changes.push({
      type: 'wrap-mcp',
      name: plan.name,
      from: {
        command: plan.originalCommand,
        args: plan.originalArgs,
        env: plan.env,
        type: plan.transport,
      },
      to: {
        command: wrapped.command,
        args: wrapped.args,
        env: plan.env,
        type: plan.transport,
      },
    })
  }

  await atomicWrite(filePath, text)
  const rewrittenSha = sha256OfString(text)

  return {
    id: newBackupId(),
    agent: AGENT,
    originalPath: filePath,
    backupPath,
    originalSha256: originalSha,
    rewrittenSha256: rewrittenSha,
    wiredAt: Date.now(),
    changes,
    manifestVersion: MANIFEST_VERSION,
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const text = await readFile(path, 'utf8')
    return parseJsonc<T>(text)
  } catch {
    return undefined
  }
}
