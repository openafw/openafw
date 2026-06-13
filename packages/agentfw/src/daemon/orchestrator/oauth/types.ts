// Shared types for the subscription-OAuth modules. agentfw reads (and, when
// near expiry, refreshes) a subscription access token from the owning
// agent's own credential store, acting as a cooperative co-refresher.

export type OAuthAgent = 'claude-code' | 'codex'

/** What the orchestrator needs to authenticate one upstream call. */
export type OAuthToken = { token: string; accountId?: string }

/** A resolved token plus its expiry — the internal shape the per-agent
 *  modules hand back so the dispatcher can cache it. */
export type ResolvedToken = OAuthToken & { expiresAt: number }
