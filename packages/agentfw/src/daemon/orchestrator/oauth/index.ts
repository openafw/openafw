// Subscription-OAuth dispatcher. Routes targeting an agent's subscription
// provider authenticate with a token agentfw reads — and co-refreshes — from
// that agent's own credential store.

import { getClaudeCodeToken } from './claude-code.ts'
import { getCodexToken } from './codex.ts'
import type { OAuthAgent, OAuthToken } from './types.ts'

export type { OAuthAgent, OAuthToken } from './types.ts'

/** A fresh subscription access token for the named agent. */
export function getAgentToken(agent: OAuthAgent): Promise<OAuthToken> {
  return agent === 'codex' ? getCodexToken() : getClaudeCodeToken()
}
