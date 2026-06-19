import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelRegistry } from '../../core/model-registry.ts'
import type { RoutingPolicy } from '../../core/routing-policy.ts'

const mockState = vi.hoisted(() => ({
  policy: { version: 4, agents: {} } as RoutingPolicy,
  registry: { version: 3, providers: [], models: [], combos: [] } as ModelRegistry,
}))

vi.mock('../routing/load.ts', () => ({
  getRoutingPolicy: () => mockState.policy,
  getModelRegistry: () => mockState.registry,
  getSecrets: () => ({ version: 1, secrets: {} }),
}))

const { resolveRoute, resolveRouteFrom } = await import('./resolve.ts')

const REGISTRY: ModelRegistry = {
  version: 3,
  combos: [
    {
      id: 'combo-panel',
      label: 'panel',
      panel: [
        {
          modelId: 'gpt-x',
          switchOn: [{ kind: 'error' }],
          fallback: { modelId: 'claude-x' },
        },
        { modelId: 'claude-x' },
      ],
      judge: { modelId: 'claude-x' },
      synthesizer: { modelId: 'gpt-x' },
      origin: 'manual',
    },
    {
      id: 'combo-vision',
      label: 'panel + vision companion',
      panel: [{ modelId: 'claude-x' }],
      vision: { modelId: 'vision-x', providerId: 'p-oai' },
      origin: 'manual',
    },
  ],
  providers: [
    {
      id: 'p-oai',
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-chat',
      auth: { kind: 'passthrough' },
      origin: 'manual',
    },
    {
      id: 'p-ant',
      label: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      api: 'anthropic-messages',
      auth: { kind: 'passthrough' },
      origin: 'manual',
    },
  ],
  models: [
    { id: 'gpt-x', providerId: 'p-oai', label: 'gpt-x', input: ['text'], origin: 'manual' },
    {
      id: 'claude-x',
      providerId: 'p-ant',
      label: 'claude-x',
      input: ['text'],
      origin: 'manual',
    },
    {
      id: 'vision-x',
      providerId: 'p-oai',
      label: 'vision-x',
      input: ['text', 'image'],
      origin: 'manual',
    },
  ],
}

beforeEach(() => {
  mockState.policy = { version: 4, agents: {} }
  mockState.registry = REGISTRY
})

