import { describe, expect, it } from 'vitest'
import {
  deriveKeyId,
  findKeyByAgentInstance,
  findKeyById,
  findKeyByToken,
  generateToken,
  keysForAgent,
  normalizeAccessKeys,
} from './access-keys.ts'

describe('normalizeAccessKeys', () => {
  it('round-trips a session key', () => {
    const store = {
      version: 1,
      keys: [
        {
          id: 'app-a1b2',
          label: 'app-a1b2',
          token: 'afw_k7m2qd',
          agent: 'claude-code',
          instance: 'app-a1b2',
          createdAt: 100,
        },
      ],
    }
    expect(normalizeAccessKeys(store)).toEqual(store)
  })

  it('defaults a missing label to the id and agent to byok', () => {
    const out = normalizeAccessKeys({ version: 1, keys: [{ id: 'k', token: 't' }] })
    expect(out.keys[0]?.label).toBe('k')
    expect(out.keys[0]?.agent).toBe('byok')
    expect(out.keys[0]?.createdAt).toBe(0)
  })

  it('drops entries without an id or token', () => {
    const out = normalizeAccessKeys({
      version: 1,
      keys: [{ id: 'ok', token: 't' }, { id: '', token: 't' }, { id: 'no-token' }],
    })
    expect(out.keys.map((k) => k.id)).toEqual(['ok'])
  })

  it('preserves lastUsedAt when present', () => {
    const out = normalizeAccessKeys({
      version: 1,
      keys: [{ id: 'k', token: 't', createdAt: 1, lastUsedAt: 2 }],
    })
    expect(out.keys[0]?.lastUsedAt).toBe(2)
  })

  it('returns an empty store for non-object input', () => {
    expect(normalizeAccessKeys(null).keys).toEqual([])
  })

  it('throws on an unsupported version', () => {
    expect(() => normalizeAccessKeys({ version: 99, keys: [] })).toThrow()
  })
})

describe('lookup helpers', () => {
  const store = normalizeAccessKeys({
    version: 1,
    keys: [
      { id: 'a', token: 'tok-a', agent: 'openclaw' },
      { id: 'b', token: 'tok-b', agent: 'openclaw' },
      { id: 'c', token: 'tok-c', agent: 'claude-code', instance: 'app-9f' },
    ],
  })

  it('finds a key by token', () => {
    expect(findKeyByToken(store, 'tok-b')?.id).toBe('b')
    expect(findKeyByToken(store, 'nope')).toBeUndefined()
    expect(findKeyByToken(store, '')).toBeUndefined()
  })

  it('finds a key by id', () => {
    expect(findKeyById(store, 'a')?.token).toBe('tok-a')
    expect(findKeyById(store, 'missing')).toBeUndefined()
  })

  it('lists keys for one agent', () => {
    expect(keysForAgent(store, 'openclaw').map((k) => k.id)).toEqual(['a', 'b'])
    expect(keysForAgent(store, 'codex')).toEqual([])
  })

  it('finds a session key by (agent, instance)', () => {
    expect(findKeyByAgentInstance(store, 'claude-code', 'app-9f')?.id).toBe('c')
    expect(findKeyByAgentInstance(store, 'claude-code', 'other')).toBeUndefined()
  })
})

describe('deriveKeyId', () => {
  it('slugifies a label', () => {
    expect(deriveKeyId('My CI Bot', [])).toBe('my-ci-bot')
  })

  it('suffixes to avoid collisions', () => {
    expect(deriveKeyId('default', ['default'])).toBe('default-2')
    expect(deriveKeyId('default', ['default', 'default-2'])).toBe('default-3')
  })

  it('falls back to "key" for an empty/symbol-only label', () => {
    expect(deriveKeyId('', [])).toBe('key')
    expect(deriveKeyId('***', [])).toBe('key')
  })
})

describe('generateToken', () => {
  it('produces a short prefixed token', () => {
    expect(generateToken()).toMatch(/^afw_[a-z0-9]{6}$/)
  })

  it('avoids tokens already taken', () => {
    // Exhaust most of a tiny alphabet space by pre-taking; just assert it
    // never returns one of the taken values across many draws.
    const taken = new Set(['afw_aaaaaa'])
    for (let i = 0; i < 50; i++) expect(taken.has(generateToken(taken))).toBe(false)
  })
})
