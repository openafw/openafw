// Claude (Claude.ai Pro/Max) subscription auth. afw runs its OWN OAuth login
// (`afw oauth login anthropic`) and stores the resulting token set in its own
// store at ~/.afw/oauth/claude-code.json — it deliberately does NOT read Claude
// Code's Keychain / ~/.claude/.credentials.json. afw reads its own token to
// authenticate routes targeting the Anthropic subscription provider, and
// refreshes it when near expiry.
//
// Refresh tokens are single-use: the rotated token is written back to afw's own
// store so the next read picks it up instead of failing with
// refresh_token_reused.
//
// The refresh call goes to platform.claude.com — the same identity provider
// the login flow used. See PRIVACY.md.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite, fileExists } from '../../../core/atomic-file.ts'
import { paths } from '../../../core/paths.ts'
import { withFileLock } from './lock.ts'
import type { OAuthToken, ResolvedToken } from './types.ts'

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const SCOPE =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
const EXPIRY_BUFFER_MS = 5 * 60 * 1000

type ClaudeOAuth = {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  [k: string]: unknown
}
export type ClaudeCreds = { claudeAiOauth?: ClaudeOAuth; [k: string]: unknown }

/** A read/write view over one Claude Code credential store. */
export interface ClaudeStore {
  label: string
  read(): Promise<ClaudeCreds | undefined>
  write(creds: ClaudeCreds): Promise<void>
}

// ── stores ────────────────────────────────────────────────────────

/** A JSON-file credential store (afw's own store path, and the test seam). */
export function fileStore(path: string): ClaudeStore {
  return {
    label: `file ${path}`,
    async read() {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as ClaudeCreds
      } catch {
        return undefined
      }
    },
    async write(creds) {
      await atomicWrite(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 })
    },
  }
}

/** afw's own token store. Returns undefined until the user has run
 *  `afw oauth login anthropic`. */
async function pickStore(): Promise<ClaudeStore | undefined> {
  return (await fileExists(paths.oauth.claudeCode)) ? fileStore(paths.oauth.claudeCode) : undefined
}

// ── refresh ───────────────────────────────────────────────────────

/** Exchange a refresh token for a fresh access token. The rotated refresh
 *  token (when the provider returns one) is in the result and must be
 *  written back to the agent's store by the caller. */
export async function refreshClaudeToken(refreshToken: string): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt: number
}> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPE,
    }),
  })
  if (!res.ok) {
    throw new Error(`claude-code OAuth refresh failed: HTTP ${res.status}`)
  }
  const j = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!j.access_token) {
    throw new Error('claude-code OAuth refresh: response carried no access_token')
  }
  return {
    accessToken: j.access_token,
    // Rotation is optional — keep the current token when none comes back.
    refreshToken: j.refresh_token ?? refreshToken,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
  }
}

/** Resolve a usable access token from `store`, refreshing + writing back the
 *  rotated token when the stored one is within the expiry buffer. No
 *  in-memory cache and no lock — the production entry point adds those; this
 *  is the unit-test seam. */
export async function resolveClaudeToken(store: ClaudeStore): Promise<ResolvedToken> {
  const creds = await store.read()
  const oauth = creds?.claudeAiOauth
  if (!creds || !oauth?.accessToken || !oauth.refreshToken) {
    throw new Error(`claude-code OAuth credentials unavailable (${store.label})`)
  }

  const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0
  if (Date.now() < expiresAt - EXPIRY_BUFFER_MS) {
    return { token: oauth.accessToken, expiresAt }
  }

  const refreshed = await refreshClaudeToken(oauth.refreshToken)
  const updated: ClaudeCreds = {
    ...creds,
    claudeAiOauth: {
      ...oauth,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
    },
  }
  await store.write(updated)
  return { token: refreshed.accessToken, expiresAt: refreshed.expiresAt }
}

// ── public entry point ────────────────────────────────────────────

let cache: ResolvedToken | undefined
let inflight: Promise<ResolvedToken> | undefined

/** True when Claude Code has subscription OAuth credentials on this machine
 *  — used at wire time to mark the route `agent-oauth`. */
export async function claudeCodeOAuthAvailable(): Promise<boolean> {
  const store = await pickStore()
  if (!store) return false
  const creds = await store.read()
  return typeof creds?.claudeAiOauth?.refreshToken === 'string'
}

/** The orchestrator entry point: a fresh access token, cached in memory and
 *  refreshed at most once across concurrent callers. */
export async function getClaudeCodeToken(): Promise<OAuthToken> {
  if (cache && Date.now() < cache.expiresAt - EXPIRY_BUFFER_MS) {
    return { token: cache.token }
  }
  if (inflight) return inflight
  inflight = (async () => {
    const store = await pickStore()
    if (!store) {
      throw new Error('claude-code OAuth credentials not found')
    }
    const lockPath = join(paths.home, 'oauth-claude-code.lock')
    const resolved = await withFileLock(lockPath, () => resolveClaudeToken(store))
    cache = resolved
    return resolved
  })().finally(() => {
    inflight = undefined
  })
  return inflight
}

/** Test-only: clear the in-memory token cache. */
export function __resetClaudeCache(): void {
  cache = undefined
  inflight = undefined
}
