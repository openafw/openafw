import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import type { AgentId, RuntimeMode } from '../../core/agent.ts'
import { newBackupId } from '../../core/ids.ts'
import { MANIFEST_VERSION, type BackupEntry, type ChangeRecord } from '../../core/manifest.ts'
import type { Modality, ModelCost } from '../../core/model-registry.ts'
import { paths } from '../../core/paths.ts'
import type { HarvestedModel } from '../../core/routes.ts'
import { removeSecret } from '../../core/secrets.ts'
import { atomicWrite, backupCopy, fileExists, sha256OfString } from '../backup/files.ts'
import { readManifest, removeEntries } from '../backup/manifest.ts'
import { revertEntries, revertEntry } from '../backup/restore.ts'
import { applyJsonUpdate, getValueAt, parseJsonc, parseTree } from '../rewrite/jsonc.ts'
import { execCapture } from '../util/exec.ts'
import { decoderFor } from '../wire/decoder-for.ts'
import { readRoutes } from '../wire/routes.ts'
import { agentfwUrlFor } from '../wire/url.ts'
import { buildWireSecrets, captureOpenClawCredentials } from './credentials.ts'
import type {
  ApplyResult,
  Detection,
  Detector,
  PlannedEndpoint,
  RunningStatus,
  UnwireOptions,
  WireOutcome,
} from './types.ts'

const AGENT: AgentId = 'openclaw'
const DEFAULT_OPENCLAW_AGENT = 'main'

/** List the openclaw agent ids present under `~/.openclaw/agents/`.
 *  Falls back to `['main']` when the directory is missing — single-agent
 *  installs without a populated agents/ dir. Sorted for stable output. */
async function listOpenClawAgentIds(configPath: string): Promise<string[]> {
  const agentsDir = join(dirname(configPath), 'agents')
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true })
    const ids = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((id) => id !== '.' && id !== '..' && !id.startsWith('.'))
    return ids.length > 0 ? ids.sort() : [DEFAULT_OPENCLAW_AGENT]
  } catch {
    return [DEFAULT_OPENCLAW_AGENT]
  }
}

/** Build the wrapped model id for an openclaw sub-agent. Convention:
 *  `agentfw-openclaw-<agentId>`. Single-agent and multi-agent setups both
 *  use this — single-agent is just `agentfw-openclaw-main`. */
function wrapperModelIdFor(openClawAgentId: string): string {
  return `${WRAPPER_PROVIDER}-${AGENT}-${openClawAgentId}`
}
const MODE: RuntimeMode = 'daemon-restartable'
// OpenClaw's launchd plist (installed by `openclaw node install`) uses the
// `ai.openclaw.gateway` label. cc-switch's earlier docs said
// `com.openclaw.gateway` but that's not what the binary actually writes.
const SERVICE_LABEL = 'ai.openclaw.gateway'

// why: agentfw wires by ADDING a new provider entry rather than mutating
// the user's existing one. The wrapper provider mirrors the source
// (baseUrl→agentfw, api/apiKey/models[] copied), then we re-aim
// `agents.defaults.model.primary` at "agentfw/<modelId>" so openclaw's
// active picker uses the wrapped path. The user's original provider —
// including `apiKey: "VLLM_API_KEY"`, models[], plugins config, anything
// — stays byte-identical, available to switch back to manually. Unwire
// just deletes the wrapper sections; nothing to "restore".
const WRAPPER_PROVIDER = 'agentfw' as const
// The id openclaw shows in its picker and sends as `model` in the request
// body. Kept brand-aligned with the wrapper provider so the user reads
// "agentfw/agentfw — agentfw is managing the model choice". The real source
// model id (e.g. "og-coding") is preserved in routes.json's `models[]`;
// proxy's swapVirtualModelForPassthrough swaps "agentfw" → that id at the
// wire so the upstream sees the model it actually serves.
const WRAPPER_MODEL_ID = 'agentfw' as const
const WRAPPER_MODEL_NAME = 'agentfw' as const

