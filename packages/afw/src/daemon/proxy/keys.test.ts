import { describe, expect, it } from 'vitest'
import { decoderForPath, tokenFromHeaders } from './keys.ts'

describe('tokenFromHeaders', () => {
  it('reads a Bearer token (OpenAI clients)', () => {
    expect(tokenFromHeaders(new Headers({ authorization: 'Bearer afw_123' }))).toBe('afw_123')
  })

  it('is case-insensitive on the Bearer scheme', () => {
    expect(tokenFromHeaders(new Headers({ authorization: 'bearer afw_123' }))).toBe('afw_123')
  })

  it('reads x-api-key (Anthropic clients)', () => {
    expect(tokenFromHeaders(new Headers({ 'x-api-key': 'afw_xyz' }))).toBe('afw_xyz')
  })

  it('prefers Authorization over x-api-key when both are present', () => {
    const h = new Headers({ authorization: 'Bearer one', 'x-api-key': 'two' })
    expect(tokenFromHeaders(h)).toBe('one')
  })

  it('returns empty string when no auth header is present', () => {
    expect(tokenFromHeaders(new Headers())).toBe('')
  })
})

describe('decoderForPath', () => {
  it('maps OpenAI chat completions', () => {
    expect(decoderForPath('/v1/chat/completions')).toBe('openai-chat')
  })

  it('maps the Responses API', () => {
    expect(decoderForPath('/v1/responses')).toBe('openai-responses')
  })

  it('maps Anthropic messages', () => {
    expect(decoderForPath('/v1/messages')).toBe('anthropic')
  })

  it('returns undefined for an unsupported path', () => {
    expect(decoderForPath('/v1/models')).toBeUndefined()
    expect(decoderForPath('/v1/embeddings')).toBeUndefined()
  })
})
