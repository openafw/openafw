// Claude Code subscription auth. Claude Code (Claude.ai login) stores an
// OAuth credential set in the macOS Keychain — service "Claude Code-
// credentials" — with ~/.claude/.credentials.json as the fallback store.
// afw reads that token to authenticate routes targeting Claude Code's
// Anthropic provider, and refreshes it when near expiry.
//
// Refresh tokens are single-use: the refreshed token MUST be written back
// to the agent's own store so Claude Code picks up the rotated token on its
// next read instead of failing with refresh_token_reused. This makes afw
// a cooperative co-refresher rather than a competitor.
//
// The refresh call goes to platform.claude.com — the same identity provider
// Claude Code itself calls to refresh the same token. See PRIVACY.md.

import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { atomicWrite, fileExists } from '../../../core/atomic-file.ts'
import { logger } from '../../../core/logger.ts'
import { paths } from '../../../core/paths.ts'
import { withFileLock } from './lock.ts'
import type { OAuthToken, ResolvedToken } from './types.ts'

const execFileP = promisify(execFile)

const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const CREDENTIALS_FILE = join(homedir(), '.claude', '.credentials.json')
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

/** The ~/.claude/.credentials.json store (also the test seam). */
export function fileStore(path: string = CREDENTIALS_FILE): ClaudeStore {
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

async function runSecurity(args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP('security', args)
    return stdout
  } catch {
    return undefined
  }
}

/** `security -w` returns the password verbatim when printable; for a blob it
 *  may hex-encode it. Claude Code stores JSON, so accept either form. */
function decodeKeychainValue(raw: string): string | undefined {
  const v = raw.trim()
  if (v === '') return undefined
  if (v.startsWith('{')) return v
  if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) {
    try {
      const decoded = Buffer.from(v, 'hex').toString('utf8')
      if (decoded.startsWith('{')) return decoded
    } catch {
      /* fall through */
    }
  }
  return v
}

async function keychainAccount(): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileP('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-g',
    ])
    const m = `${stderr}${stdout}`.match(/"acct"<blob>=(?:0x[0-9A-Fa-f]+\s+)?"([^"]*)"/)
    return m?.[1]
  } catch {
    return undefined
  }
}

function keychainStore(): ClaudeStore {
  let account = ''
  return {
    label: `keychain ${KEYCHAIN_SERVICE}`,
    async read() {
      const pw = await runSecurity(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'])
      if (pw === undefined) return undefined
      const json = decodeKeychainValue(pw)
      if (!json) return undefined
      try {
        const creds = JSON.parse(json) as ClaudeCreds
        account = (await keychainAccount()) ?? ''
        return creds
      } catch {
        return undefined
      }
    },
    async write(creds) {
      // Without the item's account, `add-generic-password -U` would create a
      // duplicate item instead of updating — skip rather than corrupt.
      if (account === '') {
        logger.warn('oauth: claude-code keychain account unknown; skipped token write-back')
        return
      }
      try {
        await execFileP('security', [
          'add-generic-password',
          '-U',
          '-a',
          account,
          '-s',
          KEYCHAIN_SERVICE,
          '-w',
          JSON.stringify(creds),
        ])
      } catch (err) {
        logger.warn(`oauth: claude-code keychain write-back failed — ${(err as Error).message}`)
      }
    },
  }
}

async function keychainHasItem(): Promise<boolean> {
  try {
    await execFileP('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE])
    return true
  } catch {
    return false
  }
}

/** Pick the live credential store: Keychain on macOS, else the JSON file. */
async function pickStore(): Promise<ClaudeStore | undefined> {
  if (process.platform === 'darwin' && (await keychainHasItem())) {
    return keychainStore()
  }
  if (await fileExists(CREDENTIALS_FILE)) return fileStore()
  return undefined
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
