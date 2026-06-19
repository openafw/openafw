import { describe, expect, it } from 'vitest'
import { normalizeTiers, tierDisplay, tierForModelName, tierModelNames } from './tiers.ts'

describe('tierForModelName', () => {
  it('resolves the canonical Chinese names', () => {
    expect(tierForModelName('Tall')).toBe('tall')
    expect(tierForModelName('Grande')).toBe('grande')
    expect(tierForModelName('Venti')).toBe('venti')
  })

  it('accepts English aliases case-insensitively', () => {
    expect(tierForModelName('Tall')).toBe('tall')
    expect(tierForModelName('GRANDE')).toBe('grande')
    expect(tierForModelName(' venti ')).toBe('venti')
  })

  it('returns undefined for anything else', () => {
    expect(tierForModelName('gpt-4o')).toBeUndefined()
    expect(tierForModelName('')).toBeUndefined()
  })
})

describe('tier names', () => {
  it('lists the three names low → high', () => {
    expect(tierModelNames()).toEqual(['Tall', 'Grande', 'Venti'])
  })

  it('maps a tier to its display name', () => {
    expect(tierDisplay('venti')).toBe('Venti')
  })
})

describe('normalizeTiers', () => {
  it('keeps a mapped tier', () => {
    const out = normalizeTiers({
      version: 1,
      tiers: { grande: { target: { kind: 'chain', members: [{ modelId: 'gpt-x' }] } } },
    })
    expect(out.tiers.grande?.target).toEqual({ kind: 'chain', members: [{ modelId: 'gpt-x' }] })
    expect(out.tiers.tall).toBeUndefined()
  })

  it('drops a passthrough (unmapped) tier', () => {
    const out = normalizeTiers({
      version: 1,
      tiers: { tall: { target: { kind: 'passthrough' } } },
    })
    expect(out.tiers.tall).toBeUndefined()
  })

  it('keeps a composite (fusion) tier', () => {
    const out = normalizeTiers({
      version: 1,
      tiers: { venti: { target: { kind: 'composite', comboId: 'panel' } } },
    })
    expect(out.tiers.venti?.target).toEqual({ kind: 'composite', comboId: 'panel' })
  })

  it('returns empty for non-object input', () => {
    expect(normalizeTiers(null).tiers).toEqual({})
  })

  it('throws on an unsupported version', () => {
    expect(() => normalizeTiers({ version: 99, tiers: {} })).toThrow()
  })
})
