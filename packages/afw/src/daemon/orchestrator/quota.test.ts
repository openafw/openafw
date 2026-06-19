import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearQuotaSnapshots,
  quotaUsedPct,
  recordQuotaHeaders,
  usedPctFromHeaders,
} from './quota.ts'

describe('usedPctFromHeaders', () => {
  it('reads the Anthropic layout (<bucket>-limit / <bucket>-remaining)', () => {
    const h = new Headers({
      'anthropic-ratelimit-unified-5h-limit': '1000',
      'anthropic-ratelimit-unified-5h-remaining': '250',
    })
    // 750/1000 consumed.
    expect(usedPctFromHeaders(h)).toBeCloseTo(75)
  })

  it('reads the OpenAI layout (limit-<bucket> / remaining-<bucket>)', () => {
    const h = new Headers({
      'x-ratelimit-limit-tokens': '200',
      'x-ratelimit-remaining-tokens': '50',
    })
    expect(usedPctFromHeaders(h)).toBeCloseTo(75)
  })

  it('returns the most-consumed window when several are present', () => {
    const h = new Headers({
      'anthropic-ratelimit-requests-limit': '100',
      'anthropic-ratelimit-requests-remaining': '90', // 10% used
      'anthropic-ratelimit-tokens-limit': '1000',
      'anthropic-ratelimit-tokens-remaining': '100', // 90% used — the binding one
    })
    expect(usedPctFromHeaders(h)).toBeCloseTo(90)
  })

  it('ignores a bucket missing one half of the pair, or a zero limit', () => {
    expect(usedPctFromHeaders(new Headers({ 'anthropic-ratelimit-x-limit': '10' }))).toBeUndefined()
    expect(
      usedPctFromHeaders(
        new Headers({
          'anthropic-ratelimit-x-limit': '0',
          'anthropic-ratelimit-x-remaining': '0',
        }),
      ),
    ).toBeUndefined()
  })

  it('returns undefined when no rate-limit headers are present', () => {
    expect(usedPctFromHeaders(new Headers({ 'content-type': 'application/json' }))).toBeUndefined()
  })
})

describe('recordQuotaHeaders / quotaUsedPct', () => {
  beforeEach(() => clearQuotaSnapshots())

  it('stores and reads back the latest usage for a provider', () => {
    recordQuotaHeaders(
      'claude-sub',
      new Headers({
        'anthropic-ratelimit-unified-5h-limit': '100',
        'anthropic-ratelimit-unified-5h-remaining': '20',
      }),
    )
    expect(quotaUsedPct('claude-sub')).toBeCloseTo(80)
  })

  it('a later response overwrites the snapshot', () => {
    const headers = (remaining: string) =>
      new Headers({ 'x-ratelimit-limit-tokens': '100', 'x-ratelimit-remaining-tokens': remaining })
    recordQuotaHeaders('p', headers('60'))
    recordQuotaHeaders('p', headers('10'))
    expect(quotaUsedPct('p')).toBeCloseTo(90)
  })

  it('does not record (leaves undefined) when headers carry no quota info', () => {
    recordQuotaHeaders('p', new Headers({ 'content-type': 'application/json' }))
    expect(quotaUsedPct('p')).toBeUndefined()
  })

  it('returns undefined for an unseen provider', () => {
    expect(quotaUsedPct('never-called')).toBeUndefined()
  })
})
