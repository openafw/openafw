import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parsePastedCode } from './login.ts'
import { generatePkce, generateState } from './pkce.ts'

describe('generatePkce', () => {
  it('derives the challenge as base64url(SHA256(verifier)), no padding', () => {
    const { verifier, challenge } = generatePkce()
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expected)
    expect(challenge).not.toContain('=')
    expect(challenge).not.toContain('+')
    expect(challenge).not.toContain('/')
  })

  it('produces a fresh verifier each call', () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier)
    expect(generateState()).not.toBe(generateState())
  })
})

describe('parsePastedCode', () => {
  const state = 'st-123'

  it('accepts a bare code', () => {
    expect(parsePastedCode('abc123', state)).toBe('abc123')
  })

  it('accepts a code#state pair when the state matches', () => {
    expect(parsePastedCode('abc123#st-123', state)).toBe('abc123')
  })

  it('rejects a code#state pair when the state mismatches', () => {
    expect(parsePastedCode('abc123#wrong', state)).toBeUndefined()
  })

  it('extracts the code from a full redirect URL', () => {
    expect(parsePastedCode('http://localhost:1455/auth/callback?code=xyz&state=st-123', state)).toBe(
      'xyz',
    )
  })

  it('rejects a redirect URL with a mismatched state', () => {
    expect(
      parsePastedCode('http://localhost:1455/auth/callback?code=xyz&state=nope', state),
    ).toBeUndefined()
  })

  it('returns undefined for empty input', () => {
    expect(parsePastedCode('   ', state)).toBeUndefined()
  })
})
