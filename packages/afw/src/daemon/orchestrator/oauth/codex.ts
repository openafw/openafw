// Codex subscription auth. Codex's ChatGPT login (`codex login`) stores an
// OAuth token set in ~/.codex/auth.json under `tokens`. afw reads that
// token to authenticate routes targeting Codex's OpenAI provider, and
// refreshes it when near expiry.
//
// Refresh tokens are single-use: the rotated token is written back to
// auth.json so Codex picks it up on its next read instead of failing with
// refresh_token_reused — afw is a cooperative co-refresher.
//
// The refresh call goes to auth.openai.com — the same identity provider
// Codex itself calls to refresh the same token. See PRIVACY.md.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from '../../../core/atomic-file.ts'
import { paths } from '../../../core/paths.ts'
import { decodeJwtExp } from './jwt.ts'
import { withFileLock } from './lock.ts'
import type { OAuthToken, ResolvedToken } from './types.ts'

const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const EXPIRY_BUFFER_MS = 5 * 60 * 1000
// No JWT `exp`? Treat a token last refreshed over 8 days ago as expired.
const LAST_REFRESH_MAX_MS = 8 * 24 * 60 * 60 * 1000

type CodexTokens = {
  id_token?: string
  access_token?: string
  refresh_token?: string
  account_id?: string
  [k: string]: unknown
}
export type CodexAuth = {
  OPENAI_API_KEY?: string | null
  auth_mode?: string
  tokens?: CodexTokens
  last_refresh?: string
  [k: string]: unknown
}

async function readCodexAuth(path: string): Promise<CodexAuth | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as CodexAuth
  } catch {
    return undefined
  }
}

async function writeCodexAuth(path: string, auth: CodexAuth): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
}

/** Expiry (epoch ms) of an access token — its JWT `exp`, or one hour out
 *  when the token carries none. */
function expiryOf(accessToken: string): number {
  const exp = decodeJwtExp(accessToken)
  return exp !== undefined ? exp * 1000 : Date.now() + 60 * 60 * 1000
}

/** True when the stored access token is comfortably in date. */
function codexTokenFresh(auth: CodexAuth): boolean {
  const access = auth.tokens?.access_token
  if (!access) return false
  const exp = decodeJwtExp(access)
  if (exp !== undefined) return Date.now() < exp * 1000 - EXPIRY_BUFFER_MS
  // No JWT exp — fall back to the last_refresh timestamp.
  if (typeof auth.last_refresh === 'string') {
    const t = Date.parse(auth.last_refresh)
    if (!Number.isNaN(t)) return Date.now() - t < LAST_REFRESH_MAX_MS
  }
  return false
}

/** Exchange a refresh token for a fresh token set. The rotated refresh
 *  token (when returned) is in the result and must be written back. */
export async function refreshCodexToken(refreshToken: string): Promise<{
  accessToken: string
  refreshToken: string
  idToken?: string
}> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })
  if (!res.ok) {
    throw new Error(`codex OAuth refresh failed: HTTP ${res.status}`)
  }
  const j = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    id_token?: string
  }
  if (!j.access_token) {
    throw new Error('codex OAuth refresh: response carried no access_token')
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? refreshToken,
    ...(j.id_token ? { idToken: j.id_token } : {}),
  }
}

/** Resolve a usable access token from the auth.json at `path`, refreshing +
 *  writing back the rotated token when the stored one is near expiry. No
 *  in-memory cache and no lock — the production entry point adds those; this
 *  is the unit-test seam. */
export async function resolveCodexToken(path: string): Promise<ResolvedToken> {
  const auth = await readCodexAuth(path)
  const tokens = auth?.tokens
  if (!auth || !tokens?.access_token || !tokens.refresh_token) {
    throw new Error('codex OAuth credentials unavailable')
  }
  const accountId = typeof tokens.account_id === 'string' ? tokens.account_id : undefined

  if (codexTokenFresh(auth)) {
    return {
      token: tokens.access_token,
      ...(accountId ? { accountId } : {}),
      expiresAt: expiryOf(tokens.access_token),
    }
  }

  const refreshed = await refreshCodexToken(tokens.refresh_token)
  const updated: CodexAuth = {
    ...auth,
    tokens: {
      ...tokens,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      ...(refreshed.idToken ? { id_token: refreshed.idToken } : {}),
    },
    last_refresh: new Date().toISOString(),
  }
  await writeCodexAuth(path, updated)
  return {
    token: refreshed.accessToken,
    ...(accountId ? { accountId } : {}),
    expiresAt: expiryOf(refreshed.accessToken),
  }
}

// ── public entry point ────────────────────────────────────────────

let cache: ResolvedToken | undefined
let inflight: Promise<ResolvedToken> | undefined

/** The orchestrator entry point: a fresh access token (and ChatGPT account
 *  id), cached in memory and refreshed at most once across concurrent
 *  callers. */
export async function getCodexToken(): Promise<OAuthToken> {
  if (cache && Date.now() < cache.expiresAt - EXPIRY_BUFFER_MS) {
    return { token: cache.token, ...(cache.accountId ? { accountId: cache.accountId } : {}) }
  }
  if (inflight) return inflight
  inflight = (async () => {
    const lockPath = join(paths.home, 'oauth-codex.lock')
    const resolved = await withFileLock(lockPath, () => resolveCodexToken(paths.agent.codex.auth))
    cache = resolved
    return resolved
  })().finally(() => {
    inflight = undefined
  })
  return inflight
}

/** Test-only: clear the in-memory token cache. */
export function __resetCodexCache(): void {
  cache = undefined
  inflight = undefined
}