type OpenClawConfig = {
  models?: {
    mode?: string
    providers?: Record<string, OpenClawProvider>
  }
  // openclaw stores its default model at `agents.defaults.model.primary`
  // in `<providerKey>/<modelId>` form (e.g. `vllm/og-coding`). Some older
  // configs put a bare string at `agents.defaults.model`. agentfw reads
  // this to know which model the user is actively using — that's the one
  // we wrap behind the synthetic `agentfw` provider.
  agents?: {
    defaults?: {
      model?: string | { primary?: string; [k: string]: unknown }
      // The active-model registry: keys are "<providerKey>/<modelId>".
      // openclaw treats this as the allow-list of pickable models; wire
      // adds an entry for the wrapper so the picker can land on it.
      models?: Record<string, unknown>
    }
  }
  // openclaw auth profiles keyed `<providerId>:<profileName>`. Wire adds
  // `agentfw:default` mirroring the source's profile so openclaw's auth
  // resolver picks api_key mode for the wrapper.
  auth?: {
    profiles?: Record<string, { provider?: string; mode?: string; [k: string]: unknown }>
  }
}

/** The provider key + model id named by `agents.defaults.model.primary`,
 *  plus the shape openclaw stored it in (string vs `{primary}`). The shape
 *  matters at wire time so we update the same key the user had. */
type DefaultPick = {
  providerKey: string
  modelId: string
  /** 'string' = `agents.defaults.model` is a bare string; 'object' = nested
   *  under `agents.defaults.model.primary`. */
  shape: 'string' | 'object'
  originalPrimary: string
}

function defaultPickFromConfig(c: OpenClawConfig): DefaultPick | undefined {
  const m = c.agents?.defaults?.model
  let primary: string | undefined
  let shape: 'string' | 'object'
  if (typeof m === 'string') {
    primary = m
    shape = 'string'
  } else if (typeof m === 'object' && m !== null && typeof m.primary === 'string') {
    primary = m.primary
    shape = 'object'
  } else {
    return undefined
  }
  const slash = primary.indexOf('/')
  if (slash <= 0 || slash === primary.length - 1) return undefined
  return {
    providerKey: primary.slice(0, slash),
    modelId: primary.slice(slash + 1),
    shape,
    originalPrimary: primary,
  }
}

/** The source provider + model that wire should wrap. Resolved from the
 *  config's `agents.defaults.model.primary` + the matching
 *  `models.providers.<sourceProviderKey>` + its `models[]` entry. Undefined
 *  when the primary is missing, already aimed at the wrapper, or doesn't
 *  match a known provider+model. */
type WrapTarget = {
  sourceProviderKey: string
  sourceModelId: string
  sourceProvider: Record<string, unknown>
  sourceModelEntry: Record<string, unknown>
  /** The base URL agentfw should forward to (the real upstream). */
  sourceBaseUrl: string
  /** baseUrl vs base_url — preserve the source's casing for wrapper. */
  baseUrlKey: 'baseUrl' | 'base_url'
  /** The auth profile id (e.g. "vllm:default") whose `mode` we mirror. */
  sourceAuthProfileId: string | undefined
  primaryShape: 'string' | 'object'
  originalPrimary: string
}

