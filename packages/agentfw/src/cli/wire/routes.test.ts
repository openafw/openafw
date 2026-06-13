import { describe, expect, it } from 'vitest'
import { staleRouteKeys } from './routes.ts'

describe('staleRouteKeys', () => {
  it('drops the agent\'s non-desired endpoint keys', () => {
    const existing = ['hermes/groq', 'hermes/openai', 'hermes/auto']
    const desired = new Set(['hermes/groq'])
    expect(staleRouteKeys(existing, 'hermes', desired).sort()).toEqual([
      'hermes/auto',
      'hermes/openai',
    ])
  })

  it('keeps desired keys', () => {
    const existing = ['hermes/groq', 'hermes/openai']
    const desired = new Set(['hermes/groq', 'hermes/openai'])
    expect(staleRouteKeys(existing, 'hermes', desired)).toEqual([])
  })

  it('never prunes /mcp/ keys', () => {
    const existing = ['hermes/groq', 'hermes/mcp/filesystem', 'hermes/mcp/github']
    const desired = new Set(['hermes/groq'])
    expect(staleRouteKeys(existing, 'hermes', desired)).toEqual([])
  })

  it('never prunes another agent\'s keys', () => {
    const existing = ['hermes/openai', 'codex/openai', 'claude-code/anthropic']
    const desired = new Set(['hermes/groq'])
    expect(staleRouteKeys(existing, 'hermes', desired)).toEqual(['hermes/openai'])
  })

  it('respects the agent-prefix boundary', () => {
    // "hermes-gateway/..." must not be treated as agent "hermes".
    const existing = ['hermes-gateway/openai', 'hermes/openai']
    const desired = new Set<string>()
    expect(staleRouteKeys(existing, 'hermes', desired)).toEqual(['hermes/openai'])
  })
})
