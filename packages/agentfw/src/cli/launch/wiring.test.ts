import { describe, expect, it } from 'vitest'
import { wiringForAgent, wiringForBin } from './wiring.ts'

describe('launch wiring registry', () => {
  it('maps binaries to agents (by basename)', () => {
    expect(wiringForBin('claude')?.agent).toBe('claude-code')
    expect(wiringForBin('/usr/local/bin/claude')?.agent).toBe('claude-code')
    expect(wiringForBin('claude-code')?.agent).toBe('claude-code')
    expect(wiringForBin('codex')?.agent).toBe('codex')
    expect(wiringForBin('definitely-not-an-agent')).toBeUndefined()
  })

  it('honors an explicit agent override', () => {
    expect(wiringForBin('weird-wrapper', 'codex')?.agent).toBe('codex')
  })

  it('claude build injects ANTHROPIC_BASE_URL through the --settings seam', async () => {
    const plan = await wiringForAgent('claude-code')!.build('http://localhost:9877/wire/claude-code@proj')
    expect(plan.argvPrefix[0]).toBe('--settings')
    const settings = JSON.parse(plan.argvPrefix[1]!) as { env: Record<string, string> }
    expect(settings.env.ANTHROPIC_BASE_URL).toBe('http://localhost:9877/wire/claude-code@proj')
    // The env override travels via --settings, not the process env.
    expect(plan.env).toEqual({})
  })

  it('codex build emits clobber-proof -c overrides', async () => {
    const plan = await wiringForAgent('codex')!.build('http://localhost:9877/wire/codex@proj')
    expect(plan.argvPrefix).toContain('model_provider=agentfw')
    expect(plan.argvPrefix.join(' ')).toContain(
      'model_providers.agentfw.base_url="http://localhost:9877/wire/codex@proj"',
    )
    expect(plan.argvPrefix.join(' ')).toContain('model_providers.agentfw.wire_api="responses"')
  })
})
