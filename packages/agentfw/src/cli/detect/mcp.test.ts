import { describe, expect, it } from 'vitest'
import { isRelayedUrl, mcpRelayUrl } from './mcp.ts'

describe('MCP relay url helpers', () => {
  it('builds a relay url under /wire-mcp/<agent>/<server>', () => {
    const url = mcpRelayUrl('claude-code', 'remote')
    expect(url).toMatch(/\/wire-mcp\/claude-code\/remote$/)
    expect(url.startsWith('http://')).toBe(true)
  })

  it('encodes server names with special characters', () => {
    expect(mcpRelayUrl('claude-code', 'my server')).toMatch(/\/wire-mcp\/claude-code\/my%20server$/)
  })

  it('isRelayedUrl recognizes already-wired urls (idempotency)', () => {
    expect(isRelayedUrl(mcpRelayUrl('claude-code', 'remote'))).toBe(true)
    expect(isRelayedUrl('https://remote.example.com/sse')).toBe(false)
    expect(isRelayedUrl(undefined)).toBe(false)
  })
})
