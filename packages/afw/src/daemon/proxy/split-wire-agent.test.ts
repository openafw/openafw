import { describe, expect, it } from 'vitest'
import { restPathForWireRequest, splitWireAgent } from './index.ts'

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

describe('restPathForWireRequest', () => {
  it('strips the raw per-instance agent segment, not the bare agent', () => {
    expect(
      restPathForWireRequest(
        '/wire/claude-code@harness-eed410/v1/messages',
        'claude-code@harness-eed410',
      ),
    ).toBe('/v1/messages')
  })

  it('keeps non-instance wire paths unchanged', () => {
    expect(restPathForWireRequest('/wire/claude-code/v1/messages', 'claude-code')).toBe(
      '/v1/messages',
    )
  })

  it('returns slash for the wire root', () => {
    expect(restPathForWireRequest('/wire/claude-code@worker', 'claude-code@worker')).toBe('/')
  })
})