describe('resolveRoute', () => {
  it('passes through when no routing is configured', () => {
    expect(resolveRoute('agent/openai', 'openai-chat')).toEqual({ kind: 'passthrough' })
  })

  it('passes through an explicit passthrough target', () => {
    mockState.policy.agents = { 'agent/openai': { target: { kind: 'passthrough' } } }
    expect(resolveRoute('agent/openai', 'openai-chat')).toEqual({ kind: 'passthrough' })
  })

  it('resolves a multi-member chain target into ordered members', () => {
    mockState.policy.agents = {
      'agent/openai': {
        target: {
          kind: 'chain',
          members: [{ modelId: 'gpt-x', switchOn: [{ kind: 'error' }] }, { modelId: 'claude-x' }],
        },
      },
    }
    const resolved = resolveRoute('agent/openai', 'openai-chat')
    expect(resolved.kind).toBe('chain')
    if (resolved.kind !== 'chain') return
    expect(resolved.clientApi).toBe('openai-chat')
    expect(resolved.members).toHaveLength(2)
    expect(resolved.members[0]?.model.id).toBe('gpt-x')
    expect(resolved.members[0]?.api).toBe('openai-chat')
    expect(resolved.members[0]?.switchOn).toEqual([{ kind: 'error' }])
    expect(resolved.members[1]?.model.id).toBe('claude-x')
    expect(resolved.members[1]?.switchOn).toEqual([])
    expect(resolved.configuredTarget).toEqual({ kind: 'chain', id: 'gpt-x' })
  })

  it('resolves a token-quota switch rule on a chain member', () => {
    mockState.policy.agents = {
      'agent/openai': {
        target: {
          kind: 'chain',
          members: [
            {
              modelId: 'gpt-x',
              switchOn: [{ kind: 'tokens', tokenLimit: 50000, period: 'day' }],
            },
            { modelId: 'claude-x' },
          ],
        },
      },
    }
    const resolved = resolveRoute('agent/openai', 'openai-chat')
    expect(resolved.kind).toBe('chain')
    if (resolved.kind !== 'chain') return
    expect(resolved.members[0]?.switchOn).toEqual([
      { kind: 'tokens', tokenLimit: 50000, period: 'day' },
    ])
  })

  it('resolves a per-route vision capability companion', () => {
    mockState.policy.agents = {
      'agent/openai': {
        target: {
          kind: 'chain',
          members: [{ modelId: 'gpt-x' }, { modelId: 'claude-x' }],
        },
        capabilities: {
          vision: { via: 'companion', modelId: 'vision-x', providerId: 'p-oai' },
        },
      },
    }
    const resolved = resolveRoute('agent/openai', 'openai-chat')
    expect(resolved.kind).toBe('chain')
    if (resolved.kind !== 'chain') return
    const vision = resolved.capabilities.vision
    expect(vision?.via).toBe('companion')
    if (vision?.via !== 'companion') return
    expect(vision.ref.model.id).toBe('vision-x')
  })

  it('drops an unresolvable chain member but keeps the rest', () => {
    mockState.policy.agents = {
      'agent/openai': {
        target: {
          kind: 'chain',
          members: [{ modelId: 'nope' }, { modelId: 'gpt-x' }],
        },
      },
    }
    const resolved = resolveRoute('agent/openai', 'openai-chat')
    // Now a 1-member chain → resolves down to the model fast path.
    expect(resolved.kind).toBe('model')
    if (resolved.kind !== 'model') return
    expect(resolved.model.id).toBe('gpt-x')
  })

  it('passes through a chain with no resolvable members', () => {
    mockState.policy.agents = {
      'agent/openai': {
        target: { kind: 'chain', members: [{ modelId: 'nope' }] },
      },
    }
    expect(resolveRoute('agent/openai', 'openai-chat')).toEqual({ kind: 'passthrough' })
  })

  it('passes through a non-translatable client decoder', () => {
    mockState.policy.agents = {
      'agent/gemini': { target: { kind: 'chain', members: [{ modelId: 'gpt-x' }] } },
    }
    expect(resolveRoute('agent/gemini', 'gemini')).toEqual({ kind: 'passthrough' })
  })

  it('passes through an unknown model', () => {
    mockState.policy.agents = {
      'agent/openai': { target: { kind: 'chain', members: [{ modelId: 'nope' }] } },
    }
    expect(resolveRoute('agent/openai', 'openai-chat')).toEqual({ kind: 'passthrough' })
  })

  it('collapses a 1-member chain into the same-protocol model fast path', () => {
    mockState.policy.agents = {
      'agent/openai': { target: { kind: 'chain', members: [{ modelId: 'gpt-x' }] } },
    }
    const resolved = resolveRoute('agent/openai', 'openai-chat')
    expect(resolved.kind).toBe('model')
    if (resolved.kind !== 'model') return
    expect(resolved.clientApi).toBe('openai-chat')
    expect(resolved.api).toBe('openai-chat')
    expect(resolved.model.id).toBe('gpt-x')
    expect(resolved.provider.id).toBe('p-oai')
    expect(resolved.configuredTarget).toEqual({ kind: 'model', id: 'gpt-x' })
  })

  it('resolves model reasoning effort overrides over provider defaults', () => {
    mockState.registry = {
      ...REGISTRY,
      providers: REGISTRY.providers.map((p) =>
        p.id === 'p-oai' ? { ...p, reasoningEffort: 'high' } : p,
      ),
      models: REGISTRY.models.map((m) =>
        m.id === 'gpt-x' ? { ...m, reasoningEffort: 'xhigh' } : m,
      ),
    }
    mockState.policy.agents = {
      'agent/openai': { target: { kind: 'chain', members: [{ modelId: 'gpt-x' }] } },
    }

    const resolved = resolveRoute('agent/openai', 'openai-chat')

    expect(resolved.kind).toBe('model')
    if (resolved.kind !== 'model') return
    expect(resolved.reasoningEffort).toBe('xhigh')
  })

  it('resolves a cross-protocol model swap (1-member chain)', () => {
    mockState.policy.agents = {
      'agent/anthropic': { target: { kind: 'chain', members: [{ modelId: 'gpt-x' }] } },
    }
    const resolved = resolveRoute('agent/anthropic', 'anthropic')
    expect(resolved.kind).toBe('model')
    if (resolved.kind !== 'model') return
    expect(resolved.clientApi).toBe('anthropic-messages')
    expect(resolved.api).toBe('openai-chat')
    expect(resolved.model.id).toBe('gpt-x')
    expect(resolved.provider.id).toBe('p-oai')
    expect(resolved.configuredTarget).toEqual({ kind: 'model', id: 'gpt-x' })
  })

  it('dereferences a composite target into a fusion route with per-slot failover', () => {
    mockState.policy.agents = {
      'agent/openai': { target: { kind: 'composite', comboId: 'combo-panel' } },
    }
    const resolved = resolveRoute('agent/openai', 'openai-chat')
    expect(resolved.kind).toBe('fusion')
    if (resolved.kind !== 'fusion') return
    // Two panel slots; the first is a primary→fallback failover chain.
    expect(resolved.panel.map((p) => p.members.map((m) => m.model.id))).toEqual([
      ['gpt-x', 'claude-x'],
      ['claude-x'],
    ])
    expect(resolved.panel[0]?.members[0]?.switchOn).toEqual([{ kind: 'error' }])
    expect(resolved.judge.model.id).toBe('claude-x')
    expect(resolved.synthesizer.model.id).toBe('gpt-x')
    expect(resolved.configuredTarget).toEqual({ kind: 'combo', id: 'combo-panel' })
  })

  it('resolves the combo-level vision companion, defaulting judge + synthesizer to the panel', () => {
    mockState.policy.agents = {
      'agent/anthropic': { target: { kind: 'composite', comboId: 'combo-vision' } },
    }
    const resolved = resolveRoute('agent/anthropic', 'anthropic')
    expect(resolved.kind).toBe('fusion')
    if (resolved.kind !== 'fusion') return
    expect(resolved.panel[0]?.members[0]?.model.id).toBe('claude-x')
    expect(resolved.vision?.model.id).toBe('vision-x')
    // No judge/synthesizer configured → both default to the first panel member.
    expect(resolved.judge.model.id).toBe('claude-x')
    expect(resolved.synthesizer.model.id).toBe('claude-x')
  })

  it('drops an unresolvable fusion panel slot but keeps the rest', () => {
    mockState.registry = {
      ...REGISTRY,
      combos: [
        {
          id: 'combo-partial',
          label: 'partial',
          panel: [{ modelId: 'nope' }, { modelId: 'gpt-x' }],
          origin: 'manual',
        },
      ],
    }
    mockState.policy.agents = {
      'agent/openai': { target: { kind: 'composite', comboId: 'combo-partial' } },
    }
    const resolved = resolveRoute('agent/openai', 'openai-chat')
    expect(resolved.kind).toBe('fusion')
    if (resolved.kind !== 'fusion') return
    expect(resolved.panel.map((p) => p.members[0]?.model.id)).toEqual(['gpt-x'])
  })

  it('a composite route ignores the route-level capabilities (combo is source of truth)', () => {
    mockState.policy.agents = {
      'agent/openai': {
        target: { kind: 'composite', comboId: 'combo-panel' },
        capabilities: { vision: { via: 'companion', modelId: 'vision-x', providerId: 'p-oai' } },
      },
    }
    const resolved = resolveRoute('agent/openai', 'openai-chat')
    expect(resolved.kind).toBe('fusion')
  })

  it('resolves a combo cheapModel into the fusion route', () => {
    mockState.registry = {
      ...REGISTRY,
      combos: [
        {
          id: 'combo-cheap',
          label: 'with cheap model',
          panel: [{ modelId: 'gpt-x' }],
          cheapModel: { modelId: 'claude-x', providerId: 'p-ant' },
          origin: 'manual',
        },
      ],
    }
    mockState.policy.agents = {
      'agent/openai': { target: { kind: 'composite', comboId: 'combo-cheap' } },
    }
    const resolved = resolveRoute('agent/openai', 'openai-chat')
    expect(resolved.kind).toBe('fusion')
    if (resolved.kind !== 'fusion') return
    expect(resolved.cheapModel?.model.id).toBe('claude-x')
    expect(resolved.cheapModel?.api).toBe('anthropic-messages')
  })

  it('drops an unresolvable cheapModel without failing the fusion route', () => {
    mockState.registry = {
      ...REGISTRY,
      combos: [
        {
          id: 'combo-cheap',
          label: 'bad cheap model',
          panel: [{ modelId: 'gpt-x' }],
          cheapModel: { modelId: 'ghost' },
          origin: 'manual',
        },
      ],
    }
    mockState.policy.agents = {
      'agent/openai': { target: { kind: 'composite', comboId: 'combo-cheap' } },
    }
    const resolved = resolveRoute('agent/openai', 'openai-chat')
    expect(resolved.kind).toBe('fusion')
    if (resolved.kind !== 'fusion') return
    expect(resolved.cheapModel).toBeUndefined()
  })

  it('passes through an unknown composite combo id', () => {
    mockState.policy.agents = {
      'agent/openai': { target: { kind: 'composite', comboId: 'nope' } },
    }
    expect(resolveRoute('agent/openai', 'openai-chat')).toEqual({ kind: 'passthrough' })
  })

  it('honors a per-source-model entry over the agent wildcard', () => {
    mockState.policy.agents = {
      'claude-code/*': {
        target: { kind: 'chain', members: [{ modelId: 'gpt-x' }] },
      },
      'claude-code/claude-x': { target: { kind: 'passthrough' } },
    }
    expect(resolveRoute('claude-code/claude-x', 'anthropic')).toEqual({
      kind: 'passthrough',
    })
    const fallback = resolveRoute('claude-code/claude-haiku', 'anthropic')
    expect(fallback.kind).toBe('model')
    if (fallback.kind !== 'model') return
    expect(fallback.model.id).toBe('gpt-x')
  })
})

