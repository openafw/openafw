import { describe, expect, it } from 'vitest'
import { splitWireAgent } from './index.ts'

describe('splitWireAgent', () => {
  it('returns the bare agent when there is no instance suffix', () => {
    expect(splitWireAgent('claude-code')).toEqual({ agent: 'claude-code' })
  })

  it('splits an instance suffix off the agent', () => {
    expect(splitWireAgent('claude-code@worker-3')).toEqual({
      agent: 'claude-code',
      instanceId: 'worker-3',
    })
  })

  it('treats an empty suffix as no instance', () => {
    expect(splitWireAgent('claude-code@')).toEqual({ agent: 'claude-code' })
  })

  it('only splits on the first @ (instance labels are slugged, but be defensive)', () => {
    expect(splitWireAgent('claude-code@a@b')).toEqual({
      agent: 'claude-code',
      instanceId: 'a@b',
    })
  })
})
