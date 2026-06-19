import { describe, expect, it } from 'vitest'
import {
  type RoutingPolicy,
  normalizeRoutingPolicy,
  policyKeyFor,
  routingFor,
} from './routing-policy.ts'

describe('normalizeRoutingPolicy', () => {
  it('round-trips a valid v4 policy', () => {
    const policy = {
      version: 4 as const,
      agents: {
        'openclaw/anthropic': {
          target: {
            kind: 'chain' as const,
            members: [
              {
                modelId: 'gpt-5.5',
                switchOn: [{ kind: 'budget' as const, usdLimit: 100, period: 'month' as const }],
              },
              { modelId: 'xiangxin' },
            ],
          },
          capabilities: {
            vision: { via: 'companion' as const, modelId: 'vision-mini' },
          },
        },
      },
    }
    expect(normalizeRoutingPolicy(policy)).toEqual(policy)
  })

  it('normalizes a composite target', () => {
    const out = normalizeRoutingPolicy({
      version: 4,
      agents: {
        'openclaw/*': { target: { kind: 'composite', comboId: 'my-combo' } },
        'openclaw/bad': { target: { kind: 'composite', comboId: '' } }, // empty → passthrough
      },
    })
    expect(out.agents['openclaw/*']?.target).toEqual({ kind: 'composite', comboId: 'my-combo' })
    expect(out.agents['openclaw/bad']?.target).toEqual({ kind: 'passthrough' })
  })

  it('migrates a v3 policy forward to v4 (no structural change)', () => {
    const out = normalizeRoutingPolicy({
      version: 3,
      agents: { 'openclaw/*': { target: { kind: 'chain', members: [{ modelId: 'm' }] } } },
    })
    expect(out.version).toBe(4)
    expect(out.agents['openclaw/*']?.target).toEqual({ kind: 'chain', members: [{ modelId: 'm' }] })
  })

  it('returns an empty policy for non-object input', () => {
    expect(normalizeRoutingPolicy(null).agents).toEqual({})
  })

  it('throws on an unsupported version', () => {
    expect(() => normalizeRoutingPolicy({ version: 9, agents: {} })).toThrow()
  })

  it('drops a chain with no valid members → passthrough', () => {
    const p = normalizeRoutingPolicy({
      version: 3,
      agents: {
        'a/b': {
          target: { kind: 'chain', members: [{ modelId: '' }] },
        },
      },
    })
    expect(p.agents['a/b']?.target).toEqual({ kind: 'passthrough' })
  })

  it('coerces an unknown target kind to passthrough', () => {
    const p = normalizeRoutingPolicy({
      version: 3,
      agents: { 'a/b': { target: { kind: 'bogus' } } },
    })
    expect(p.agents['a/b']?.target).toEqual({ kind: 'passthrough' })
  })

  it('drops a budget rule with a bad period', () => {
    const p = normalizeRoutingPolicy({
      version: 3,
      agents: {
        'a/b': {
          target: {
            kind: 'chain',
            members: [
              { modelId: 'm', switchOn: [{ kind: 'budget', usdLimit: 5, period: 'year' }] },
            ],
          },
        },
      },
    })
    const target = p.agents['a/b']?.target
    expect(target?.kind).toBe('chain')
    if (target?.kind === 'chain') {
      expect(target.members[0]?.switchOn).toBeUndefined()
    }
  })

  it('accepts a token-quota switch rule', () => {
    const p = normalizeRoutingPolicy({
      version: 3,
      agents: {
        'a/b': {
          target: {
            kind: 'chain',
            members: [
              {
                modelId: 'm',
                switchOn: [{ kind: 'tokens', tokenLimit: 100000, period: 'day' }],
              },
              { modelId: 'fallback' },
            ],
          },
        },
      },
    })
    const target = p.agents['a/b']?.target
    if (target?.kind === 'chain') {
      expect(target.members[0]?.switchOn).toEqual([
        { kind: 'tokens', tokenLimit: 100000, period: 'day' },
      ])
    }
  })

  function chainWithSwitch(switchOn: unknown): unknown {
    return {
      version: 4,
      agents: {
        'a/b': {
          target: {
            kind: 'chain',
            members: [{ modelId: 'm', switchOn }, { modelId: 'fallback' }],
          },
        },
      },
    }
  }

  function firstSwitchOn(p: ReturnType<typeof normalizeRoutingPolicy>): unknown {
    const target = p.agents['a/b']?.target
    return target?.kind === 'chain' ? target.members[0]?.switchOn : undefined
  }

  it('accepts a rolling-window token-quota rule (the 5h subscription window)', () => {
    const p = normalizeRoutingPolicy(
      chainWithSwitch([{ kind: 'tokens', tokenLimit: 100000, period: { rollingHours: 5 } }]),
    )
    expect(firstSwitchOn(p)).toEqual([
      { kind: 'tokens', tokenLimit: 100000, period: { rollingHours: 5 } },
    ])
  })

  it('drops a rolling window with a non-positive hour span', () => {
    const p = normalizeRoutingPolicy(
      chainWithSwitch([{ kind: 'tokens', tokenLimit: 1, period: { rollingHours: 0 } }]),
    )
    expect(firstSwitchOn(p)).toBeUndefined()
  })

  it('accepts a quota-pct rule for subscription upstreams', () => {
    const p = normalizeRoutingPolicy(chainWithSwitch([{ kind: 'quota-pct', usedPct: 80 }]))
    expect(firstSwitchOn(p)).toEqual([{ kind: 'quota-pct', usedPct: 80 }])
  })

  it('drops a quota-pct rule outside 0–100', () => {
    expect(
      firstSwitchOn(normalizeRoutingPolicy(chainWithSwitch([{ kind: 'quota-pct', usedPct: 120 }]))),
    ).toBeUndefined()
    expect(
      firstSwitchOn(normalizeRoutingPolicy(chainWithSwitch([{ kind: 'quota-pct', usedPct: -1 }]))),
    ).toBeUndefined()
  })
})

