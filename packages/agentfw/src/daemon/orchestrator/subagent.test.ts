import { describe, expect, it } from 'vitest'
import { classifyClaudeCodeRole } from './subagent.ts'

function body(obj: unknown): ArrayBuffer {
  const u = new TextEncoder().encode(JSON.stringify(obj))
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)
}

const FLOOR = 8000

describe('classifyClaudeCodeRole', () => {
  // The safety-critical property: a call carrying any orchestrator-only tool
  // is the planner and must never be classified as a downgradable subagent.
  it.each(['Agent', 'AskUserQuestion', 'ExitPlanMode'])(
    'treats a request with the %s tool as the planner',
    (toolName) => {
      const req = body({
        model: 'claude-opus-4-8',
        max_tokens: 64000,
        tools: [{ name: 'Bash' }, { name: toolName }, { name: 'Read' }],
      })
      expect(classifyClaudeCodeRole(req, FLOOR)).toBe('planner')
    },
  )

  it('classifies a real subagent (no Agent tool, high max_tokens) as subagent', () => {
    const req = body({
      model: 'claude-opus-4-8',
      max_tokens: 32000,
      tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'Grep' }, { name: 'Glob' }],
    })
    expect(classifyClaudeCodeRole(req, FLOOR)).toBe('subagent')
  })

  it('classifies tiny utility calls (security monitor, title-gen) below the floor as utility', () => {
    const securityMonitor = body({ model: 'claude-opus-4-8', max_tokens: 64, system: 'monitor' })
    expect(classifyClaudeCodeRole(securityMonitor, FLOOR)).toBe('utility')
  })

  it('treats the floor as inclusive', () => {
    expect(classifyClaudeCodeRole(body({ max_tokens: FLOOR, tools: [] }), FLOOR)).toBe('subagent')
    expect(classifyClaudeCodeRole(body({ max_tokens: FLOOR - 1, tools: [] }), FLOOR)).toBe('utility')
  })

  it('does not false-match a tool whose name merely starts with Agent', () => {
    const req = body({ max_tokens: 32000, tools: [{ name: 'AgentInspector' }] })
    expect(classifyClaudeCodeRole(req, FLOOR)).toBe('subagent')
  })

  it('classifies a body with no max_tokens (unknown) as subagent when no planner tool', () => {
    const req = body({ model: 'claude-opus-4-8', tools: [{ name: 'Bash' }] })
    expect(classifyClaudeCodeRole(req, FLOOR)).toBe('subagent')
  })
})
