// afw's own OAuth login flows. afw is a first-class OAuth client here: it runs
// the PKCE authorize → localhost-callback → token-exchange dance itself and
// persists the resulting tokens to its OWN store under ~/.afw/oauth/. It never
// reads Claude Code's Keychain or Codex's auth.json — the user logs in through
// afw separately. The orchestrator (daemon/orchestrator/oauth/) then reads +
// co-refreshes these tokens at request time via the `agent-oauth` auth kind.
//
// Client IDs / endpoints are the providers' public PKCE clients (the same ones
// the first-party CLIs use). Two flows are wired today: Anthropic (Claude
// Pro/Max) and OpenAI (ChatGPT/Codex subscription), both PKCE + localhost
// callback. Device-code providers (GitHub Copilot, MiniMax, …) can slot in as
// new entries with a `flow: 'device'` branch.

import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'
import { atomicWrite } from '../../core/atomic-file.ts'
import { logger } from '../../core/logger.ts'
import type { ModelApi } from '../../core/model-registry.ts'
import { paths } from '../../core/paths.ts'
import { decodeJwtPayload } from '../../daemon/orchestrator/oauth/jwt.ts'
import { confirmYesNo, promptText } from '../util/prompt.ts'
import { openBrowser } from './browser.ts'
import { generatePkce, generateState } from './pkce.ts'

export type OAuthProviderKey = 'anthropic' | 'openai'

type TokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
}