describe('v1 → v3 migration', () => {
  it('renames combos + comboId targets and inlines members', () => {
    const p = normalizeRoutingPolicy({
      version: 1,
      combos: [{ id: 'c1', label: 'C', members: [{ modelId: 'm' }] }],
      agents: { 'a/b': { target: { kind: 'combo', comboId: 'c1' } } },
    })
    expect(p.version).toBe(4)
    expect(p.agents['a/b']?.target).toEqual({
      kind: 'chain',
      members: [{ modelId: 'm' }],
    })
  })

  it('folds a v1 visionCompanionModelId into a per-route capability', () => {
    const p = normalizeRoutingPolicy({
      version: 1,
      combos: [],
      agents: {
        'openclaw/anthropic': {
          target: { kind: 'model', modelId: 'gpt-5.5' },
          visionCompanionModelId: 'vision-mini',
        },
      },
    })
    const entry = p.agents['openclaw/anthropic']
    expect(entry?.target).toEqual({
      kind: 'chain',
      members: [{ modelId: 'gpt-5.5' }],
    })
    expect(entry?.capabilities?.vision).toEqual({
      via: 'companion',
      modelId: 'vision-mini',
    })
  })

  it('promotes a plain v1 single-model target to a 1-member chain', () => {
    const p = normalizeRoutingPolicy({
      version: 1,
      combos: [],
      agents: { 'a/b': { target: { kind: 'model', modelId: 'm' } } },
    })
    expect(p.agents['a/b']?.target).toEqual({
      kind: 'chain',
      members: [{ modelId: 'm' }],
    })
  })

  it('preserves the stream-translation flag', () => {
    const p = normalizeRoutingPolicy({
      version: 1,
      combos: [],
      agents: {},
      streamTranslation: false,
    })
    expect(p.streamTranslation).toBe(false)
  })
})

