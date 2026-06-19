import { describe, expect, it } from 'vitest'
import { parseSseFrames } from './relay.ts'

describe('parseSseFrames', () => {
  it('extracts JSON-RPC frames from multiple SSE events', () => {
    const sse =
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n' +
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"p":1}}\n\n'
    const frames = parseSseFrames(sse) as Array<Record<string, unknown>>
    expect(frames.length).toBe(2)
    expect(frames[0]?.id).toBe(1)
    expect(frames[1]?.method).toBe('notifications/progress')
  })

  it('joins multi-line data and skips non-JSON (endpoint event, keep-alives)', () => {
    const sse =
      ': keep-alive\n\n' +
      'event: endpoint\ndata: /messages?sessionId=abc\n\n' +
      'data: {"jsonrpc":"2.0",\ndata: "id":2,"result":1}\n\n'
    const frames = parseSseFrames(sse) as Array<Record<string, unknown>>
    expect(frames.length).toBe(1) // endpoint URL + comment skipped; multi-line data joined
    expect(frames[0]?.id).toBe(2)
  })

  it('returns nothing for an empty / frameless stream', () => {
    expect(parseSseFrames('')).toEqual([])
    expect(parseSseFrames(': ping\n\n')).toEqual([])
  })
})
