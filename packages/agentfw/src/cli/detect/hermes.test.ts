import { describe, expect, it } from 'vitest'
import { pickActiveEndpoint } from './hermes.ts'
import type { PlannedEndpoint } from './types.ts'

function ep(
  partial: Pick<PlannedEndpoint, 'modelId' | 'configLocation'>,
): PlannedEndpoint {
  return {
    originalBaseUrl: 'https://up.example/v1',
    agentfwBaseUrl: 'http://localhost:9877/wire/hermes/x',
    upstream: 'https://up.example/v1',
    decoder: 'openai-chat',
    filePath: '/cfg/config.yaml',
    ...partial,
  }
}

const base = ep({ modelId: 'agentfw-hermes-default', configLocation: '/model/base_url' })
const groq = ep({ modelId: 'agentfw-hermes-groq', configLocation: '/custom_providers/groq/base_url' })
const oai = ep({ modelId: 'agentfw-hermes-openai', configLocation: '/custom_providers/openai/base_url' })

describe('pickActiveEndpoint', () => {
  it('a named custom provider wins', () => {
    expect(pickActiveEndpoint([base, groq, oai], 'groq')).toBe(groq)
    expect(pickActiveEndpoint([base, groq, oai], 'openai')).toBe(oai)
  })

  it('"auto" falls back to the model.base_url endpoint', () => {
    expect(pickActiveEndpoint([base, groq, oai], 'auto')).toBe(base)
  })

  it('an empty pointer falls back to the model.base_url endpoint', () => {
    expect(pickActiveEndpoint([base, groq, oai], '')).toBe(base)
    expect(pickActiveEndpoint([base, groq, oai], '   ')).toBe(base)
  })

  it('an unmatched pointer falls back to the model.base_url endpoint', () => {
    expect(pickActiveEndpoint([base, groq, oai], 'nonexistent')).toBe(base)
  })

  it('a pointer naming the base_url provider does not match a custom one', () => {
    // model.provider names the /model/base_url endpoint's provider — it is
    // not a custom_providers entry, so it resolves via the base_url fallback.
    const namedBase = ep({ modelId: 'groq', configLocation: '/model/base_url' })
    expect(pickActiveEndpoint([namedBase, oai], 'groq')).toBe(namedBase)
  })

  it('with no base_url endpoint, an unmatched pointer takes the first', () => {
    expect(pickActiveEndpoint([groq, oai], 'nonexistent')).toBe(groq)
  })

  it('returns undefined for no endpoints', () => {
    expect(pickActiveEndpoint([], 'groq')).toBeUndefined()
  })
})
