import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { decodeJwtExp } from './jwt.ts'

function jwt(payload: object): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'none' })}.${seg(payload)}.sig`
}

describe('decodeJwtExp', () => {
  it('reads a numeric exp claim', () => {
    expect(decodeJwtExp(jwt({ exp: 1893456000, sub: 'x' }))).toBe(1893456000)
  })

  it('returns undefined when exp is absent or non-numeric', () => {
    expect(decodeJwtExp(jwt({ sub: 'x' }))).toBeUndefined()
    expect(decodeJwtExp(jwt({ exp: 'soon' }))).toBeUndefined()
  })

  it('returns undefined for a malformed token', () => {
    expect(decodeJwtExp('not-a-jwt')).toBeUndefined()
    expect(decodeJwtExp('')).toBeUndefined()
    expect(decodeJwtExp('a.!!!.c')).toBeUndefined()
  })
})
