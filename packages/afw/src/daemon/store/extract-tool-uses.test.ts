import { describe, expect, it } from 'vitest'
import type { AgentPacket, NormalizedBlock } from '../../core/packet.ts'
import { extractToolUses } from './extract-tool-uses.ts'

function modelPacket(opts: {
  response?: NormalizedBlock[]
  instanceId?: string
  costUsd?: number
}): AgentPacket {
  return {
    id: 'a1' as AgentPacket['id'],
    runId: 'r1' as AgentPacket['runId'],
    threadId: 't1' as AgentPacket['threadId'],
    ts: 100,
    durMs: 0,
    sourceAgent: 'claude-code' as AgentPacket['sourceAgent'],
    ...(opts.instanceId ? { instanceId: opts.instanceId } : {}),
    ...(opts.costUsd != null ? { cost: { usd: opts.costUsd } } : {}),
    payload: {
      kind: 'model_call',
      protocol: 'anthropic',
      endpoint: '/v1/messages',
      model: 'claude-sonnet-4-6',
      messages: [],
      stream: false,
      response: opts.response ?? [],
      status: 200,
    },
  } as AgentPacket
}

const tu = (id: string, name: string, input?: unknown): NormalizedBlock =>
  ({ type: 'tool_use', id, name, input }) as NormalizedBlock

describe('extractToolUses', () => {
  it('classifies builtin / mcp / skill tool_use blocks and carries instance dims', () => {
    const rows = extractToolUses(
      modelPacket({
        instanceId: 'worker-3',
        response: [
          tu('u1', 'Edit', { file_path: '/x' }),
          tu('u2', 'mcp__github__create_issue', { title: 'x' }),
          tu('u3', 'Skill', { skill: 'deep-research', args: '...' }),
        ],
      }),
    )
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => [r.name, r.category, r.detail])).toEqual([
      ['Edit', 'builtin', null],
      ['mcp__github__create_issue', 'mcp', 'github'],
      ['Skill', 'skill', 'deep-research'],
    ])
    for (const r of rows) {
      expect(r.instanceId).toBe('worker-3')
      expect(r.threadId).toBe('t1')
      expect(r.runId).toBe('r1')
      expect(r.agent).toBe('claude-code')
    }
  })

  it('falls back to a defensive skill name and never drops the row', () => {
    const [a] = extractToolUses(
      modelPacket({ response: [tu('u1', 'Skill', { command: 'verify' })] }),
    )
    expect(a).toMatchObject({ category: 'skill', detail: 'verify' })
    const [b] = extractToolUses(modelPacket({ response: [tu('u2', 'Skill', { nope: 1 })] }))
    expect(b).toMatchObject({ category: 'skill', detail: 'unknown' })
  })

  it('splits the model_call cost evenly across tool calls (micro-dollars)', () => {
    const rows = extractToolUses(
      modelPacket({ costUsd: 0.003, response: [tu('u1', 'Read'), tu('u2', 'Bash')] }),
    )
    // 0.003 USD = 3000 micro, / 2 = 1500 each
    expect(rows.map((r) => r.costMicroShare)).toEqual([1500, 1500])
  })

  it('null instanceId when none is set', () => {
    const [r] = extractToolUses(modelPacket({ response: [tu('u1', 'Glob')] }))
    expect(r?.instanceId).toBeNull()
  })

  it('emits nothing for a model_call with no tool_use blocks', () => {
    expect(extractToolUses(modelPacket({ response: [{ type: 'text', text: 'hi' }] }))).toEqual([])
  })

  it('emits one mcp row for an mcp_call response frame, none for the request', () => {
    const base = {
      id: 'm1' as AgentPacket['id'],
      runId: 'r1' as AgentPacket['runId'],
      threadId: 't1' as AgentPacket['threadId'],
      ts: 5,
      durMs: 0,
      sourceAgent: 'claude-desktop' as AgentPacket['sourceAgent'],
      instanceId: 'win-1',
    }
    const req = {
      ...base,
      payload: {
        kind: 'mcp_call',
        protocol: 'mcp',
        server: 'filesystem',
        transport: 'stdio',
        direction: 'request',
        method: 'tools/call',
        jsonrpcId: 7,
      },
    } as AgentPacket
    const res = {
      ...base,
      payload: {
        kind: 'mcp_call',
        protocol: 'mcp',
        server: 'filesystem',
        transport: 'stdio',
        direction: 'response',
        method: 'tools/call',
        jsonrpcId: 7,
      },
    } as AgentPacket
    expect(extractToolUses(req)).toEqual([])
    const rows = extractToolUses(res)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      category: 'mcp',
      detail: 'filesystem',
      name: 'tools/call',
      instanceId: 'win-1',
      isError: 0,
    })
  })
})