function findWrapTarget(c: OpenClawConfig): WrapTarget | undefined {
  const pick = defaultPickFromConfig(c)
  if (!pick) return undefined
  // Already wired through the wrapper — caller handles idempotency.
  if (pick.providerKey === WRAPPER_PROVIDER) return undefined

  const srcProvider = c.models?.providers?.[pick.providerKey]
  if (!srcProvider || typeof srcProvider !== 'object') return undefined
  const baseUrlKey: 'baseUrl' | 'base_url' | undefined =
    typeof (srcProvider as Record<string, unknown>).baseUrl === 'string'
      ? 'baseUrl'
      : typeof (srcProvider as Record<string, unknown>).base_url === 'string'
        ? 'base_url'
        : undefined
  if (!baseUrlKey) return undefined
  const sourceBaseUrl = String((srcProvider as Record<string, unknown>)[baseUrlKey] ?? '').trim()
  if (!sourceBaseUrl) return undefined

  const modelsArr = Array.isArray((srcProvider as Record<string, unknown>).models)
    ? ((srcProvider as Record<string, unknown>).models as unknown[])
    : []
  const modelEntry = modelsArr.find(
    (m): m is Record<string, unknown> =>
      typeof m === 'object' &&
      m !== null &&
      typeof (m as Record<string, unknown>).id === 'string' &&
      (m as Record<string, unknown>).id === pick.modelId,
  )
  if (!modelEntry) return undefined

  // Pick a matching auth profile by `provider` field if any exists, so we
  // can mirror its mode (api_key / token / oauth) for the wrapper.
  const profiles = c.auth?.profiles ?? {}
  const sourceAuthProfileId = Object.keys(profiles).find(
    (id) => profiles[id]?.provider === pick.providerKey,
  )

  return {
    sourceProviderKey: pick.providerKey,
    sourceModelId: pick.modelId,
    sourceProvider: srcProvider as Record<string, unknown>,
    sourceModelEntry: modelEntry,
    sourceBaseUrl,
    baseUrlKey,
    sourceAuthProfileId,
    primaryShape: pick.shape,
    originalPrimary: pick.originalPrimary,
  }
}

// OpenClaw accepts both snake_case (`base_url`) and camelCase (`baseUrl`)
// for the same field. We detect whichever the user has and write back in
// the same casing so the diff stays minimal.
type OpenClawProvider = {
  base_url?: string
  baseUrl?: string
  api_key?: string
  apiKey?: string
  // OpenClaw declares a per-provider model catalog whose shape is almost
  // byte-identical to agentfw's HarvestedModel — harvested at wire time.
  models?: unknown
  [k: string]: unknown
}

const MODALITIES = new Set<Modality>(['text', 'audio', 'image', 'video', 'pdf'])

function harvestCost(raw: unknown): ModelCost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.input !== 'number' || typeof rec.output !== 'number') return undefined
  return {
    input: rec.input,
    output: rec.output,
    ...(typeof rec.cacheRead === 'number' ? { cacheRead: rec.cacheRead } : {}),
    ...(typeof rec.cacheWrite === 'number' ? { cacheWrite: rec.cacheWrite } : {}),
  }
}

// Map OpenClaw's `provider.models[]` to HarvestedModel. The shapes line up
// 1:1 (id/name/input/cost/contextWindow/maxTokens); OpenClaw's own `api`
// field is not harvested — the wire format is decoder-derived.
function harvestOpenClawModels(raw: unknown): HarvestedModel[] {
  if (!Array.isArray(raw)) return []
  const out: HarvestedModel[] = []
  for (const m of raw) {
    if (typeof m !== 'object' || m === null) continue
    const rec = m as Record<string, unknown>
    const id = typeof rec.id === 'string' ? rec.id.trim() : ''
    if (!id) continue
    const input = Array.isArray(rec.input)
      ? rec.input.filter((x): x is Modality => MODALITIES.has(x as Modality))
      : []
    const cost = harvestCost(rec.cost)
    out.push({
      id,
      ...(typeof rec.name === 'string' && rec.name ? { label: rec.name } : {}),
      ...(input.length > 0 ? { input } : {}),
      ...(typeof rec.contextWindow === 'number' ? { contextWindow: rec.contextWindow } : {}),
      ...(typeof rec.maxTokens === 'number' ? { maxTokens: rec.maxTokens } : {}),
      ...(cost ? { cost } : {}),
    })
  }
  return out
}

/** Revert every prior openclaw manifest entry and forget them, so wire()
 *  always starts from the user's baseline config. Called from the top of
 *  `wire()`. With the wrapper-provider design there's only ever one
 *  agentfw-authored section in openclaw.json (the `agentfw` provider + its
 *  primary/models/auth entries), so a full revert just deletes that block
 *  and restores primary — no per-source-provider scoping needed.
 *  Idempotent: returns immediately when there are no prior entries.
 *  Also drops the wrapper secret since it'll be re-captured below. */
