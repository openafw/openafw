import { describe, expect, it } from 'vitest'
import {
  COMPACT_HEADROOM_TOKENS,
  COMPACT_RESERVE_TOKENS,
  decideAutoCompactWindow,
} from './auto-compact.ts'

describe('decideAutoCompactWindow', () => {
  it('injects the model window when the threshold clears the baseline', () => {
    // 131072 − 33000 = 98072 threshold; baseline 40k + 20k headroom = 60k < 98072
    const d = decideAutoCompactWindow({ contextWindow: 131072, baselineTokens: 40000 })
    expect(d).toEqual({ inject: true, window: 131072 })
  })

  it('skips when the baseline would compact on the first prompt', () => {
    // The reported real-world case: ~99k baseline on a 131072 model. Threshold
    // 98072 < 99073 + 20000 → leaving auto-compact off is correct.
    const d = decideAutoCompactWindow({ contextWindow: 131072, baselineTokens: 99073 })
    expect(d).toEqual({
      inject: false,
      reason: 'baseline-too-high',
      threshold: 131072 - COMPACT_RESERVE_TOKENS,
      baselineTokens: 99073,
    })
  })

  it('skips when the model window is not smaller than Claude default', () => {
    expect(decideAutoCompactWindow({ contextWindow: 200000, baselineTokens: 1000 })).toEqual({
      inject: false,
      reason: 'no-smaller-window',
    })
    expect(decideAutoCompactWindow({ contextWindow: 1_000_000, baselineTokens: 1000 })).toEqual({
      inject: false,
      reason: 'no-smaller-window',
    })
  })

  it('skips when the model has no configured window', () => {
    expect(decideAutoCompactWindow({ baselineTokens: 1000 })).toEqual({
      inject: false,
      reason: 'no-smaller-window',
    })
  })

  it('stays hands-off when there is no observed baseline yet', () => {
    expect(decideAutoCompactWindow({ contextWindow: 131072, baselineTokens: null })).toEqual({
      inject: false,
      reason: 'no-baseline',
    })
  })

  it('uses the headroom boundary exactly', () => {
    // baseline exactly at threshold − headroom → still injects (>= boundary)
    const window = 131072
    const baseline = window - COMPACT_RESERVE_TOKENS - COMPACT_HEADROOM_TOKENS
    expect(decideAutoCompactWindow({ contextWindow: window, baselineTokens: baseline })).toEqual({
      inject: true,
      window,
    })
    // one token over the boundary → skip
    const d = decideAutoCompactWindow({ contextWindow: window, baselineTokens: baseline + 1 })
    expect(d.inject).toBe(false)
  })
})
