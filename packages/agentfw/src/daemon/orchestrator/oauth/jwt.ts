// Minimal JWT inspection — read the `exp` claim without verifying the
// signature. Used only to decide whether a token agentfw already holds is
// near expiry; the upstream still verifies the token for real.

import { Buffer } from 'node:buffer'

/** The `exp` claim (epoch seconds) of a JWT, or undefined when the token is
 *  malformed or carries no numeric `exp`. */
export function decodeJwtExp(token: string): number | undefined {
  const parts = token.split('.')
  const payload = parts[1]
  if (parts.length < 2 || !payload) return undefined
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8')
    const claims = JSON.parse(json) as { exp?: unknown }
    return typeof claims.exp === 'number' ? claims.exp : undefined
  } catch {
    return undefined
  }
}
