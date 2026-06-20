// Minimal JWT inspection — read the `exp` claim without verifying the
// signature. Used only to decide whether a token afw already holds is
// near expiry; the upstream still verifies the token for real.

import { Buffer } from 'node:buffer'

/** Decode a JWT's payload claims without verifying the signature, or undefined
 *  when the token is malformed. The upstream still verifies for real. */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  const payload = parts[1]
  if (parts.length < 2 || !payload) return undefined
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8')
    const claims = JSON.parse(json) as unknown
    return typeof claims === 'object' && claims !== null
      ? (claims as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** The `exp` claim (epoch seconds) of a JWT, or undefined when the token is
 *  malformed or carries no numeric `exp`. */
export function decodeJwtExp(token: string): number | undefined {
  const exp = decodeJwtPayload(token)?.exp
  return typeof exp === 'number' ? exp : undefined
}
