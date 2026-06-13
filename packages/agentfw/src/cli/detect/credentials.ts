// Credential capture. `agentfw wire` already reads every agent's config to
// plan endpoints; this module extracts the agent's own API credential from
// that same config so the orchestrator can inject it for cross-agent
// routes. Captured values are stored only in ~/.agentfw/secrets.json (0600)
// and only ever sent to the upstream the agent already calls — this module
// opens no new outbound surface.

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { AgentId } from '../../core/agent.ts'
import { paths } from '../../core/paths.ts'
import type { DecoderKind, RouteAuth } from '../../core/routes.ts'
import { claudeCodeOAuthAvailable } from '../../daemon/orchestrator/oauth/claude-code.ts'
import { parseJsonc } from '../rewrite/jsonc.ts'
import { routeKeyForModel } from '../wire/url.ts'
import type { PlannedEndpoint } from './types.ts'

/** A credential captured for one provider: the header shape, plus the value
 *  for a static key. An `agent-oauth` credential carries no value — the
 *  token is read and refreshed at request time from the agent's own store. */
export type CapturedCredential = { auth: RouteAuth; value?: string }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The auth header convention for a wire decoder: Anthropic carries the key
 *  in `x-api-key`, OpenAI-shaped APIs in `Authorization: Bearer`. */
function authForDecoder(decoder: DecoderKind): RouteAuth {
  return decoder === 'anthropic'
    ? { kind: 'api-key', header: 'x-api-key' }
    : { kind: 'bearer' }
}

// ── .env parsing ──────────────────────────────────────────────────

/** Parse a `.env` file into a flat key→value map. Tolerates `export `
 *  prefixes, `#` comments, blank lines, and surrounding quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    let key = line.slice(0, eq).trim()
    if (key.startsWith('export ')) key = key.slice(7).trim()
    if (key === '') continue
    let value = line.slice(eq + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

async function readDotEnv(path: string): Promise<Record<string, string>> {
  try {
    return parseDotEnv(await readFile(path, 'utf8'))
  } catch {
    return {}
  }
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return parseJsonc<T>(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

// ── secret resolution ─────────────────────────────────────────────

/**
 * Resolve a credential field that may be a literal value, a `${VAR}`
 * template, a `{ source: 'env', id }` SecretRef object, or a bare
 * env-var-name string. Templates and SecretRefs resolve against `env`
 * (the agent's own `.env`, not process.env). A bare string that exactly
 * names an `env` key resolves from `env`; any other plain string is the
 * literal credential. Returns undefined when nothing resolves.
 */
export function resolveSecretInput(
  raw: unknown,
  env: Record<string, string>,
): string | undefined {
  if (isObj(raw)) {
    if (raw.source === 'env' && typeof raw.id === 'string') {
      const v = env[raw.id]
      return v && v.trim() !== '' ? v.trim() : undefined
    }
    return undefined
  }
  if (typeof raw !== 'string') return undefined
  const s = raw.trim()
  if (s === '') return undefined

  if (s.includes('${')) {
    let missing = false
    const out = s.replace(/\$\{([^}]+)\}/g, (_m, name: string) => {
      const v = env[name.trim()]
      if (v === undefined) {
        missing = true
        return ''
      }
      return v
    })
    if (missing) return undefined
    return out.trim() !== '' ? out.trim() : undefined
  }

  // Bare env-var name: OpenClaw stores `apiKey: "VLLM_API_KEY"`.
  if (Object.hasOwn(env, s)) {
    const v = env[s]
    return v && v.trim() !== '' ? v.trim() : undefined
  }
  return s
}

// ── per-agent extractors ──────────────────────────────────────────

/** Claude Code — the credential is a literal in ~/.claude/settings.json
 *  `env` (`ANTHROPIC_AUTH_TOKEN` → Bearer, `ANTHROPIC_API_KEY` → x-api-key),
 *  with ~/.claude.json `primaryApiKey` as the fallback. */