describe('v2 → v3 migration', () => {
  it('inlines a strategy reference as chain members', () => {
    const p = normalizeRoutingPolicy({
      version: 2,
      strategies: [
        {
          id: 's1',
          label: 'cheap-with-failover',
          members: [
            {
              modelId: 'glm-4.6',
              switchOn: [{ kind: 'error' }],
            },
            { modelId: 'deepseek-v4' },
          ],
        },
      ],
      agents: { 'a/b': { target: { kind: 'strategy', strategyId: 's1' } } },
    })
    expect(p.version).toBe(4)
    expect(p.agents['a/b']?.target).toEqual({
      kind: 'chain',
      members: [{ modelId: 'glm-4.6', switchOn: [{ kind: 'error' }] }, { modelId: 'deepseek-v4' }],
    })
  })

  it('lifts a strategy.toolModels.vision into a per-route capability', () => {
    const p = normalizeRoutingPolicy({
      version: 2,
      strategies: [
        {
          id: 's',
          label: 'S',
          members: [{ modelId: 'text-only' }],
          toolModels: [{ kind: 'vision', modelId: 'vision-mini' }],
        },
      ],
      agents: { 'a/b': { target: { kind: 'strategy', strategyId: 's' } } },
    })
    expect(p.agents['a/b']?.target).toEqual({
      kind: 'chain',
      members: [{ modelId: 'text-only' }],
    })
    expect(p.agents['a/b']?.capabilities?.vision).toEqual({
      via: 'companion',
      modelId: 'vision-mini',
    })
  })

  it('keeps an existing per-route vision capability over the legacy one', () => {
    const p = normalizeRoutingPolicy({
      version: 2,
      strategies: [
        {
          id: 's',
          label: 'S',
          members: [{ modelId: 'text-only' }],
          toolModels: [{ kind: 'vision', modelId: 'legacy-vision' }],
        },
      ],
      agents: {
        'a/b': {
          target: { kind: 'strategy', strategyId: 's' },
          capabilities: {
            vision: { via: 'companion', modelId: 'explicit-vision' },
          },
        },
      },
    })
    expect(p.agents['a/b']?.capabilities?.vision).toEqual({
      via: 'companion',
      modelId: 'explicit-vision',
    })
  })

  it('promotes a v2 single-model target to a 1-member chain', () => {
    const p = normalizeRoutingPolicy({
      version: 2,
      strategies: [],
      agents: {
        'a/b': { target: { kind: 'model', modelId: 'm', providerId: 'p' } },
      },
    })
    expect(p.agents['a/b']?.target).toEqual({
      kind: 'chain',
      members: [{ modelId: 'm', providerId: 'p' }],
    })
  })

  it('falls a dangling strategy ref back to passthrough', () => {
    const p = normalizeRoutingPolicy({
      version: 2,
      strategies: [],
      agents: { 'a/b': { target: { kind: 'strategy', strategyId: 'gone' } } },
    })
    expect(p.agents['a/b']?.target).toEqual({ kind: 'passthrough' })
  })
})

describe('policy helpers', () => {
  const policy: RoutingPolicy = {
    version: 4,
    agents: {
      'a/b': {
        target: { kind: 'chain', members: [{ modelId: 'm' }] },
      },
    },
  }

  it('defaults an unconfigured route to passthrough', () => {
    expect(routingFor(policy, 'x/y').target).toEqual({ kind: 'passthrough' })
    expect(routingFor(policy, 'a/b').target).toEqual({
      kind: 'chain',
      members: [{ modelId: 'm' }],
    })
  })

  it('normalizes per-route capabilities (companion + local)', () => {
    const out = normalizeRoutingPolicy({
      version: 3,
      agents: {
        'claude-code/*': {
          target: { kind: 'passthrough' },
          capabilities: {
            vision: { via: 'companion', modelId: 'gpt-5-vision', providerId: 'p-openai' },
            web_search: { via: 'local' },
            // unknown kind — dropped silently by the normalizer
            never: { via: 'companion', modelId: 'x' },
          },
        },
      },
    })
    const caps = out.agents['claude-code/*']?.capabilities
    expect(caps).toEqual({
      vision: { via: 'companion', modelId: 'gpt-5-vision', providerId: 'p-openai' },
      web_search: { via: 'local' },
    })
  })

  it('drops invalid capability shapes', () => {
    const out = normalizeRoutingPolicy({
      version: 3,
      agents: {
        'a/*': {
          target: { kind: 'passthrough' },
          capabilities: {
            vision: { via: 'companion' }, // missing modelId
            web_search: { via: 'mystery' }, // unknown via
          },
        },
      },
    })
    expect(out.agents['a/*']?.capabilities).toBeUndefined()
  })

  it('falls back from an exact-match miss to the agent wildcard', () => {
    const p: RoutingPolicy = {
      version: 4,
      agents: {
        'claude-code/*': {
          target: { kind: 'chain', members: [{ modelId: 'glm-4.6' }] },
        },
        'claude-code/claude-opus-4-7': { target: { kind: 'passthrough' } },
      },
    }
    expect(routingFor(p, 'claude-code/claude-sonnet-4-6').target).toEqual({
      kind: 'chain',
      members: [{ modelId: 'glm-4.6' }],
    })
    expect(routingFor(p, 'claude-code/claude-opus-4-7').target).toEqual({
      kind: 'passthrough',
    })
    expect(routingFor(p, 'claude-code/*').target).toEqual({
      kind: 'chain',
      members: [{ modelId: 'glm-4.6' }],
    })
    expect(routingFor(p, 'codex/gpt-5').target).toEqual({ kind: 'passthrough' })
  })
})

