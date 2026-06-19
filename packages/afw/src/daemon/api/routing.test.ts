import { describe, expect, it } from 'vitest'
import { bareAgentOf, modelsUrl, parseModelList, rootModelsUrlFallback } from './routing.ts'

describe('bareAgentOf', () => {
  it('strips the model segment', () => {
    expect(bareAgentOf('hermes/*')).toBe('hermes')
    expect(bareAgentOf('claude-code/claude-opus-4-7')).toBe('claude-code')
  })

  it('strips an instance suffix', () => {
    expect(bareAgentOf('hermes@worker-3/*')).toBe('hermes')
  })

  it('handles an MCP route key', () => {
    expect(bareAgentOf('openclaw/mcp/github')).toBe('openclaw')
  })

  it('returns the whole key when there is no slash', () => {
    expect(bareAgentOf('hermes')).toBe('hermes')
  })
})

describe('parseModelList', () => {
  it('parses an OpenAI {data:[{id}]} response', () => {
    const out = parseModelList({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })
    expect(out).toEqual([{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }])
  })

  it('parses an Anthropic {data:[{id,display_name}]} response', () => {
    const out = parseModelList({
      data: [{ id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' }],
    })
    expect(out).toEqual([{ id: 'claude-opus-4-7', label: 'Claude Opus 4.7' }])
  })

  it('parses a bare array of objects', () => {
    expect(parseModelList([{ id: 'a' }, { id: 'b' }])).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('parses a bare array of strings', () => {
    expect(parseModelList(['a', 'b'])).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('parses a {models:[…]} envelope', () => {
    expect(parseModelList({ models: [{ id: 'x' }] })).toEqual([{ id: 'x' }])
  })

  it('falls back to name for id and label for the display label', () => {
    expect(parseModelList([{ name: 'm1', label: 'Model One' }])).toEqual([
      { id: 'm1', label: 'Model One' },
    ])
  })

  it('drops idless entries and de-dupes', () => {
    const out = parseModelList({
      data: [{ id: 'a' }, {}, { id: '' }, { id: 'a' }, { id: 'b' }],
    })
    expect(out).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('returns an empty list for malformed input', () => {
    expect(parseModelList(null)).toEqual([])
    expect(parseModelList(42)).toEqual([])
    expect(parseModelList({})).toEqual([])
    expect(parseModelList({ data: 'not-an-array' })).toEqual([])
  })
})

describe('modelsUrl', () => {
  it('appends /v1/models to a bare base', () => {
    expect(modelsUrl('https://api.example.com')).toBe('https://api.example.com/v1/models')
  })

  it('does not double an existing /v1 suffix', () => {
    expect(modelsUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/models')
  })

  it('strips trailing slashes', () => {
    expect(modelsUrl('https://api.example.com/')).toBe('https://api.example.com/v1/models')
    expect(modelsUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/models')
  })
})

describe('rootModelsUrlFallback', () => {
  it('returns the origin /v1/models when the baseUrl carries a protocol-prefix path', () => {
    // DeepSeek-style: inference at /anthropic/v1/messages, but the
    // models listing only exists at the root /v1/models.
    expect(rootModelsUrlFallback('https://api.deepseek.com/anthropic')).toBe(
      'https://api.deepseek.com/v1/models',
    )
    expect(rootModelsUrlFallback('https://api.deepseek.com/anthropic/')).toBe(
      'https://api.deepseek.com/v1/models',
    )
  })

  it('returns undefined when the baseUrl is already at root or /v1', () => {
    expect(rootModelsUrlFallback('https://api.example.com')).toBeUndefined()
    expect(rootModelsUrlFallback('https://api.example.com/')).toBeUndefined()
    expect(rootModelsUrlFallback('https://api.example.com/v1')).toBeUndefined()
    expect(rootModelsUrlFallback('https://api.example.com/v1/')).toBeUndefined()
  })

  it('returns undefined for an unparseable URL', () => {
    expect(rootModelsUrlFallback('not a url')).toBeUndefined()
  })
})