export async function captureClaudeCodeCredentials(opts?: {
  settingsPath?: string
  legacyPath?: string
  oauthProbe?: () => Promise<boolean>
}): Promise<Map<string, CapturedCredential>> {
  const out = new Map<string, CapturedCredential>()
  const settings = await readJsonFile<{ env?: Record<string, unknown> }>(
    opts?.settingsPath ?? paths.agent.claudeCode.settings,
  )
  const env = settings?.env ?? {}

  const authToken =
    typeof env.ANTHROPIC_AUTH_TOKEN === 'string' ? env.ANTHROPIC_AUTH_TOKEN.trim() : ''
  if (authToken !== '') {
    out.set('anthropic', { auth: { kind: 'bearer' }, value: authToken })
    return out
  }
  const apiKey =
    typeof env.ANTHROPIC_API_KEY === 'string' ? env.ANTHROPIC_API_KEY.trim() : ''
  if (apiKey !== '') {
    out.set('anthropic', {
      auth: { kind: 'api-key', header: 'x-api-key' },
      value: apiKey,
    })
    return out
  }
  const legacy = await readJsonFile<{ primaryApiKey?: unknown }>(
    opts?.legacyPath ?? paths.agent.claudeCode.legacy,
  )
  const primary =
    typeof legacy?.primaryApiKey === 'string' ? legacy.primaryApiKey.trim() : ''
  if (primary !== '') {
    out.set('anthropic', {
      auth: { kind: 'api-key', header: 'x-api-key' },
      value: primary,
    })
    return out
  }

  // No static key — fall back to subscription OAuth when Claude Code is
  // logged in via Claude.ai. The token is read + refreshed at request time
  // from the agent's own credential store, never copied here.
  const oauthProbe = opts?.oauthProbe ?? claudeCodeOAuthAvailable
  if (await oauthProbe()) {
    out.set('anthropic', { auth: { kind: 'agent-oauth', agent: 'claude-code' } })
  }
  return out
}

/** Codex — the API-key-mode credential is a literal `OPENAI_API_KEY` in
 *  ~/.codex/auth.json. ChatGPT-subscription auth lives under `tokens` and is
 *  handled separately (OAuth), so it is not captured here. */
export async function captureCodexCredentials(opts?: {
  authPath?: string
}): Promise<Map<string, CapturedCredential>> {
  const out = new Map<string, CapturedCredential>()
  const auth = await readJsonFile<{
    OPENAI_API_KEY?: unknown
    auth_mode?: unknown
    tokens?: unknown
  }>(opts?.authPath ?? paths.agent.codex.auth)
  const key = typeof auth?.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY.trim() : ''
  if (key !== '') {
    out.set('openai', { auth: { kind: 'bearer' }, value: key })
    return out
  }
  // No static key — ChatGPT-subscription mode. The token is read +
  // refreshed at request time from auth.json, never copied here.
  if (auth?.auth_mode === 'chatgpt' && isObj(auth.tokens)) {
    out.set('openai', { auth: { kind: 'agent-oauth', agent: 'codex' } })
  }
  return out
}

/** Hermes — `model.api_key` and `custom_providers[].api_key` in
 *  ~/.hermes/config.yaml, each resolved against ~/.hermes/.env. */
export async function captureHermesCredentials(
  endpoints: PlannedEndpoint[],
  opts?: { configPath?: string; envPath?: string },
): Promise<Map<string, CapturedCredential>> {
  const out = new Map<string, CapturedCredential>()
  let doc: unknown
  try {
    doc = parseYaml(
      await readFile(opts?.configPath ?? paths.agent.hermes.config, 'utf8'),
    )
  } catch {
    return out
  }
  if (!isObj(doc)) return out
  const env = await readDotEnv(opts?.envPath ?? paths.agent.hermes.env)
  const customSeq = Array.isArray(doc.custom_providers) ? doc.custom_providers : []

  for (const ep of endpoints) {
    let rawKey: unknown
    if (ep.configLocation === '/model/base_url') {
      rawKey = isObj(doc.model) ? doc.model.api_key : undefined
    } else if (ep.configLocation.startsWith('/custom_providers/')) {
      const found = customSeq.find((p) => isObj(p) && p.name === ep.modelId)
      rawKey = isObj(found) ? found.api_key : undefined
    }
    const value = resolveSecretInput(rawKey, env)
    if (value !== undefined) {
      out.set(ep.modelId, { auth: authForDecoder(ep.decoder), value })
    }
  }
  return out
}