async function cleanupPriorWireState(): Promise<void> {
  const manifest = await readManifest()
  const agentEntries = manifest.entries.filter((e) => e.agent === AGENT)
  if (agentEntries.length === 0) return
  for (const entry of agentEntries) {
    await revertEntry(entry)
  }
  await removeEntries(agentEntries.map((e) => e.id))
  await removeSecret(`provider:${AGENT}/${WRAPPER_PROVIDER}`).catch(() => {})
}

/** Mirror the source provider's auth profile under `agentfw:default` in the
 *  per-agent `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` store
 *  so openclaw's runtime auth resolver finds an api_key for the wrapper.
 *  openclaw's resolver does NOT look at `openclaw.json`'s `auth.profiles`
 *  block (that's config-side metadata); the per-agent store is the real
 *  source of truth. Returns a BackupEntry the caller attaches to the wire
 *  outcome so unwire can revert the addition. Returns undefined when the
 *  store doesn't exist or doesn't carry an api_key profile for the source
 *  provider — wire still succeeds, openclaw will surface its own
 *  "configure auth" error and the user can run `openclaw models auth
 *  login`. Default agent id is "main". */
async function wireAuthProfiles(params: {
  configPath: string
  sourceProviderKey: string
  backupDir: string
  agentId?: string
}): Promise<BackupEntry | undefined> {
  const agentId = params.agentId ?? 'main'
  const authProfilesPath = join(
    dirname(params.configPath),
    'agents',
    agentId,
    'agent',
    'auth-profiles.json',
  )
  if (!(await fileExists(authProfilesPath))) return undefined

  const originalText = await readFile(authProfilesPath, 'utf8')
  const originalSha = sha256OfString(originalText)
  let parsed: { version?: number; profiles?: Record<string, Record<string, unknown>> }
  try {
    parsed = JSON.parse(originalText) as typeof parsed
  } catch {
    return undefined
  }
  const profiles = parsed.profiles ?? {}

  // Find an api_key profile whose provider matches the source.
  let sourceProfile: Record<string, unknown> | undefined
  for (const p of Object.values(profiles)) {
    if (!p || typeof p !== 'object') continue
    if (p.type !== 'api_key') continue
    if (p.provider !== params.sourceProviderKey) continue
    sourceProfile = p
    break
  }
  if (!sourceProfile) return undefined

  const wrapperProfileId = `${WRAPPER_PROVIDER}:default`
  const priorWrapperProfile = profiles[wrapperProfileId]
  const wrapperProfile: Record<string, unknown> = {
    ...sourceProfile,
    provider: WRAPPER_PROVIDER,
  }

  // Skip if identical (idempotent re-wire).
  if (
    priorWrapperProfile &&
    JSON.stringify(priorWrapperProfile) === JSON.stringify(wrapperProfile)
  ) {
    return undefined
  }

  // Backup before rewrite so unwire's whole-file fallback has a snapshot.
  const backupPath = join(params.backupDir, 'auth-profiles.json')
  await backupCopy(authProfilesPath, backupPath)

  const nextParsed = {
    ...parsed,
    profiles: { ...profiles, [wrapperProfileId]: wrapperProfile },
  }
  // Preserve a trailing newline if the original had one.
  const trailingNl = originalText.endsWith('\n') ? '\n' : ''
  const newText = `${JSON.stringify(nextParsed, null, 2)}${trailingNl}`
  await atomicWrite(authProfilesPath, newText)
  const rewrittenSha = sha256OfString(newText)

  const change: ChangeRecord =
    priorWrapperProfile === undefined
      ? {
          type: 'set',
          jsonPointer: `/profiles/${wrapperProfileId}`,
          fromAbsent: true,
          to: wrapperProfile,
        }
      : {
          type: 'set',
          jsonPointer: `/profiles/${wrapperProfileId}`,
          from: priorWrapperProfile,
          to: wrapperProfile,
        }

  return {
    id: newBackupId(),
    agent: AGENT,
    originalPath: authProfilesPath,
    backupPath,
    originalSha256: originalSha,
    rewrittenSha256: rewrittenSha,
    wiredAt: Date.now(),
    changes: [change],
    manifestVersion: MANIFEST_VERSION,
  }
}

