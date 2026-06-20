import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentId } from '../../core/agent.ts'
import { newBackupId } from '../../core/ids.ts'
import { type BackupEntry, type ChangeRecord, MANIFEST_VERSION } from '../../core/manifest.ts'
import { paths } from '../../core/paths.ts'
import { wildcardRouteKey } from '../../core/routes.ts'
import { atomicWrite, backupCopy, fileExists, sha256OfString } from '../backup/files.ts'
import { revertEntries } from '../backup/restore.ts'
import { applyJsonUpdate, parseJsonc } from '../rewrite/jsonc.ts'
import { afwUrlFor } from '../wire/url.ts'
import { captureClaudeCodeCredentials } from './credentials.ts'
import {
  type McpServerEntry,
  injectAfwToolsMcp,
  isAlreadyWrapped,
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

const AGENT: AgentId = 'claude-desktop'
const ANTHROPIC_DEFAULT = 'https://api.anthropic.com'

// Format-validation placeholder: Claude Desktop client-side-checks that
// the gateway API key matches Anthropic's sk-ant-api03-* shape (~108
// chars). The value is never used for actual auth — afw strips the
// client header and re-injects the real credential from secrets.json
// before forwarding upstream.
const PLACEHOLDER_API_KEY =
  'sk-ant-api03-afw-managed-placeholder-substitute-downstream-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

type DesktopConfig = {
  mcpServers?: Record<string, McpServerEntry>
  [key: string]: unknown
}

export const claudeDesktopDetector: Detector = {
  agent: AGENT,
  mode: 'manual',

  async detect(): Promise<Detection | null> {
    if (!(await fileExists(paths.agent.claudeDesktop.root))) return null

    const configPaths: string[] = []
    const mcpServers: PlannedMcpServer[] = []
    const caveats: string[] = []

    const mcpPath = paths.agent.claudeDesktop.mcpConfig
    if (await fileExists(mcpPath)) {
      const cfg = await readJson<DesktopConfig>(mcpPath)
      const servers = cfg?.mcpServers ?? {}
      if (Object.keys(servers).length > 0) configPaths.push(mcpPath)

      let alreadyWrapped = 0
      let httpSkipped = 0
      for (const [name, server] of Object.entries(servers)) {
        const transport: 'stdio' | 'http' | 'sse' =
          server.type === 'http' || server.type === 'sse' ? server.type : 'stdio'
        if (transport !== 'stdio') {
          httpSkipped++
          continue
        }
        if (isAlreadyWrapped(server)) {
          alreadyWrapped++
          continue
        }
        mcpServers.push({
          name,
          transport,
          filePath: mcpPath,
          configLocation: `/mcpServers/${name}`,
          originalCommand: server.command,
          originalArgs: server.args,
          originalUrl: server.url,
          env: server.env,
        })
      }
      if (alreadyWrapped > 0) {
        caveats.push(`${alreadyWrapped} MCP server(s) already wrapped by afw-tap.`)
      }
      if (httpSkipped > 0) {
        caveats.push(`${httpSkipped} http/sse MCP server(s) skipped (stdio only).`)
      }
    }

    // why: the wildcard endpoint exists so the proxy has a route to match
    // when Claude Desktop sends traffic. The user enters the URL into
    // Claude Desktop's third-party-inference panel manually — the encrypted
    // Preferences blob isn't safe to auto-edit.
    const endpoints: PlannedEndpoint[] = [
      {
        modelId: '*',
        originalBaseUrl: ANTHROPIC_DEFAULT,
        afwBaseUrl: afwUrlFor(AGENT),
        upstream: ANTHROPIC_DEFAULT,
        decoder: 'anthropic',
        configLocation: '(manual — set in Claude Desktop UI)',
        filePath: paths.agent.claudeDesktop.root,
        active: true,
      },
    ]

    // why: Claude Desktop's UI accepts only an sk-ant-* shaped placeholder
    // because of client-side format validation — the real credential has
    // to come from afw. The user's already-wired Claude Code is the natural
    // source for a *static* Anthropic key (copied into a afw-owned secret keyed
    // for the claude-desktop route). For a Claude.ai subscription the user logs
    // in to afw itself (`afw oauth login anthropic`) — afw never reads the
    // agent's own login.
    const ccCred = (await captureClaudeCodeCredentials()).get('anthropic')
    if (ccCred) {
      endpoints[0]!.auth = ccCred.auth
    } else {
      caveats.push(
        'no Anthropic API key found via claude-code — set ANTHROPIC_API_KEY in ' +
          '~/.claude/settings.json env, or run `afw oauth login anthropic` to route ' +
          'through a Claude.ai subscription. Until then, Claude Desktop requests ' +
          'will be rejected by Anthropic with 401.',
      )
    }

    return {
      agent: AGENT,
      mode: 'manual',
      configPaths,
      endpoints,
      mcpServers,
      caveats,
    }
  },

  async wire(detection: Detection): Promise<WireOutcome> {
    const backupEntries: BackupEntry[] = []
    const allChanges: ChangeRecord[] = []

    if (detection.mcpServers.length > 0) {
      const entry = await wireMcpServers(detection.mcpServers)
      if (entry) {
        backupEntries.push(entry)
        allChanges.push(...entry.changes)
      }
    }

    // Inject the afw tool surface (web_search etc.) as an MCP server
    // so any wired agent picks up local fulfilments for the
    // capabilities a routed model can't provide itself. Runs even when
    // there are no existing MCP servers to wrap — the file is created
    // if missing.
    const toolsEntry = await injectAfwToolsMcp(AGENT, paths.agent.claudeDesktop.mcpConfig)
    if (toolsEntry) {
      backupEntries.push(toolsEntry)
      allChanges.push(...toolsEntry.changes)
    }

    // Persist the static credential value (if any) under this route's key
    // so the proxy can read it at request time. An agent-oauth route carries
    // no value — the orchestrator reads afw's own OAuth token instead.
    const secrets: { ref: string; value: string }[] = []
    const ccCred = (await captureClaudeCodeCredentials()).get('anthropic')
    if (ccCred?.value !== undefined) {
      secrets.push({
        ref: `provider:${wildcardRouteKey(AGENT)}`,
        value: ccCred.value,
      })
    }

    return { backupEntries, changes: allChanges, secrets }
  },

  async unwire(entries: BackupEntry[], opts?: UnwireOptions) {
    return revertEntries(entries, AGENT, opts)
  },

  manualInstructions(detection: Detection): string {
    const ep = detection.endpoints[0]
    const url = ep?.afwBaseUrl ?? afwUrlFor(AGENT)
    return [
      "Claude Desktop's third-party-inference settings live on Anthropic's",
      'account server (not in any local file), so the connection must be',
      'configured by hand — once:',
      '',
      '  1. Enable Developer Mode (one time):',
      '       Menu  Help → Troubleshooting → Enable Developer Mode',
      '     Claude Desktop will restart automatically.',
      '',
      '  2. After restart, from the menu bar:',
      '       Developer → Configure Third-Party Inference… → Connection',
      '     Choose "Gateway".',
      '',
      '  3. Under "Gateway credentials":',
      '       Credential kind     :  Static API key',
      `       Gateway base URL    :  ${url}`,
      `       Gateway API key     :  ${PLACEHOLDER_API_KEY}`,
      '         (Claude Desktop client-side-validates the key format —',
      '          must look like a real sk-ant-api03-* key. afw strips',
      "          this header and re-injects claude-code's captured",
      '          credential before forwarding upstream, so this value is',
      '          never used for actual auth.)',
      '       Gateway auth scheme :  bearer',
      '',
      '  4. Keep "Model discovery" ON (the default).',
      '     afw serves the model list from /v1/models.',
      '',
      '  5. Save / close the panel. Done.',
    ].join('\n')
  },
}

async function wireMcpServers(plans: PlannedMcpServer[]): Promise<BackupEntry | null> {
  if (plans.length === 0) return null
  const first = plans[0]
  if (!first) return null
  const filePath = first.filePath
  if (plans.some((p) => p.filePath !== filePath)) {
    throw new Error('claude-desktop: MCP plans across multiple files not supported')
  }

  const originalText = await readFile(filePath, 'utf8')
  const originalSha = sha256OfString(originalText)

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(paths.backups.dir, ts, AGENT)
  const backupPath = join(backupDir, 'claude_desktop_config.json')
  await backupCopy(filePath, backupPath)

  let text = originalText
  const changes: ChangeRecord[] = []
  for (const plan of plans) {
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