describe('per-instance policy keys', () => {
  it('policyKeyFor builds bare and instance-scoped keys', () => {
    expect(policyKeyFor('claude-code', 'claude-opus-4-8')).toBe('claude-code/claude-opus-4-8')
    expect(policyKeyFor('claude-code', '')).toBe('claude-code/*')
    expect(policyKeyFor('claude-code', 'claude-opus-4-8', 'worker-3')).toBe(
      'claude-code@worker-3/claude-opus-4-8',
    )
    expect(policyKeyFor('claude-code', '', 'worker-3')).toBe('claude-code@worker-3/*')
  })

  it('resolves most-specific instance key first, then falls through to type', () => {
    const p: RoutingPolicy = {
      version: 4,
      agents: {
        'claude-code/*': { target: { kind: 'chain', members: [{ modelId: 'glm-4.6' }] } },
        'claude-code@worker/*': {
          target: { kind: 'chain', members: [{ modelId: 'claude-sonnet-4-6' }] },
        },
        'claude-code@worker/claude-opus-4-8': { target: { kind: 'passthrough' } },
      },
    }
    // 1. exact instance + model
    expect(routingFor(p, 'claude-code@worker/claude-opus-4-8').target).toEqual({
      kind: 'passthrough',
    })
    // 2. instance wildcard (model has no exact instance entry)
    expect(routingFor(p, 'claude-code@worker/claude-haiku-4-5').target).toEqual({
      kind: 'chain',
      members: [{ modelId: 'claude-sonnet-4-6' }],
    })
    // 3/4. an unknown instance falls through to the type-level default
    expect(routingFor(p, 'claude-code@other/claude-opus-4-8').target).toEqual({
      kind: 'chain',
      members: [{ modelId: 'glm-4.6' }],
    })
  })

  it('an explicit instance passthrough shadows a type-level model override (monitor-only)', () => {
    const p: RoutingPolicy = {
      version: 4,
      agents: {
        // type default downgrades everything…
        'claude-code/*': { target: { kind: 'chain', members: [{ modelId: 'claude-sonnet-4-6' }] } },
        // …but this instance is monitor-only and must stay untouched.
        'claude-code@audit/*': { target: { kind: 'passthrough' } },
      },
    }
    expect(routingFor(p, 'claude-code@audit/claude-opus-4-8').target).toEqual({
      kind: 'passthrough',
    })
    // a different instance still inherits the type-level downgrade
    expect(routingFor(p, 'claude-code@worker/claude-opus-4-8').target).toEqual({
      kind: 'chain',
      members: [{ modelId: 'claude-sonnet-4-6' }],
    })
  })

  it('a bare type key behaves exactly as before (no instance segment)', () => {
    const p: RoutingPolicy = {
      version: 4,
      agents: { 'claude-code/*': { target: { kind: 'chain', members: [{ modelId: 'm' }] } } },
    }
    expect(routingFor(p, 'claude-code/anything').target).toEqual({
      kind: 'chain',
      members: [{ modelId: 'm' }],
    })
  })
})