export const openclawDetector: Detector = {
  agent: AGENT,
  mode: MODE,

  manualInstructions(): string {
    const url = agentfwUrlFor(AGENT)
    return [
      'OpenClaw is a long-running gateway, so agentfw does not edit its config.',
      'Point it at the wire yourself, then manage models in agentfw:',
      '',
      '  1. Register the upstream model(s) you want to use with agentfw:',
      '       agentfw model add',
      '     (prompts for base URL, API key, model id — validated live)',
      '',
      '  2. In ~/.openclaw/openclaw.json, set your provider\'s base URL to the wire',
      `     and keep your model id, e.g. models.providers.<name>.baseUrl:`,
      `       "${url}"`,
      '',
      '  3. Route that traffic in agentfw:',
      `       agentfw route set ${AGENT}/* --model <id>`,
      '',
      '  4. Restart the OpenClaw gateway so it picks up the new base URL.',
    ].join('\n')
  },

  async detect(): Promise<Detection | null> {
    const configPath = paths.agent.openclaw
    if (!(await fileExists(configPath))) return null

    const text = await readFile(configPath, 'utf8')
    const config = parseJsonc<OpenClawConfig>(text)

    if (!config) {
      return {
        agent: AGENT,
        mode: MODE,
        configPaths: [configPath],
        endpoints: [],
        mcpServers: [],
        caveats: ['openclaw.json parse failed (JSON5); skipping.'],
      }
    }

    const endpoints: PlannedEndpoint[] = []
    const caveats: string[] = []

    const target = findWrapTarget(config)
    const currentPick = defaultPickFromConfig(config)
    const alreadyWired = currentPick?.providerKey === WRAPPER_PROVIDER

    if (alreadyWired) {
      // Re-wire idempotent path: the user's primary is `agentfw/<modelId>`.
      // The upstream + harvested models live in routes.json (set at first
      // wire). Emit an endpoint backed by that — wire() then either
      // applies no-op edits or refreshes if anything drifted.
      const existingRoutes = await readRoutes().catch(
        () => ({ routes: {} as Record<string, never> }),
      )
      const recordedModelId = `${WRAPPER_PROVIDER}-${AGENT}-main`
      const recorded = existingRoutes.routes[`${AGENT}/${recordedModelId}`]
      if (recorded?.upstream) {
        endpoints.push({
          modelId: recordedModelId,
          originalBaseUrl: recorded.upstream,
          agentfwBaseUrl: agentfwUrlFor(AGENT),
          upstream: recorded.upstream,
          decoder: recorded.decoder,
          configLocation: `/models/providers/${WRAPPER_PROVIDER}/baseUrl`,
          filePath: configPath,
          active: true,
          ...(recorded.sourceModelId ? { sourceModelId: recorded.sourceModelId } : {}),
          ...(recorded.harvest ? { harvest: recorded.harvest } : {}),
        })
        caveats.push(`already wired through the '${WRAPPER_PROVIDER}' wrapper; re-wire is idempotent.`)
      } else {
        caveats.push(
          `primary already aims at '${WRAPPER_PROVIDER}/*' but routes.json has no openclaw/${WRAPPER_PROVIDER} entry — run \`agentfw unwire openclaw\` then re-wire to re-init.`,
        )
      }
    } else if (target) {
      // Fresh wire: wrap the source provider+model for EACH openclaw
      // sub-agent. The source provider entry stays byte-identical; wire()
      // adds a sibling `agentfw` provider whose models[] has one entry
      // per agent (id = `agentfw-openclaw-<agentId>`). Per-agent auth
      // profiles get their own `agentfw:default` entries (potentially
      // different keys per agent).
      if (config.models?.providers?.[WRAPPER_PROVIDER]) {
        caveats.push(
          `models.providers.${WRAPPER_PROVIDER} already exists but primary doesn't point at it — \`agentfw unwire openclaw\` first to clean it up.`,
        )
      } else {
        const harvested = harvestOpenClawModels([target.sourceModelEntry])
        const agentIds = await listOpenClawAgentIds(configPath)
        for (const openClawAgentId of agentIds) {
          const wrappedModelId = wrapperModelIdFor(openClawAgentId)
          endpoints.push({
            modelId: wrappedModelId,
            originalBaseUrl: target.sourceBaseUrl,
            agentfwBaseUrl: agentfwUrlFor(AGENT),
            upstream: target.sourceBaseUrl,
            decoder: decoderFor(target.sourceBaseUrl),
            configLocation: `/models/providers/${WRAPPER_PROVIDER}/${target.baseUrlKey}`,
            filePath: configPath,
            active: true,
            sourceModelId: target.sourceModelId,
            ...(harvested[0] ? { harvest: harvested[0] } : {}),
          })
        }
        caveats.push(
          agentIds.length === 1
            ? `wrapping '${target.sourceProviderKey}/${target.sourceModelId}' behind '${WRAPPER_PROVIDER}/${wrapperModelIdFor(agentIds[0]!)}'; source provider stays untouched.`
            : `wrapping ${agentIds.length} openclaw agents (${agentIds.join(', ')}) behind '${WRAPPER_PROVIDER}/*'; each agent gets its own model id and auth.`,
        )
      }
    } else {
      caveats.push(
        currentPick
          ? `agents.defaults.model.primary='${currentPick.originalPrimary}' but the provider+model don't exist in models.providers — fix the primary then wire.`
          : `agents.defaults.model.primary not set — point it at the model you want agentfw to wrap, then wire.`,
      )
    }

    // Capture per-agent credentials for secrets.json. Each openclaw
    // sub-agent has its own auth-profiles.json with potentially its own
    // key for the source provider — capture them separately and key by
    // the wrapped model id so secrets.json has one entry per agent.
    if (target) {
      for (const ep of endpoints) {
        const openClawAgentId = ep.modelId.startsWith(`${WRAPPER_PROVIDER}-${AGENT}-`)
          ? ep.modelId.slice(`${WRAPPER_PROVIDER}-${AGENT}-`.length)
          : DEFAULT_OPENCLAW_AGENT
        const creds = await captureOpenClawCredentials(
          [
            {
              ...ep,
              modelId: target.sourceProviderKey,
            },
          ],
          { configPath, agentId: openClawAgentId },
        )
        const c = creds.get(target.sourceProviderKey)
        if (c) ep.auth = c.auth
      }
    }

    // OpenClaw doesn't support MCP (cc-switch evidence).
    return {
      agent: AGENT,
      mode: MODE,
      configPaths: [configPath],
      endpoints,
      mcpServers: [],
      caveats,
    }
  },

  async wire(detection: Detection): Promise<WireOutcome> {
    if (detection.endpoints.length === 0) {
      return { backupEntries: [], changes: [] }
    }

    const configPath = paths.agent.openclaw

    // Revert any prior wrapper from the manifest so we start from the
    // user's baseline. With the wrapper-provider design there's only one
    // agentfw-authored block to clean (the `agentfw` provider + primary +
    // agents.defaults.models entry + auth profile); reverting is cheap.
    await cleanupPriorWireState()

    // Re-read after the cleanup may have edited the file.
    const originalText = await readFile(configPath, 'utf8')
    const originalSha = sha256OfString(originalText)

    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = join(paths.backups.dir, ts, AGENT)
    const backupPath = join(backupDir, 'openclaw.json')
    await backupCopy(configPath, backupPath)

    // Re-derive the wrap target from the post-revert config so wire() and
    // detect() agree even if the user edited primary between the two.
    const config = parseJsonc<OpenClawConfig>(originalText)
    if (!config) {
      return { backupEntries: [], changes: [] }
    }
    const target = findWrapTarget(config)
    if (!target) {
      // No new target (e.g. primary still points at the wrapper because
      // openclaw isn't running and didn't pick a new default). Skip wire;
      // a no-op return keeps routes/secrets free of bogus entries.
      return { backupEntries: [], changes: [] }
    }

    let text = originalText
    const changes: ChangeRecord[] = []
    const tree = parseTree(originalText)
    const eps = detection.endpoints

    // 1. models.providers.agentfw — the wrapper. ONE provider entry with
    //    N models[], one per openclaw sub-agent. The user's source
    //    provider entry stays byte-identical.
    const wrapperProviderSegs = ['models', 'providers', WRAPPER_PROVIDER]
    // One wrapper-model entry per endpoint. id = agentfw-openclaw-<agentId>;
    // other fields (cost, input, contextWindow, maxTokens) copied from the
    // source so openclaw's runtime keeps accurate metadata. Real source id
    // is preserved in routes.json's `sourceModelId`; proxy swaps it back
    // at the wire.
    const wrapperModelEntries: Record<string, unknown>[] = eps.map((ep) => {
      const openClawAgentId = ep.modelId.startsWith(`${WRAPPER_PROVIDER}-${AGENT}-`)
        ? ep.modelId.slice(`${WRAPPER_PROVIDER}-${AGENT}-`.length)
        : ep.modelId
      return {
        ...target.sourceModelEntry,
        id: ep.modelId,
        name: `agentfw (${openClawAgentId})`,
      }
    })
    const ep0 = eps[0]!
    const wrapperEntry: Record<string, unknown> = {
      [target.baseUrlKey]: ep0.agentfwBaseUrl,
      ...(typeof target.sourceProvider.api === 'string'
        ? { api: target.sourceProvider.api }
        : {}),
      ...(typeof target.sourceProvider.apiKey === 'string'
        ? { apiKey: target.sourceProvider.apiKey }
        : typeof target.sourceProvider.api_key === 'string'
          ? { api_key: target.sourceProvider.api_key }
          : {}),
      models: wrapperModelEntries,
    }
    text = applyJsonUpdate(text, wrapperProviderSegs, wrapperEntry)
    changes.push({
      type: 'set',
      jsonPointer: `/${wrapperProviderSegs.join('/')}`,
      fromAbsent: true,
      to: wrapperEntry,
    })

    // 2. agents.defaults.models["agentfw/<wrapperModelId>"] for each agent —
    //    mirror the source's active-model registry entry so openclaw's
    //    picker shows them.
    for (const ep of eps) {
      const wrapperActiveKey = `${WRAPPER_PROVIDER}/${ep.modelId}`
      const activeMapSegs = ['agents', 'defaults', 'models', wrapperActiveKey]
      const priorActive = tree ? getValueAt<unknown>(tree, activeMapSegs) : undefined
      if (priorActive === undefined) {
        const sourceActiveKey = `${target.sourceProviderKey}/${target.sourceModelId}`
        const sourceActive = tree
          ? (getValueAt<unknown>(tree, [
              'agents',
              'defaults',
              'models',
              sourceActiveKey,
            ]) ?? {})
          : {}
        text = applyJsonUpdate(text, activeMapSegs, sourceActive)
        changes.push({
          type: 'set',
          jsonPointer: `/${activeMapSegs.join('/')}`,
          fromAbsent: true,
          to: sourceActive,
        })
      }
    }

    // 3. agents.defaults.model.primary → "agentfw/<first-wrapper>" globally.
    //    Per-agent primary overrides via per-agent models.json would let
    //    each agent pick its own wrapper, but that's a follow-up; default
    //    to wrapping all openclaw traffic behind the first agent's model.
    const primaryEp =
      eps.find((ep) => ep.modelId === wrapperModelIdFor(DEFAULT_OPENCLAW_AGENT)) ?? ep0
    const newPrimary = `${WRAPPER_PROVIDER}/${primaryEp.modelId}`
    const primarySegs =
      target.primaryShape === 'string'
        ? ['agents', 'defaults', 'model']
        : ['agents', 'defaults', 'model', 'primary']
    if (target.originalPrimary !== newPrimary) {
      text = applyJsonUpdate(text, primarySegs, newPrimary)
      changes.push({
        type: 'set',
        jsonPointer: `/${primarySegs.join('/')}`,
        from: target.originalPrimary,
        to: newPrimary,
      })
    }

    // 4. auth.profiles["agentfw:default"] — mirror the source's profile
    //    so openclaw's auth resolver picks api_key mode for the wrapper.
    //    Single global profile is fine; per-agent keys live in each
    //    agent's own auth-profiles.json (step 6 below).
    if (target.sourceAuthProfileId) {
      const sourceProfile = config.auth?.profiles?.[target.sourceAuthProfileId]
      const wrapperProfileId = `${WRAPPER_PROVIDER}:default`
      const profileSegs = ['auth', 'profiles', wrapperProfileId]
      const priorProfile = tree ? getValueAt<unknown>(tree, profileSegs) : undefined
      if (priorProfile === undefined && sourceProfile) {
        const wrapperProfile: Record<string, unknown> = {
          ...sourceProfile,
          provider: WRAPPER_PROVIDER,
        }
        text = applyJsonUpdate(text, profileSegs, wrapperProfile)
        changes.push({
          type: 'set',
          jsonPointer: `/${profileSegs.join('/')}`,
          fromAbsent: true,
          to: wrapperProfile,
        })
      }
    }

    await atomicWrite(configPath, text)
    const rewrittenSha = sha256OfString(text)

    // 5. Capture per-agent secrets. Each endpoint's modelId determines
    //    which openclaw agent's auth-profiles.json to read for the key.
    const wrapperCreds = new Map<string, { auth: import('../../core/routes.ts').RouteAuth; value?: string }>()
    for (const ep of eps) {
      const openClawAgentId = ep.modelId.startsWith(`${WRAPPER_PROVIDER}-${AGENT}-`)
        ? ep.modelId.slice(`${WRAPPER_PROVIDER}-${AGENT}-`.length)
        : DEFAULT_OPENCLAW_AGENT
      const sourceCreds = await captureOpenClawCredentials(
        [
          {
            ...ep,
            modelId: target.sourceProviderKey,
          },
        ],
        { configPath, agentId: openClawAgentId },
      )
      const sourceCred = sourceCreds.get(target.sourceProviderKey)
      if (sourceCred) wrapperCreds.set(ep.modelId, sourceCred)
    }

    // 6. Per-agent auth-profiles.json: write `agentfw:default` into EACH
    //    agent's profile store so openclaw resolves auth for the wrapper.
    //    Returns one BackupEntry per agent.
    const authProfilesBackups: BackupEntry[] = []
    for (const ep of eps) {
      const openClawAgentId = ep.modelId.startsWith(`${WRAPPER_PROVIDER}-${AGENT}-`)
        ? ep.modelId.slice(`${WRAPPER_PROVIDER}-${AGENT}-`.length)
        : DEFAULT_OPENCLAW_AGENT
      const backup = await wireAuthProfiles({
        configPath,
        sourceProviderKey: target.sourceProviderKey,
        backupDir,
        agentId: openClawAgentId,
      })
      if (backup) authProfilesBackups.push(backup)
    }
    const authProfilesBackup = undefined  // legacy variable, replaced by array above

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
        ...authProfilesBackups,
      ],
      changes,
      secrets: buildWireSecrets(AGENT, detection.endpoints, wrapperCreds),
    }
  },

  async unwire(entries: BackupEntry[], opts?: UnwireOptions) {
    return revertEntries(entries, AGENT, opts)
  },

  async probeRunning(): Promise<RunningStatus> {
    const uid = process.getuid?.()
    if (uid === undefined) return { running: false }
    const service = `gui/${uid}/${SERVICE_LABEL}`
    const r = await execCapture('launchctl', ['print', service])
    if (r.exit !== 0) return { running: false }
    const m = r.stdout.match(/pid\s*=\s*(\d+)/)
    const pid = m?.[1] ? Number.parseInt(m[1], 10) : undefined
    return { running: true, pid, mechanism: 'launchd', service }
  },

  async applyToRunning(_detection, status): Promise<ApplyResult> {
    if (!status.running) {
      return { kind: 'next-launch', note: 'openclaw not running; applies on next start' }
    }
    return {
      kind: 'restart',
      cmd: ['launchctl', 'kickstart', '-k', status.service ?? ''],
      willDrop: [
        'active channel connections (auto-reconnect)',
        'in-flight tool calls (re-issued by channels)',
      ],
      risk: 'low',
    }
  },
}
