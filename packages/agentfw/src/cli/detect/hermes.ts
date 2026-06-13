import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import type { AgentId, RuntimeMode } from '../../core/agent.ts'
import { newBackupId } from '../../core/ids.ts'
import { MANIFEST_VERSION, type BackupEntry, type ChangeRecord } from '../../core/manifest.ts'
import { paths } from '../../core/paths.ts'
import { atomicWrite, backupCopy, fileExists, sha256OfString } from '../backup/files.ts'
import { revertEntries } from '../backup/restore.ts'
import { execCapture } from '../util/exec.ts'
import { decoderFor } from '../wire/decoder-for.ts'
import { readRoutes } from '../wire/routes.ts'
import { agentfwUrlFor } from '../wire/url.ts'
import { buildWireSecrets, captureHermesCredentials } from './credentials.ts'
import { isAlreadyWrapped, type McpServerEntry, wrapStdioCommand } from './mcp.ts'
import type {
  ApplyResult,
  Detection,
  Detector,
  PlannedEndpoint,
  PlannedMcpServer,
  RunningStatus,
  UnwireOptions,
  WireOutcome,
} from './types.ts'

const AGENT: AgentId = 'hermes'
const MODE: RuntimeMode = 'repl-hotswappable'

// After wire, Hermes asks for this model name in every request. The route
// key (hermes/<provider>) carries the routing decision; the model name is
// only a stable handle so the user knows agentfw owns the model choice. Same
// pattern as OpenClaw's `AGENTFW_VIRTUAL_MODEL.id`.
const AGENTFW_MODEL_ID = 'agentfw'

/** Pick the existing model-name key for an endpoint's section, falling back
 *  to a sensible default when the user didn't set one. Hermes accepts
 *  `default` or `model` under `/model/`, and `model` or `default_model`
 *  inside each `/custom_providers/<name>/` entry. */
function pickModelKey(doc: ReturnType<typeof parseDocument>, ep: PlannedEndpoint): string {
  if (ep.configLocation === '/model/base_url') {
    const m = doc.get('model')
    if (m instanceof YAMLMap) {
      if (m.has('default')) return 'default'
      if (m.has('model')) return 'model'
    }
    return 'default'
  }
  // Parse the original provider name out of configLocation —
  // ep.modelId is now the wrap id `agentfw-hermes-<name>`, not the
  // raw provider name. The custom_providers entry is keyed by name.
  const segments = ep.configLocation.split('/').filter(Boolean)
  const providerName = segments[1] ?? ep.modelId
  const seq = doc.get('custom_providers')
  if (seq instanceof YAMLSeq) {
    for (const item of seq.items) {
      if (!(item instanceof YAMLMap)) continue
      if (item.get('name') !== providerName) continue
      if (item.has('model')) return 'model'
      if (item.has('default_model')) return 'default_model'
    }
  }
  return 'model'
}

/** Locate (or create) the custom_providers entry for `name` in `doc` and
 *  apply `mutate` to it. Returns the prior value of `entry[key]` and the
 *  jsonPointer to record in the manifest. Returns `undefined` when the
 *  entry can't be found (caller skips the rewrite). */
function withCustomProviderEntry<T>(
  doc: ReturnType<typeof parseDocument>,
  name: string,
  mutate: (entry: YAMLMap) => T,
): T | undefined {
  const seq = doc.get('custom_providers')
  if (!(seq instanceof YAMLSeq)) return undefined
  for (const item of seq.items) {
    if (!(item instanceof YAMLMap)) continue
    if (item.get('name') !== name) continue
    return mutate(item)
  }
  return undefined
}

/** Pick the endpoint Hermes actually talks to after wire — the one its
 *  `model.provider` pointer names. A named custom provider wins; an empty
 *  / `"auto"` / unmatched pointer falls back to the `model.base_url`
 *  endpoint, then the first endpoint. Only the active endpoint becomes a
 *  wire route. */
export function pickActiveEndpoint(
  endpoints: PlannedEndpoint[],
  modelProvider: string,
): PlannedEndpoint | undefined {
  const activeProvider = modelProvider.trim()
  // After the naming-convention switch, endpoint.modelId is
  // `agentfw-hermes-<providerName>`. Match the provider portion.
  const expectedId = activeProvider ? `agentfw-${AGENT}-${activeProvider}` : ''
  const named =
    activeProvider && activeProvider !== 'auto'
      ? endpoints.find(
          (e) =>
            e.modelId === expectedId &&
            e.configLocation.startsWith('/custom_providers/'),
        )
      : undefined
  return (
    named ??
    endpoints.find((e) => e.configLocation === '/model/base_url') ??
    endpoints[0]
  )
}

