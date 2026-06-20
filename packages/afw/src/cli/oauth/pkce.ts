// PKCE (RFC 7636) + state generation for afw's OAuth login flows. The verifier
// is a high-entropy random string; the challenge is its SHA-256, base64url
// without padding (the `S256` method every provider here uses).

import { createHash, randomBytes } from 'node:crypto'

function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

export type Pkce = { verifier: string; challenge: string }

/** A fresh PKCE verifier + S256 challenge pair. */
export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** An opaque anti-CSRF `state` value for the authorize request. */
export function generateState(): string {
  return base64url(randomBytes(16))
}
