// Per-agent dynamic header injection. Some agents need headers that
// Codex / ChatGPT-style auth flows expect upstream but that the agent
// itself doesn't always send when configured against an explicit
// base_url.
//
// Today: Codex on ChatGPT auth mode (auth_mode="chatgpt"). OpenAI's
// `api.openai.com/v1/responses` endpoint requires the
// `chatgpt-account-id` header alongside the OAuth bearer token so it
// can scope the call to the right ChatGPT account. Codex's native
// flow sends this against chatgpt.com endpoints; when forced through
// a proxy at api.openai.com, the same auth lands without scope and
// gets 401'd. We inject the header from auth.json.

import { readFile, stat } from 'node:fs/promises'
import { paths } from '../../core/paths.ts'

type CodexAuth = {
  auth_mode?: string
  tokens?: { account_id?: string }
  // legacy: some Codex versions put account_id at the top level
  account_id?: string
}

let codexCache: { mtimeMs: number; auth: CodexAuth } | null = null

async function loadCodexAuth(): Promise<CodexAuth | null> {
  const path = paths.agent.codex.auth
  try {
    const st = await stat(path)
    if (codexCache && codexCache.mtimeMs === st.mtimeMs) return codexCache.auth
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as CodexAuth
    codexCache = { mtimeMs: st.mtimeMs, auth: parsed }
    return parsed
  } catch {
    codexCache = null
    return null
  }
}

/**
 * Headers to inject for the given agent. Caller merges these on top of
 * the request's existing headers (after the host/content-length filter).
 */
export async function dynamicHeadersFor(agent: string): Promise<Record<string, string>> {
  if (agent === 'codex') {
    const auth = await loadCodexAuth()
    if (!auth || auth.auth_mode !== 'chatgpt') return {}
    const accountId = auth.tokens?.account_id ?? auth.account_id
    if (!accountId) return {}
    return { 'chatgpt-account-id': accountId }
  }
  return {}
}
