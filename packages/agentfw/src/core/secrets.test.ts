import { describe, expect, it } from 'vitest'
import { getSecret, normalizeSecretStore, secretRefs } from './secrets.ts'

describe('normalizeSecretStore', () => {
  it('round-trips a valid store', () => {
    const store = { version: 1, secrets: { 'openai-key': 'sk-abc' } }
    expect(normalizeSecretStore(store)).toEqual(store)
  })

  it('returns an empty store for non-object input', () => {
    expect(normalizeSecretStore(null).secrets).toEqual({})
  })

  it('throws on an unsupported version', () => {
    expect(() => normalizeSecretStore({ version: 3, secrets: {} })).toThrow()
  })

  it('drops non-string secret values', () => {
    const store = normalizeSecretStore({
      version: 1,
      secrets: { good: 'value', bad: 123, alsoBad: null },
    })
    expect(store.secrets).toEqual({ good: 'value' })
  })
})

describe('secret helpers', () => {
  const store = { version: 1 as const, secrets: { a: 'one', b: 'two' } }

  it('reads a secret by ref', () => {
    expect(getSecret(store, 'a')).toBe('one')
    expect(getSecret(store, 'missing')).toBeUndefined()
  })

  it('lists configured refs without exposing values', () => {
    expect(secretRefs(store).sort()).toEqual(['a', 'b'])
  })
})
