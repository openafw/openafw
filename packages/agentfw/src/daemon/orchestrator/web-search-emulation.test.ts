import { describe, expect, it } from 'vitest'
import {
  hasAnthropicWebSearchTool,
  rewriteAnthropicWebSearchTool,
  WEB_SEARCH_TOOL_NAME,
} from './web-search-emulation.ts'

describe('hasAnthropicWebSearchTool', () => {
  it('detects the server-tool entry by `type`', () => {
    expect(
      hasAnthropicWebSearchTool({
        tools: [
          { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
          { name: 'other', input_schema: {} },
        ],
      }),
    ).toBe(true)
  })

  it('is false for plain custom tools (including ones named web_search)', () => {
    expect(
      hasAnthropicWebSearchTool({
        tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
      }),
    ).toBe(false)
  })

  it('is false when tools is missing or non-array', () => {
    expect(hasAnthropicWebSearchTool({})).toBe(false)
    expect(hasAnthropicWebSearchTool({ tools: 'nope' })).toBe(false)
  })
})

describe('rewriteAnthropicWebSearchTool', () => {
  it('replaces the server tool with a custom tool of the same name', () => {
    const body = {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
        { name: 'my_tool', input_schema: { type: 'object' } },
      ],
    }
    const out = rewriteAnthropicWebSearchTool(body) as { tools: Array<Record<string, unknown>> }
    expect(out).not.toBe(body)
    expect(out.tools).toHaveLength(2)
    const ws = out.tools.find((t) => t.name === WEB_SEARCH_TOOL_NAME)
    expect(ws).toBeDefined()
    expect(ws?.type).toBeUndefined() // server-tool discriminator dropped
    expect(ws?.input_schema).toBeDefined()
    const schema = ws?.input_schema as { properties: { query: unknown } }
    expect(schema.properties.query).toBeDefined()
    // Other tools untouched.
    const my = out.tools.find((t) => t.name === 'my_tool')
    expect(my?.input_schema).toEqual({ type: 'object' })
  })

  it('returns the same reference when no server tool present', () => {
    const body = { tools: [{ name: 'other', input_schema: {} }] }
    expect(rewriteAnthropicWebSearchTool(body)).toBe(body)
  })

  it('preserves a custom name if the server tool had one (rare)', () => {
    const body = {
      tools: [{ type: 'web_search_20250305', name: 'custom_search_name' }],
    }
    const out = rewriteAnthropicWebSearchTool(body) as { tools: Array<{ name: string }> }
    expect(out.tools[0]?.name).toBe('custom_search_name')
  })

  it('leaves a body without tools unchanged', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] }
    expect(rewriteAnthropicWebSearchTool(body)).toBe(body)
  })
})
