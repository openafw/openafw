import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelRegistry } from '../../core/model-registry.ts'
import type { RoutingPolicy } from '../../core/routing-policy.ts'

const reg: { value: ModelRegistry } = {
  value: { version: 3, providers: [], models: [], combos: [] },
}
const policy: { value: RoutingPolicy } = { value: { version: 4, agents: {} } }

vi.mock('../../core/model-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/model-registry.ts')>()
  return { ...actual, readModelRegistry: async () => reg.value }
})
vi.mock('../../core/routing-policy.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/routing-policy.ts')>()
  return { ...actual, readRoutingPolicy: async () => policy.value }
})

const { resolveCodexWireProtocol } = await import('./codex-protocol.ts')

const auth = { kind: 'passthrough' as const }
const chatProvider = {
  id: 'deepseek',
  label: 'DeepSeek',
  baseUrl: 'x',
  api: 'openai-chat' as const,
  auth,
  origin: 'manual' as const,
}
const respProvider = {
  id: 'openai',
  label: 'OpenAI',
  baseUrl: 'x',
  api: 'openai-responses' as const,
  auth,
  origin: 'manual' as const,
}
const model = (id: string, providerId: string) => ({
  id,
  providerId,
  label: id,
  input: ['text' as const],
  origin: 'manual' as const,
})

beforeEach(() => {
  reg.value = {
    version: 3,
    providers: [chatProvider, respProvider],
    models: [model('deepseek-chat', 'deepseek'), model('gpt-5.5', 'openai')],
    combos: [],
  }
  policy.value = { version: 4, agents: {} }
})
afterEach(() => vi.clearAllMocks())

describe('resolveCodexWireProtocol', () => {
  it('defaults to responses with no routing configured', async () => {
    expect(await resolveCodexWireProtocol()).toEqual({
      wireApi: 'responses',
      decoder: 'openai-responses',
    })
  })

  it('matches a chat-completions backend from the --model override', async () => {
    expect(await resolveCodexWireProtocol('deepseek-chat')).toEqual({
      wireApi: 'chat',
      decoder: 'openai-chat',
    })
  })

  it('keeps responses for a responses-backend model override', async () => {
    expect(await resolveCodexWireProtocol('gpt-5.5')).toEqual({
      wireApi: 'responses',
      decoder: 'openai-responses',
    })
  })

  it('follows the type-level codex/* chain target when no model is pinned', async () => {
    policy.value = {
      version: 4,
      agents: { 'codex/*': { target: { kind: 'chain', members: [{ modelId: 'deepseek-chat' }] } } },
    }
    expect(await resolveCodexWireProtocol()).toEqual({ wireApi: 'chat', decoder: 'openai-chat' })
  })

  it('falls back to responses for an unknown model id', async () => {
    expect(await resolveCodexWireProtocol('does-not-exist')).toEqual({
      wireApi: 'responses',
      decoder: 'openai-responses',
    })
  })
})