export const hermesDetector: Detector = {
  agent: AGENT,
  mode: MODE,

  manualInstructions(): string {
    const url = agentfwUrlFor(AGENT)
    return [
      'Hermes runs as a long-lived REPL/daemon, so agentfw does not edit its',
      'config. Point it at the wire yourself, then manage models in agentfw:',
      '',
      '  1. Register the upstream model(s) you want with agentfw:',
      '       agentfw model add',
      '',
      '  2. In ~/.hermes/config.yaml, set model.base_url (or a',
      '     custom_providers[].base_url) to the wire:',
      `       "${url}"`,
      '',
      '  3. Route that traffic in agentfw:',
      `       agentfw route set ${AGENT}/* --model <id>`,
      '',
      '  4. Reload Hermes (or paste `/model <name> --global` in the REPL).',
    ].join('\n')
  },

  async detect(): Promise<Detection | null> {
    const configPath = paths.agent.hermes.config
    if (!(await fileExists(configPath))) return null

    const text = await readFile(configPath, 'utf8')
    let doc: ReturnType<typeof parseDocument>
    try {
      doc = parseDocument(text)
    } catch (err) {
      return {
        agent: AGENT,
        mode: MODE,
        configPaths: [configPath],
        endpoints: [],
        mcpServers: [],
        caveats: [`config.yaml parse failed: ${(err as Error).message}`],
      }
    }

    const endpoints: PlannedEndpoint[] = []
    const mcpServers: PlannedMcpServer[] = []
    const caveats: string[] = []
    let alreadyWired = 0
    let alreadyWrapped = 0

    // why: when a previous wire already pointed base_url at agentfw, the
    // upstream + decoder + harvested models all live in routes.json — the
    // config no longer carries them. Look them up so a re-wire can still
    // produce a sensible PlannedEndpoint instead of silently no-op'ing.
    // Critical when an older agentfw (which only rewrote base_url) left the
    // model-name field behind: re-wire must still emit so the new wire
    // logic can finish the model-name swap.
    const existingRoutes = await readRoutes().catch(() => ({ routes: {} as Record<string, never> }))

    // 1. model.base_url
    const modelBaseUrl = String(doc.getIn(['model', 'base_url']) ?? '').trim()
    if (modelBaseUrl) {
      const providerName = String(doc.getIn(['model', 'provider']) ?? 'default')
      const agentfwBaseUrl = agentfwUrlFor(AGENT)
      const isAlreadyWired = modelBaseUrl.startsWith('http://localhost:9877/wire/')
      if (isAlreadyWired) alreadyWired++

      const modelName = String(
        doc.getIn(['model', 'default']) ?? doc.getIn(['model', 'model']) ?? '',
      ).trim()

      // Already-wired: derive upstream / decoder / harvested models from
      // routes.json (the config's base_url is now agentfw's URL). Fresh:
      // read straight from the config.
      const recorded = isAlreadyWired
        ? existingRoutes.routes[`${AGENT}/${providerName}`]
        : undefined
      const upstream = recorded?.upstream ?? modelBaseUrl
      const decoder = recorded?.decoder ?? decoderFor(modelBaseUrl)
      const harvested = recorded?.harvest
        ? recorded.harvest
        : modelName && modelName !== AGENTFW_MODEL_ID
          ? { id: modelName }
          : undefined

      endpoints.push({
        // Naming convention: `agentfw-hermes-<id>`. Single section so id
        // is the hermes provider name (often "default" or the user's
        // custom name). If hermes ever grows multi-instance support
        // (different per-agent defaults), this pattern still scales.
        modelId: `agentfw-${AGENT}-${providerName}`,
        sourceModelId: modelName || undefined,
        originalBaseUrl: upstream,
        agentfwBaseUrl,
        upstream,
        decoder,
        configLocation: '/model/base_url',
        filePath: configPath,
        ...(harvested ? { harvest: harvested } : {}),
      })
    }

    // 2. custom_providers[].base_url
    const customSeq = doc.get('custom_providers')
    if (customSeq instanceof YAMLSeq) {
      for (const item of customSeq.items) {
        if (!(item instanceof YAMLMap)) continue
        const name = item.get('name') as string | undefined
        const baseUrl = String(item.get('base_url') ?? '').trim()
        if (!name || !baseUrl) continue
        const isAlreadyWired = baseUrl.startsWith('http://localhost:9877/wire/')
        if (isAlreadyWired) alreadyWired++

        const modelName = String(
          item.get('model') ?? item.get('default_model') ?? '',
        ).trim()
        const wrappedModelId = `agentfw-${AGENT}-${name}`
        const recorded = isAlreadyWired
          ? existingRoutes.routes[`${AGENT}/${wrappedModelId}`]
          : undefined
        const upstream = recorded?.upstream ?? baseUrl
        const decoder = recorded?.decoder ?? decoderFor(baseUrl)
        const harvested = recorded?.harvest
          ? recorded.harvest
          : modelName && modelName !== AGENTFW_MODEL_ID
            ? { id: modelName }
            : undefined

        endpoints.push({
          modelId: wrappedModelId,
          sourceModelId: modelName || undefined,
          originalBaseUrl: upstream,
          agentfwBaseUrl: agentfwUrlFor(AGENT),
          upstream,
          decoder,
          configLocation: `/custom_providers/${name}/base_url`,
          filePath: configPath,
          ...(harvested ? { harvest: harvested } : {}),
        })
      }
    }

    // 3. mcp_servers (stdio only in v0.1)
    const mcpMap = doc.get('mcp_servers')
    if (mcpMap instanceof YAMLMap) {
      for (const pair of mcpMap.items) {
        const keyNode = pair.key as { value?: string } | undefined
        const name = keyNode?.value
        if (!name) continue
        if (!(pair.value instanceof YAMLMap)) continue
        const server = pair.value
        const command = server.get('command') as string | undefined
        const argsSeq = server.get('args')
        const args =
          argsSeq instanceof YAMLSeq ? (argsSeq.toJSON() as string[]) : undefined
        const entry: McpServerEntry = { command, args }
        if (isAlreadyWrapped(entry)) {
          alreadyWrapped++
          continue
        }
        mcpServers.push({
          name,
          transport: 'stdio',
          filePath: configPath,
          configLocation: `/mcp_servers/${name}`,
          originalCommand: command,
          originalArgs: args,
        })
      }
    }

    if (alreadyWired > 0) {
      caveats.push(`${alreadyWired} endpoint(s) already wired.`)
    }
    if (alreadyWrapped > 0) {
      caveats.push(`${alreadyWrapped} MCP server(s) already wrapped.`)
    }

    // Hermes may declare several providers, but after wire it talks to
    // exactly one — the provider `model.provider` points at. Mark that
    // endpoint active; only active endpoints become wire routes.
    if (endpoints.length > 0) {
      const active = pickActiveEndpoint(
        endpoints,
        String(doc.getIn(['model', 'provider']) ?? ''),
      )
      if (active) active.active = true
    }

    // Capture each provider's api_key so the orchestrator can inject it for
    // routes agentfw now manages.
    const creds = await captureHermesCredentials(endpoints)
    for (const ep of endpoints) {
      const c = creds.get(ep.modelId)
      if (c) ep.auth = c.auth
    }

    return {
      agent: AGENT,
      mode: MODE,
      configPaths: [configPath],
      endpoints,
      mcpServers,
      caveats,
    }
  },

  async wire(detection: Detection): Promise<WireOutcome> {
    if (detection.endpoints.length === 0 && detection.mcpServers.length === 0) {
      return { backupEntries: [], changes: [] }
    }

    const configPath = paths.agent.hermes.config
    const originalText = await readFile(configPath, 'utf8')
    const originalSha = sha256OfString(originalText)

    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = join(paths.backups.dir, ts, AGENT)
    const backupPath = join(backupDir, 'config.yaml')
    await backupCopy(configPath, backupPath)

    const doc = parseDocument(originalText)
    const changes: ChangeRecord[] = []

    // Endpoint redirects + virtual-model handshake. base_url goes to
    // agentfw; the model-name field in the same section is overwritten with
    // `agentfw` so every Hermes request to this endpoint carries a model
    // name agentfw owns. The route key carries the real routing decision
    // (matches the OpenClaw pattern). User's original model name is
    // recorded so unwire restores it.
    for (const ep of detection.endpoints) {
      const modelKey = pickModelKey(doc, ep)
      // Write the wrap id (e.g. `agentfw-hermes-custom`) — that's the
      // model name hermes will send in body.model, which agentfw's
      // routes.json keys by. The legacy literal `'agentfw'` was the
      // old single-instance handle and no longer matches any route.
      const wrapModelId = ep.modelId
      if (ep.configLocation === '/model/base_url') {
        doc.setIn(['model', 'base_url'], ep.agentfwBaseUrl)
        const modelMap = doc.get('model')
        const priorModel =
          modelMap instanceof YAMLMap ? (modelMap.get(modelKey) as unknown) : undefined
        doc.setIn(['model', modelKey], wrapModelId)
        changes.push({
          type: 'set',
          jsonPointer: `/model/${modelKey}`,
          ...(priorModel === undefined
            ? { fromAbsent: true as const }
            : { from: priorModel }),
          to: wrapModelId,
        })
      } else if (ep.configLocation.startsWith('/custom_providers/')) {
        // configLocation is `/custom_providers/<originalProviderName>/base_url`.
        // The custom_providers entry is keyed by that name; ep.modelId is
        // the wrap id (`agentfw-hermes-<name>`) and won't match.
        const segments = ep.configLocation.split('/').filter(Boolean)
        const originalProviderName = segments[1] ?? ep.modelId
        const priorModel = withCustomProviderEntry(doc, originalProviderName, (item) => {
          item.set('base_url', ep.agentfwBaseUrl)
          const v = item.get(modelKey) as unknown
          item.set(modelKey, wrapModelId)
          return v
        })
        changes.push({
          type: 'set',
          jsonPointer: `/custom_providers/${originalProviderName}/${modelKey}`,
          ...(priorModel === undefined
            ? { fromAbsent: true as const }
            : { from: priorModel }),
          to: wrapModelId,
        })
      }
      changes.push({
        type: 'set',
        jsonPointer: ep.configLocation,
        from: ep.originalBaseUrl,
        to: ep.agentfwBaseUrl,
      })
    }

    // MCP wraps
    for (const plan of detection.mcpServers) {
      const wrapped = wrapStdioCommand(
        { command: plan.originalCommand, args: plan.originalArgs },
        AGENT,
        plan.name,
      )
      doc.setIn(['mcp_servers', plan.name, 'command'], wrapped.command)
      doc.setIn(['mcp_servers', plan.name, 'args'], wrapped.args)
      changes.push({
        type: 'wrap-mcp',
        name: plan.name,
        from: { command: plan.originalCommand, args: plan.originalArgs, type: 'stdio' },
        to: { command: wrapped.command, args: wrapped.args, type: 'stdio' },
      })
    }

    const newText = doc.toString({ lineWidth: 0 })
    await atomicWrite(configPath, newText)
    const rewrittenSha = sha256OfString(newText)

    return {
      backupEntries: [
        {
          id: newBackupId(),
          agent: AGENT,
          originalPath: configPath,
          backupPath,
          originalSha256: originalSha,
          rewrittenSha256: rewrittenSha,
          wiredAt: Date.now(),
          changes,
          manifestVersion: MANIFEST_VERSION,
        },
      ],
      changes,
      secrets: buildWireSecrets(
        AGENT,
        detection.endpoints,
        await captureHermesCredentials(detection.endpoints),
      ),
    }
  },

  async unwire(entries: BackupEntry[], opts?: UnwireOptions) {
    return revertEntries(entries, AGENT, opts)
  },

  async probeRunning(): Promise<RunningStatus> {
    // systemd user (Linux)
    const sd = await execCapture('systemctl', ['--user', 'is-active', 'hermes-gateway'])
    if (sd.exit === 0) {
      const pidR = await execCapture('systemctl', [
        '--user',
        'show',
        '-p',
        'MainPID',
        '--value',
        'hermes-gateway',
      ])
      const pid = Number.parseInt(pidR.stdout.trim(), 10)
      return {
        running: true,
        pid: pid > 0 ? pid : undefined,
        mechanism: 'systemd',
        service: 'hermes-gateway',
      }
    }
    // Foreground / macOS — pgrep
    const ps = await execCapture('pgrep', ['-f', 'hermes_cli|hermes-agent|hermes-cli'])
    if (ps.exit === 0) {
      const first = ps.stdout.split('\n')[0]?.trim()
      const pid = first ? Number.parseInt(first, 10) : Number.NaN
      return {
        running: true,
        pid: Number.isFinite(pid) ? pid : undefined,
        mechanism: 'foreground',
      }
    }
    return { running: false }
  },

  async applyToRunning(_detection): Promise<ApplyResult> {
    // Build the paste-able /model command from the freshly-wired config.
    let model = '<your-model>'
    let provider = ''
    try {
      const text = await readFile(paths.agent.hermes.config, 'utf8')
      const doc = parseDocument(text)
      const m = doc.getIn(['model', 'default'])
      if (typeof m === 'string' && m) model = m
      const p = doc.getIn(['model', 'provider'])
      if (typeof p === 'string' && p) provider = p
    } catch {
      /* keep defaults */
    }
    const cmd = provider
      ? `/model ${model} --provider ${provider} --global`
      : `/model ${model} --global`

    return {
      kind: 'user-action',
      lang: 'hermes-slash',
      instruction:
        'Hermes is running. Paste this into your Hermes REPL to apply without restart:\n\n' +
        `    ${cmd}\n\n` +
        'Or restart Hermes — same effect.',
    }
  },
}