type OpenClawAuthProfilesFile = {
  version?: number
  profiles?: Record<
    string,
    { type?: string; provider?: string; key?: string; [k: string]: unknown }
  >
}

/** Read the real api-key for a provider out of an openclaw agent's auth
 *  profile store at `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`.
 *  This is the canonical store openclaw writes when the user runs
 *  `openclaw models auth login` (or sets a key through the TUI / config UI);
 *  the literal `models.providers.<name>.apiKey` in openclaw.json is often
 *  just an env-var-name placeholder. Returns the first `type === 'api_key'`
 *  profile whose `provider` matches `providerKey`. */
async function readOpenClawAuthProfileKey(
  providerKey: string,
  agentId: string,
  openclawConfigPath: string,
): Promise<string | undefined> {
  const agentDir = join(dirname(openclawConfigPath), 'agents', agentId, 'agent')
  const file = await readJsonFile<OpenClawAuthProfilesFile>(
    join(agentDir, 'auth-profiles.json'),
  )
  const profiles = file?.profiles
  if (!profiles) return undefined
  for (const profile of Object.values(profiles)) {
    if (!profile) continue
    if (profile.type !== 'api_key') continue
    if (profile.provider !== providerKey) continue
    const k = typeof profile.key === 'string' ? profile.key.trim() : ''
    if (k) return k
  }
  return undefined
}

/** OpenClaw — credentials live in two places:
 *   1. `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` —
 *      authoritative. Each profile has a `provider` field; we match it
 *      against the endpoint's source provider key and use `.key`.
 *   2. `models.providers.<name>.apiKey` / `.api_key` in openclaw.json,
 *      resolved against ~/.openclaw/.env (often a bare env-var name).
 *
 *  Auth-profiles win when both are set — that's where the real key lives
 *  after a `models auth login`; the openclaw.json field is typically a
 *  placeholder env-var-name. Default agent id is `main`; callers wiring
 *  multi-agent openclaw should pass `agentId` per the agent they wrap. */
export async function captureOpenClawCredentials(
  endpoints: PlannedEndpoint[],
  opts?: { configPath?: string; envPath?: string; agentId?: string },
): Promise<Map<string, CapturedCredential>> {
  const out = new Map<string, CapturedCredential>()
  const configPath = opts?.configPath ?? paths.agent.openclaw
  const config = await readJsonFile<{
    models?: { providers?: Record<string, unknown> }
  }>(configPath)
  const providers = config?.models?.providers ?? {}
  const env = await readDotEnv(opts?.envPath ?? join(dirname(configPath), '.env'))
  const agentId = opts?.agentId ?? 'main'

  for (const ep of endpoints) {
    const provider = providers[ep.modelId]
    if (!isObj(provider)) continue
    // Priority 1: auth-profiles store. This is where openclaw keeps real
    // keys after `openclaw models auth login`.
    const profileKey = await readOpenClawAuthProfileKey(ep.modelId, agentId, configPath)
    if (profileKey) {
      out.set(ep.modelId, { auth: authForDecoder(ep.decoder), value: profileKey })
      continue
    }
    // Priority 2: apiKey field in openclaw.json (env-resolved if it names a
    // var, else taken literally — useful for self-hosted setups).
    const rawKey = provider.apiKey ?? provider.api_key
    const value = resolveSecretInput(rawKey, env)
    if (value !== undefined) {
      out.set(ep.modelId, { auth: authForDecoder(ep.decoder), value })
    }
  }
  return out
}

// ── wire-outcome helper ───────────────────────────────────────────

/** Map captured credentials to the `WireOutcome.secrets` shape — one entry
 *  per active endpoint that has a credential, keyed `provider:<routeKey>`
 *  (the ref convention the routing API and seeded providers share). */
export function buildWireSecrets(
  agent: AgentId,
  endpoints: PlannedEndpoint[],
  captured: Map<string, CapturedCredential>,
): { ref: string; value: string }[] {
  const out: { ref: string; value: string }[] = []
  for (const ep of endpoints) {
    if (ep.active !== true) continue
    const cred = captured.get(ep.modelId)
    // An agent-oauth credential carries no stored value — nothing to persist.
    if (!cred || cred.value === undefined) continue
    out.push({ ref: `provider:${routeKeyForModel(agent, ep.modelId)}`, value: cred.value })
  }
  return out
}
