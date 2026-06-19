import { describe, expect, it } from 'vitest'
import type { ModelEntry, ProviderEntry } from '../../core/model-registry.ts'
import { authFromRoute, pruneVanishedSeeds } from './seed.ts'

function prov(id: string, origin: 'seeded' | 'manual'): ProviderEntry {
  return {
    id,
    label: id,
    baseUrl: 'https://up.example/v1',
    api: 'openai-chat',
    auth: { kind: 'passthrough' },
    origin,
  }
}

function model(id: string, providerId: string, origin: 'seeded' | 'manual'): ModelEntry {
  return { id, providerId, label: id, input: ['text'], origin }
}

describe('pruneVanishedSeeds', () => {
  it('drops a seeded provider whose route has vanished, with its models', () => {
    const providers = [prov('hermes/groq', 'seeded'), prov('hermes/openai', 'seeded')]
    const models = [
      model('llama', 'hermes/groq', 'seeded'),
      model('gpt-4o', 'hermes/openai', 'seeded'),
    ]
    const out = pruneVanishedSeeds(providers, models, new Set(['hermes/openai']))
    expect(out.pruned).toBe(true)
    expect(out.providers.map((p) => p.id)).toEqual(['hermes/openai'])
    expect(out.models.map((m) => m.id)).toEqual(['gpt-4o'])
  })

  it('leaves manual entries untouched even when not in the desired set', () => {
    const providers = [prov('hermes/groq', 'seeded'), prov('my-custom', 'manual')]
    const models = [
      model('llama', 'hermes/groq', 'seeded'),
      model('my-model', 'my-custom', 'manual'),
    ]
    const out = pruneVanishedSeeds(providers, models, new Set<string>())
    expect(out.pruned).toBe(true)
    expect(out.providers.map((p) => p.id)).toEqual(['my-custom'])
    expect(out.models.map((m) => m.id)).toEqual(['my-model'])
  })

  it('keeps a seeded model on a surviving provider (noteObservedModel)', () => {
    // A model observed in live traffic is seeded but absent from any route's
    // models[]; it must survive as long as its provider's route does — and
    // claude-code is not a harvest-only agent, so no harvestOnlyDesired
    // entry exists for it.
    const providers = [prov('claude-code/anthropic', 'seeded')]
    const models = [model('claude-observed', 'claude-code/anthropic', 'seeded')]
    const out = pruneVanishedSeeds(providers, models, new Set(['claude-code/anthropic']))
    expect(out.pruned).toBe(false)
    expect(out.models.map((m) => m.id)).toEqual(['claude-observed'])
  })

  it('drops a seeded model on a harvest-only provider when it is not in the desired set', () => {
    // openclaw / hermes routes are harvest-only: the route's declared
    // models[] is authoritative, so a stale seeded model (e.g. from the
    // deprecated catalog-flood path) must be pruned out.
    const providers = [prov('openclaw/openai', 'seeded')]
    const models = [
      model('gpt-5.5', 'openclaw/openai', 'seeded'),
      model('gpt-3.5-leftover', 'openclaw/openai', 'seeded'),
    ]
    const out = pruneVanishedSeeds(
      providers,
      models,
      new Set(['openclaw/openai']),
      new Map([['openclaw/openai', new Set(['gpt-5.5'])]]),
    )
    expect(out.pruned).toBe(true)
    expect(out.models.map((m) => m.id)).toEqual(['gpt-5.5'])
  })

  it('keeps a manual model on a harvest-only provider even when absent from desired', () => {
    const providers = [prov('openclaw/openai', 'seeded')]
    const models = [
      model('gpt-5.5', 'openclaw/openai', 'seeded'),
      model('my-pinned', 'openclaw/openai', 'manual'),
    ]
    const out = pruneVanishedSeeds(
      providers,
      models,
      new Set(['openclaw/openai']),
      new Map([['openclaw/openai', new Set(['gpt-5.5'])]]),
    )
    expect(out.pruned).toBe(false)
    expect(out.models.map((m) => m.id).sort()).toEqual(['gpt-5.5', 'my-pinned'])
  })

  it('keeps a seeded model attached to a manual provider', () => {
    const providers = [prov('my-custom', 'manual')]
    const models = [model('observed', 'my-custom', 'seeded')]
    const out = pruneVanishedSeeds(providers, models, new Set<string>())
    expect(out.pruned).toBe(false)
    expect(out.models.map((m) => m.id)).toEqual(['observed'])
  })

  it('reports no change when every seeded provider is still desired', () => {
    const providers = [prov('hermes/openai', 'seeded')]
    const models = [model('gpt-4o', 'hermes/openai', 'seeded')]
    const out = pruneVanishedSeeds(providers, models, new Set(['hermes/openai']))
    expect(out.pruned).toBe(false)
    expect(out.providers).toEqual(providers)
    expect(out.models).toEqual(models)
  })
})

describe('authFromRoute', () => {
  it('derives bearer managed auth with a provider:<routeKey> valueRef', () => {
    expect(authFromRoute('codex/openai', { kind: 'bearer' })).toEqual({
      kind: 'bearer',
      valueRef: 'provider:codex/openai',
    })
  })

  it('derives api-key managed auth carrying the header', () => {
    expect(
      authFromRoute('claude-code/anthropic', { kind: 'api-key', header: 'x-api-key' }),
    ).toEqual({
      kind: 'api-key',
      header: 'x-api-key',
      valueRef: 'provider:claude-code/anthropic',
    })
  })

  it('falls back to passthrough when the route captured no credential', () => {
    expect(authFromRoute('hermes/groq', undefined)).toEqual({ kind: 'passthrough' })
  })
})
