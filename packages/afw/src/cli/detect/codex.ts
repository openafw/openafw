import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentId } from '../../core/agent.ts'
import { newBackupId } from '../../core/ids.ts'
import { type BackupEntry, type ChangeRecord, MANIFEST_VERSION } from '../../core/manifest.ts'
import { paths } from '../../core/paths.ts'
import { atomicWrite, backupCopy, fileExists, sha256OfString } from '../backup/files.ts'
import { revertEntries } from '../backup/restore.ts'
import {
  ensureTomlSection,
  getTomlString,
  getTomlTopLevelString,
  setTomlTopLevelString,
} from '../rewrite/toml.ts'
import { afwUrlFor } from '../wire/url.ts'
import { buildWireSecrets, captureCodexCredentials } from './credentials.ts'
import type { Detection, Detector, PlannedEndpoint, UnwireOptions, WireOutcome } from './types.ts'

const AGENT: AgentId = 'codex'

// Codex rejects [model_providers.openai] — that provider id is reserved
// for the bundled built-in. We register under our own provider name
// instead and flip `model_provider` at the top of the file to use it.
const AFW_PROVIDER_ID = 'afw'

// Codex's bundled provider picks one of two upstreams depending on the
// active auth_mode in ~/.codex/auth.json:
//   • apikey   → https://api.openai.com/v1            (Bearer = API key)
//   • chatgpt  → https://chatgpt.com/backend-api/codex (Bearer = OAuth
//     access_token from `codex login`, plus the chatgpt-account-id
//     header we inject in the proxy)
// We have to mirror that choice ourselves — using api.openai.com with a
// ChatGPT access_token yields 401 "missing scopes: api.responses.write"
// because the token isn't valid against the public API surface.
const OPENAI_API_KEY_UPSTREAM = 'https://api.openai.com/v1'
const OPENAI_CHATGPT_UPSTREAM = 'https://chatgpt.com/backend-api/codex'
const AFW_PROVIDER_DEFAULTS: Record<string, string | { raw: string }> = {
  name: 'afw (OpenAI)',
  wire_api: 'responses',
  // Tells Codex to use the user's existing OPENAI_API_KEY auth (loaded
  // from ~/.codex/auth.json) — no need to duplicate env_key here. Must
  // be a TOML boolean, not a string.
  requires_openai_auth: { raw: 'true' },
}

// The Codex CLI concatenates the path it wants ('/responses' or
// '/chat/completions') to the configured base_url. The afw proxy
// concatenates whatever path remains after `/wire/<agent>/<provider>`
// to the upstream — and the upstream itself preserves its version
// segment (e.g. https://api.openai.com/v1). So our base_url must NOT
// include /v1, otherwise we'd double it (/v1/v1/responses → 404).
function afwBaseUrl(): string {
  return afwUrlFor(AGENT)
}