describe('resolveRouteFrom (explicit routing — afw API keys)', () => {
  it('resolves a single-model chain the same as a policy route', () => {
    const fromKey = resolveRouteFrom(
      { target: { kind: 'chain', members: [{ modelId: 'gpt-x' }] } },
      'openai-chat',
      'byok/default',
    )
    mockState.policy.agents = {
      'agent/openai': { target: { kind: 'chain', members: [{ modelId: 'gpt-x' }] } },
    }
    const fromPolicy = resolveRoute('agent/openai', 'openai-chat')
    expect(fromKey).toEqual(fromPolicy)
    expect(fromKey.kind).toBe('model')
  })

  it('resolves a token-fallback chain into ordered members with switch rules', () => {
    const resolved = resolveRouteFrom(
      {
        target: {
          kind: 'chain',
          members: [
            {
              modelId: 'gpt-x',
              switchOn: [{ kind: 'tokens', tokenLimit: 1000, period: 'month' }, { kind: 'error' }],
            },
            { modelId: 'claude-x' },
          ],
        },
      },
      'openai-chat',
      'byok/fb',
    )
    expect(resolved.kind).toBe('chain')
    if (resolved.kind !== 'chain') return
    expect(resolved.members.map((m) => m.model.id)).toEqual(['gpt-x', 'claude-x'])
    expect(resolved.members[0]?.switchOn).toEqual([
      { kind: 'tokens', tokenLimit: 1000, period: 'month' },
      { kind: 'error' },
    ])
  })

  it('resolves a composite target into a fusion', () => {
    const resolved = resolveRouteFrom(
      { target: { kind: 'composite', comboId: 'combo-panel' } },
      'openai-chat',
      'byok/fusion',
    )
    expect(resolved.kind).toBe('fusion')
  })

  it('passes through an unknown combo', () => {
    const resolved = resolveRouteFrom(
      { target: { kind: 'composite', comboId: 'nope' } },
      'openai-chat',
    )
    expect(resolved).toEqual({ kind: 'passthrough' })
  })
})