type OAuthProviderDef = {
  key: OAuthProviderKey
  label: string
  clientId: string
  authorizeUrl: string
  tokenUrl: string
  scope: string
  redirectHost: string
  redirectPort: number
  redirectPath: string
  /** Token endpoint body encoding. */
  tokenStyle: 'json' | 'form'
  /** Extra authorize-request query params beyond the PKCE/OIDC standard set. */
  extraAuthorize?: Record<string, string>
  /** How onboarding should register the provider once login succeeds — the
   *  agent-oauth slot it populates, plus the subscription's wire endpoint. */
  register: { agent: 'claude-code' | 'codex'; baseUrl: string; api: ModelApi }
  /** Persist the token response into afw's own store, in the shape the
   *  matching orchestrator resolver reads. */
  persist: (tok: TokenResponse) => Promise<void>
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

/** The ChatGPT account id is carried as a custom claim in the access (or id)
 *  token JWT. The Codex backend rejects requests without it. */
function chatgptAccountId(tok: TokenResponse): string | undefined {
  for (const jwt of [tok.access_token, tok.id_token]) {
    if (!jwt) continue
    const claims = decodeJwtPayload(jwt)
    const direct = claims?.['https://api.openai.com/auth.chatgpt_account_id']
    if (typeof direct === 'string' && direct) return direct
    const fallback = claims?.['https://api.openai.com/auth.chatgpt_account_user_id']
    if (typeof fallback === 'string' && fallback) return fallback
  }
  return undefined
}

export const OAUTH_PROVIDERS: Record<OAuthProviderKey, OAuthProviderDef> = {
  anthropic: {
    key: 'anthropic',
    label: 'Anthropic (Claude Pro/Max subscription)',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    scope:
      'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
    redirectHost: '127.0.0.1',
    redirectPort: 53692,
    redirectPath: '/callback',
    tokenStyle: 'json',
    extraAuthorize: { code: 'true' },
    register: { agent: 'claude-code', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' },
    async persist(tok) {
      const expiresAt = Date.now() + (tok.expires_in ?? 3600) * 1000
      await writeJson(paths.oauth.claudeCode, {
        claudeAiOauth: {
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token,
          expiresAt,
        },
      })
    },
  },
  openai: {
    key: 'openai',
    label: 'OpenAI (ChatGPT/Codex subscription)',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    scope: 'openid profile email offline_access',
    redirectHost: 'localhost',
    redirectPort: 1455,
    redirectPath: '/auth/callback',
    tokenStyle: 'form',
    extraAuthorize: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'afw',
    },
    register: { agent: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', api: 'openai-responses' },
    async persist(tok) {
      await writeJson(paths.oauth.codex, {
        auth_mode: 'chatgpt',
        tokens: {
          access_token: tok.access_token,
          refresh_token: tok.refresh_token,
          ...(tok.id_token ? { id_token: tok.id_token } : {}),
          ...(chatgptAccountId(tok) ? { account_id: chatgptAccountId(tok) } : {}),
        },
        last_refresh: new Date().toISOString(),
      })
    },
  },
}

function redirectUri(def: OAuthProviderDef): string {
  return `http://${def.redirectHost}:${def.redirectPort}${def.redirectPath}`
}

function authorizeUrl(def: OAuthProviderDef, challenge: string, state: string): string {
  const u = new URL(def.authorizeUrl)
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: def.clientId,
    redirect_uri: redirectUri(def),
    scope: def.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    ...def.extraAuthorize,
  }
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}

/** Pull the authorization code out of whatever the user pasted: a bare code, a
 *  `code#state` pair, or the full redirected URL. Returns undefined when it
 *  can't find one or the state doesn't match. */
export function parsePastedCode(input: string, state: string): string | undefined {
  const text = input.trim()
  if (text === '') return undefined
  if (text.includes('://')) {
    try {
      const u = new URL(text)
      const code = u.searchParams.get('code')
      const got = u.searchParams.get('state')
      if (code && (!got || got === state)) return code
    } catch {
      return undefined
    }
    return undefined
  }
  // `code#state` (Anthropic's manual-copy format) or a bare code.
  const [code, got] = text.split('#')
  if (code && (!got || got === state)) return code
  return undefined
}

const OK_PAGE =
  '<!doctype html><meta charset="utf-8"><title>afw</title>' +
  '<body style="font-family:system-ui;padding:3rem;text-align:center">' +
  '<h2>✓ afw is now connected</h2><p>You can close this tab and return to the terminal.</p>'
const ERR_PAGE =
  '<!doctype html><meta charset="utf-8"><title>afw</title>' +
  '<body style="font-family:system-ui;padding:3rem;text-align:center">' +
  '<h2>Login failed</h2><p>Return to the terminal and try again.</p>'

/** Wait for the authorization code via either the localhost callback or a
 *  hand-pasted code — whichever arrives first. */
function awaitAuthCode(def: OAuthProviderDef, state: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${def.redirectHost}:${def.redirectPort}`)
      if (url.pathname !== def.redirectPath) {
        res.writeHead(404)
        res.end()
        return
      }
      const code = url.searchParams.get('code')
      const got = url.searchParams.get('state')
      if (!code || (got && got !== state)) {
        res.writeHead(400, { 'content-type': 'text/html' })
        res.end(ERR_PAGE)
        finish(undefined, new Error('OAuth callback carried no code or a mismatched state'))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(OK_PAGE)
      finish(code)
    })

    const finish = (code?: string, err?: Error): void => {
      if (settled) return
      settled = true
      server.close()
      if (code) resolve(code)
      else reject(err ?? new Error('OAuth login cancelled'))
    }

    server.on('error', (err) => finish(undefined, err as Error))
    server.listen(def.redirectPort, def.redirectHost)

    // Manual paste fallback in parallel — covers headless boxes and browsers
    // that land on a different machine. Resolves the same promise.
    void promptText('  …or paste the authorization code / redirect URL here').then((answer) => {
      if (settled) return
      const code = parsePastedCode(answer, state)
      if (code) finish(code)
    })
  })
}

async function exchangeCode(
  def: OAuthProviderDef,
  code: string,
  verifier: string,
  state: string,
): Promise<TokenResponse> {
  const fields: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: def.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri(def),
    state,
  }
  const res =
    def.tokenStyle === 'json'
      ? await fetch(def.tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(fields),
        })
      : await fetch(def.tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(fields).toString(),
        })
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`token exchange failed: HTTP ${res.status} ${body}`)
  }
  return (await res.json()) as TokenResponse
}

/** Run an interactive OAuth login for `key`. Opens the browser, waits for the
 *  callback (or a pasted code), exchanges it, and writes the tokens to afw's
 *  own store. Returns the provider def on success (so the caller can register
 *  the provider), or null when not on a TTY / cancelled. */
export async function oauthLogin(key: OAuthProviderKey): Promise<OAuthProviderDef | null> {
  if (!process.stdin.isTTY) return null
  const def = OAUTH_PROVIDERS[key]
  const { verifier, challenge } = generatePkce()
  const state = generateState()
  const url = authorizeUrl(def, challenge, state)

  logger.print(`\nLogging in to ${def.label} via afw.`)
  logger.print('Opening your browser to authorize. If it does not open, visit:\n')
  logger.print(`  ${url}\n`)
  openBrowser(url)

  let code: string
  try {
    code = await awaitAuthCode(def, state)
  } catch (err) {
    logger.print(`  ✗ login failed: ${(err as Error).message}`)
    return null
  }

  try {
    const tokens = await exchangeCode(def, code, verifier, state)
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error('token endpoint returned no access/refresh token')
    }
    await def.persist(tokens)
  } catch (err) {
    logger.print(`  ✗ ${(err as Error).message}`)
    if (await confirmYesNo('  Try the login again?', false)) return oauthLogin(key)
    return null
  }

  logger.print(`  ✓ logged in — afw stored your ${def.label} token locally.`)
  return def
}
