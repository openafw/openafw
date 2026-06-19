import { describe, expect, it } from 'vitest'
import { classifyCheapTask, classifyClaudeCodeRole } from './subagent.ts'

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
    expect(classifyClaudeCodeRole(body({ max_tokens: FLOOR - 1, tools: [] }), FLOOR)).toBe(
      'utility',
    )
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

describe('classifyCheapTask', () => {
  it('flags a hermes cron job by its scheduled-job system marker', () => {
    const req = body({
      system: '[IMPORTANT: You are running as a scheduled cron job. DELIVERY: ...]',
      messages: [{ role: 'user', content: 'check the news' }],
    })
    expect(classifyCheapTask('hermes', req)).toBe('cron')
  })

  it('flags an openclaw cron reminder by its event-prompt lead-in', () => {
    const req = body({
      messages: [
        {
          role: 'user',
          content:
            'A scheduled reminder has been triggered. The reminder content is:\n\nfeed the cat',
        },
      ],
    })
    expect(classifyCheapTask('openclaw', req)).toBe('cron')
  })

  it('flags an openclaw empty cron event too', () => {
    const req = body({
      messages: [
        {
          role: 'user',
          content: 'A scheduled cron event was triggered, but no event content was found.',
        },
      ],
    })
    expect(classifyCheapTask('openclaw', req)).toBe('cron')
  })

  it('leaves a normal interactive hermes/openclaw request alone', () => {
    const req = body({ messages: [{ role: 'user', content: 'hello there' }] })
    expect(classifyCheapTask('hermes', req)).toBeUndefined()
    expect(classifyCheapTask('openclaw', req)).toBeUndefined()
  })

  it('flags a Claude Code subagent (no orchestrator tool, above floor)', () => {
    const req = body({ model: 'claude-opus-4-8', max_tokens: 32000, tools: [{ name: 'Bash' }] })
    expect(classifyCheapTask('claude-code', req)).toBe('subagent')
  })

  it('does not flag the Claude Code planner', () => {
    const req = body({ model: 'claude-opus-4-8', max_tokens: 64000, tools: [{ name: 'Agent' }] })
    expect(classifyCheapTask('claude-code', req)).toBeUndefined()
  })

  it('does not flag a tiny Claude Code utility call', () => {
    const req = body({ model: 'claude-opus-4-8', max_tokens: 64, tools: [] })
    expect(classifyCheapTask('claude-code', req)).toBeUndefined()
  })

  it('returns undefined for an agent with no cheap-task signal', () => {
    const req = body({
      messages: [{ role: 'user', content: 'A scheduled reminder has been triggered' }],
    })
    expect(classifyCheapTask('claude-desktop', req)).toBeUndefined()
  })
})