export const codexDetector: Detector = {
  agent: AGENT,
  mode: 'launch-per-task',

  async detect(): Promise<Detection | null> {
    const configPath = paths.agent.codex.config
    if (!(await fileExists(configPath))) return null

    const text = await readFile(configPath, 'utf8')
    const currentProvider = getTomlTopLevelString(text, 'model_provider') ?? 'openai'
    // why: Codex DOES name its active model at the top-level `model` key,
    // but we intentionally do not harvest it. The model in config is the
    // session default; the user routinely overrides it per-task (UI
    // picker, /model command, env, agent presets). Trusting config would
    // miss every other model the account actually uses, so codex routes
    // grow purely from observed traffic — same as claude-code.

    const wireUrl = afwBaseUrl()
    const caveats: string[] = []

    // Match Codex's own auth_mode → upstream choice. Reading auth.json
    // here is best-effort: if the file isn't present yet (user hasn't
    // logged in), default to the API-key upstream — the choice is
    // recomputed at re-wire time anyway.
    const authMode = await readCodexAuthMode()
    const useChatGpt = authMode === 'chatgpt'
    let upstream = useChatGpt ? OPENAI_CHATGPT_UPSTREAM : OPENAI_API_KEY_UPSTREAM

    if (currentProvider === AFW_PROVIDER_ID) {
      caveats.push('config.toml already points at afw; re-wire is idempotent.')
    } else if (currentProvider === 'openai') {
      caveats.push(
        useChatGpt
          ? "auth_mode='chatgpt' → routing through chatgpt.com/backend-api/codex"
          : "auth_mode='apikey' → routing through api.openai.com/v1",
      )
    } else {
      const customBaseUrl = getTomlString(text, `model_providers.${currentProvider}`, 'base_url')
      if (customBaseUrl) {
        upstream = customBaseUrl
        caveats.push(
          `wrapping existing custom provider '${currentProvider}' (upstream: ${customBaseUrl})`,
        )
      } else {
        caveats.push(
          `existing custom model_provider='${currentProvider}' has no base_url — falling back to ${upstream}`,
        )
      }
    }

    const ep: PlannedEndpoint = {
      // Wildcard route — codex talks openai-responses with the model id
      // the user picked via /model or the config's `model` field; we
      // don't pin that here so observation can grow the registry.
      modelId: '*',
      originalBaseUrl: upstream,
      afwBaseUrl: wireUrl,
      upstream,
      decoder: 'openai-responses',
      configLocation: `/model_providers/${AFW_PROVIDER_ID}/base_url`,
      filePath: configPath,
      active: true,
    }

    // Capture the agent's static OpenAI key so the orchestrator can inject
    // it for routes afw now manages. ChatGPT-subscription auth is OAuth
    // and is not captured here.
    const cred = (await captureCodexCredentials()).get('openai')
    if (cred) ep.auth = cred.auth

    return {
      agent: AGENT,
      mode: 'launch-per-task',
      configPaths: [configPath],
      endpoints: [ep],
      mcpServers: [],
      caveats,
    }
  },

  async wire(detection: Detection): Promise<WireOutcome> {
    const ep = detection.endpoints[0]
    if (!ep) return { backupEntries: [], changes: [] }
    const configPath = ep.filePath

    const secrets = buildWireSecrets(AGENT, detection.endpoints, await captureCodexCredentials())

    const originalText = await readFile(configPath, 'utf8')
    const originalSha = sha256OfString(originalText)
    // undefined → the key is absent (Codex defaults to its bundled
    // 'openai' provider); revert must delete it, not write a value back.
    const rawProvider = getTomlTopLevelString(originalText, 'model_provider')
    const originalProvider = rawProvider ?? 'openai'

    // Already wired and base_url matches? No-op.
    if (originalProvider === AFW_PROVIDER_ID) {
      const existing = getTomlString(originalText, `model_providers.${AFW_PROVIDER_ID}`, 'base_url')
      if (existing === ep.afwBaseUrl) {
        return { backupEntries: [], changes: [], secrets }
      }
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = join(paths.backups.dir, ts, AGENT)
    const backupPath = join(backupDir, 'config.toml')
    await backupCopy(configPath, backupPath)

    let working = originalText

    // 1. Top-level model_provider = "afw"
    const topRes = setTomlTopLevelString(working, 'model_provider', AFW_PROVIDER_ID)
    working = topRes.text

    // 2. [model_providers.afw] section with our defaults + wire URL.
    const desired: Record<string, string> = {
      ...AFW_PROVIDER_DEFAULTS,
      base_url: ep.afwBaseUrl,
    }
    const secRes = ensureTomlSection(working, `model_providers.${AFW_PROVIDER_ID}`, desired)
    working = secRes.text

    await atomicWrite(configPath, working)
    const rewrittenSha = sha256OfString(working)

    // The whole [model_providers.afw] section is afw-owned. Record
    // it as a created path so revert removes it; only the model_provider
    // flip is a true set of a user-facing key.
    const changes: ChangeRecord[] = [
      rawProvider === undefined
        ? { type: 'set', jsonPointer: '/model_provider', fromAbsent: true, to: AFW_PROVIDER_ID }
        : {
            type: 'set',
            jsonPointer: '/model_provider',
            from: rawProvider,
            to: AFW_PROVIDER_ID,
          },
    ]
    if (secRes.sectionAdded) {
      changes.push({
        type: 'create-path',
        jsonPointer: `/model_providers/${AFW_PROVIDER_ID}`,
      })
    }

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
      secrets,
    }
  },

  async unwire(entries: BackupEntry[], opts?: UnwireOptions) {
    return revertEntries(entries, AGENT, opts)
  },

  manualInstructions(detection: Detection): string {
    const ep = detection.endpoints[0]
    if (!ep) return ''
    return [
      'Codex is wired by editing ~/.codex/config.toml. If `afw wire`',
      "cannot do it automatically (Codex won't let you override the",
      'built-in `openai` provider), register a custom provider:',
      '',
      `  model_provider = "${AFW_PROVIDER_ID}"`,
      '',
      `  [model_providers.${AFW_PROVIDER_ID}]`,
      '  name = "afw (OpenAI)"',
      `  base_url = "${ep.afwBaseUrl}"`,
      '  wire_api = "responses"',
      '  requires_openai_auth = true',
      '',
      'Then start a new Codex session.',
    ].join('\n')
  },
}

async function readCodexAuthMode(): Promise<string | undefined> {
  try {
    const text = await readFile(paths.agent.codex.auth, 'utf8')
    const parsed = JSON.parse(text) as { auth_mode?: unknown }
    return typeof parsed.auth_mode === 'string' ? parsed.auth_mode : undefined
  } catch {
    return undefined
  }
}
