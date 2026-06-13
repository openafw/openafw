import { describe, expect, it } from 'vitest'
import {
  activeProviderFor,
  normalizeToolProviders,
  SEEDED_DDG,
} from './tool-providers.ts'

describe('normalizeToolProviders', () => {
  it('returns the seeded DDG default for an empty / missing store', () => {
    const a = normalizeToolProviders(undefined)
    const b = normalizeToolProviders({})
    expect(a.providers.map((p) => p.id)).toEqual(['ddg'])
    expect(b.providers.map((p) => p.id)).toEqual(['ddg'])
  })

  it('drops malformed entries but keeps valid ones', () => {
    const out = normalizeToolProviders({
      version: 1,
      providers: [
        { id: 'good', kind: 'web_search', backend: 'brave', label: 'Good', origin: 'manual' },
        { id: '', kind: 'web_search', backend: 'brave' }, // dropped (no id)
        { id: 'bad-kind', kind: 'image_gen', backend: 'brave' }, // dropped (unknown kind)
        { id: 'bad-backend', kind: 'web_search', backend: 'mystery' }, // dropped
      ],
      active: { web_search: 'good' },
    })
    expect(out.providers.map((p) => p.id).sort()).toEqual(['good'])
    expect(out.active).toEqual({ web_search: 'good' })
  })

  it('appends the seeded DDG entry when no web_search provider exists', () => {
    const out = normalizeToolProviders({ version: 1, providers: [], active: {} })
    expect(out.providers).toContainEqual(SEEDED_DDG)
  })
})

describe('activeProviderFor', () => {
  const store = {
    version: 1 as const,
    providers: [
      { id: 'ddg', label: 'DDG', kind: 'web_search' as const, backend: 'duckduckgo' as const, origin: 'seeded' as const },
      { id: 'my-brave', label: 'My Brave', kind: 'web_search' as const, backend: 'brave' as const, authRef: 'tool-provider:my-brave', origin: 'manual' as const },
    ],
    active: { web_search: 'my-brave' as string | undefined },
  }

  it('returns the explicitly-active provider when one is set', () => {
    expect(activeProviderFor(store, 'web_search')?.id).toBe('my-brave')
  })

  it('falls back to the first provider of the kind when active is unset', () => {
    const s = { ...store, active: {} }
    expect(activeProviderFor(s, 'web_search')?.id).toBe('ddg')
  })

  it('ignores a stale active pointer to a deleted id', () => {
    const s = { ...store, active: { web_search: 'gone' } }
    // Falls back to first matching kind.
    expect(activeProviderFor(s, 'web_search')?.id).toBe('ddg')
  })
})
