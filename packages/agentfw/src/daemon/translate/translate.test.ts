import { describe, expect, it } from 'vitest'
import type { ModelApi } from '../../core/model-registry.ts'
import {
  type IRRequest,
  type IRResponse,
  parseRequestToIR,
  parseResponseToIR,
  serializeRequestFromIR,
  serializeResponseFromIR,
  translateRequest,
  translateResponseJson,
} from './index.ts'

const APIS: ModelApi[] = ['anthropic-messages', 'openai-chat', 'openai-responses']

// A request exercising every block kind that survives all three protocols:
// text, top-level image, tool_use, tool_result, a mixed user turn, tools.
const CANONICAL_REQUEST: IRRequest = {
  model: 'test-model',
  system: 'You are a helpful assistant.',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'aGVsbG8=' } },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me look it up.' },
        { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SF' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'call_1',
          content: [{ type: 'text', text: 'Sunny, 72F' }],
        },
        { type: 'text', text: 'Thanks!' },
      ],
    },
  ],
  tools: [
    {
      name: 'get_weather',
      description: 'Get the weather for a city',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  ],
  maxTokens: 1024,
  temperature: 0.7,
  stream: false,
}

// `max_tokens` is the one stop reason expressible in all three protocols
// (Anthropic `stop_reason`, Chat `finish_reason:length`, Responses
// `status:incomplete`) — so it round-trips cleanly through the matrix.
const CANONICAL_RESPONSE: IRResponse = {
  model: 'test-model',
  blocks: [
    { type: 'text', text: 'The weather is sunny.' },
    { type: 'tool_use', id: 'call_9', name: 'lookup', input: { q: 'x' } },
  ],
  stopReason: 'max_tokens',
  usage: { in: 100, out: 50, cacheRead: 20 },
}

/** Drop `rawJson` — set by the OpenAI parsers, absent from the Anthropic one. */
function stripRawJson(ir: IRResponse): IRResponse {
  return {
    ...ir,
    blocks: ir.blocks.map((b) =>
      b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : b,
    ),
  }
}

describe('translateRequest / translateResponseJson identity', () => {
  it('returns the same request body when source and target match', () => {
    const body = serializeRequestFromIR('openai-chat', CANONICAL_REQUEST)
    expect(translateRequest('openai-chat', 'openai-chat', body)).toBe(body)
  })

  it('returns the same response JSON when source and target match', () => {
    const json = serializeResponseFromIR('anthropic-messages', CANONICAL_RESPONSE)
    expect(translateResponseJson('anthropic-messages', 'anthropic-messages', json)).toBe(json)
  })
})

describe('tool_choice translation (Anthropic → OpenAI-chat)', () => {
  function anthropicReqWith(tc: unknown) {
    return {
      model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
      tool_choice: tc,
    }
  }

  function translatedOpenAI(tc: unknown): { tool_choice: unknown } {
    const wire = anthropicReqWith(tc)
    return translateRequest('anthropic-messages', 'openai-chat', wire) as {
      tool_choice: unknown
    }
  }

  it('maps {type:"tool", name:"X"} to OpenAI {type:"function", function:{name:"X"}}', () => {
    expect(translatedOpenAI({ type: 'tool', name: 'web_search' }).tool_choice).toEqual({
      type: 'function',
      function: { name: 'web_search' },
    })
  })

  it('maps "any" to "required" and the rest pass through verbatim', () => {
    expect(translatedOpenAI({ type: 'auto' }).tool_choice).toBe('auto')
    expect(translatedOpenAI({ type: 'any' }).tool_choice).toBe('required')
    expect(translatedOpenAI({ type: 'none' }).tool_choice).toBe('none')
  })

  it('omits tool_choice from the OpenAI body when source has none', () => {
    const wire = {
      model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
    }
    const obj = translateRequest('anthropic-messages', 'openai-chat', wire) as Record<
      string,
      unknown
    >
    expect('tool_choice' in obj).toBe(false)
  })
})

describe('request translation matrix', () => {
  for (const from of APIS) {
    for (const to of APIS) {
      it(`preserves the request IR: ${from} → ${to}`, () => {
        const wire = serializeRequestFromIR(from, CANONICAL_REQUEST)
        const translated = translateRequest(from, to, wire)
        expect(parseRequestToIR(to, translated)).toEqual(CANONICAL_REQUEST)
      })
    }
  }
})

describe('response translation matrix', () => {
  for (const from of APIS) {
    for (const to of APIS) {
      it(`preserves the response IR: ${from} → ${to}`, () => {
        const wire = serializeResponseFromIR(from, CANONICAL_RESPONSE)
        const translated = translateResponseJson(from, to, wire)
        const ir = parseResponseToIR(to, translated)
        expect(stripRawJson(ir)).toEqual(stripRawJson(CANONICAL_RESPONSE))
      })
    }
  }
})

describe('request serialization shape', () => {
  it('Anthropic output always carries max_tokens', () => {
    const noLimit: IRRequest = { ...CANONICAL_REQUEST, maxTokens: undefined }
    const wire = serializeRequestFromIR('anthropic-messages', noLimit) as { max_tokens: number }
    expect(wire.max_tokens).toBe(4096)
  })

  it('routes tool schemas to each protocol field name', () => {
    const anthropic = serializeRequestFromIR('anthropic-messages', CANONICAL_REQUEST) as {
      tools: Array<{ input_schema: unknown }>
    }
    expect(anthropic.tools[0]?.input_schema).toMatchObject({ type: 'object' })

    const chat = serializeRequestFromIR('openai-chat', CANONICAL_REQUEST) as {
      tools: Array<{ type: string; function: { parameters: unknown } }>
    }
    expect(chat.tools[0]?.type).toBe('function')
    expect(chat.tools[0]?.function.parameters).toMatchObject({ type: 'object' })

    const responses = serializeRequestFromIR('openai-responses', CANONICAL_REQUEST) as {
      tools: Array<{ type: string; name: string; parameters: unknown }>
    }
    expect(responses.tools[0]?.name).toBe('get_weather')
    expect(responses.tools[0]?.parameters).toMatchObject({ type: 'object' })
  })

  it('turns a tool_result into a standalone role:tool message for Chat', () => {
    const wire = serializeRequestFromIR('openai-chat', CANONICAL_REQUEST) as {
      messages: Array<{ role: string; tool_call_id?: string; content?: unknown }>
    }
    const toolMsg = wire.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.tool_call_id).toBe('call_1')
    expect(toolMsg?.content).toBe('Sunny, 72F')
  })

  it('unrolls turns into a flat input stream for Responses', () => {
    const wire = serializeRequestFromIR('openai-responses', CANONICAL_REQUEST) as {
      instructions: string
      input: Array<{ type: string }>
    }
    expect(wire.instructions).toBe('You are a helpful assistant.')
    expect(wire.input.map((i) => i.type)).toEqual([
      'message',
      'message',
      'function_call',
      'function_call_output',
      'message',
    ])
  })
})

describe('request parsing edge cases', () => {
  it('flattens an Anthropic array-form system prompt', () => {
    const ir = parseRequestToIR('anthropic-messages', {
      model: 'm',
      max_tokens: 10,
      system: [
        { type: 'text', text: 'Line one.' },
        { type: 'text', text: 'Line two.' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(ir.system).toBe('Line one.\nLine two.')
  })

  it('merges consecutive Chat tool messages into one user turn', () => {
    const ir = parseRequestToIR('openai-chat', {
      model: 'm',
      messages: [
        { role: 'assistant', content: null, tool_calls: [] },
        { role: 'tool', tool_call_id: 't1', content: 'a' },
        { role: 'tool', tool_call_id: 't2', content: 'b' },
      ],
    })
    const last = ir.messages[ir.messages.length - 1]
    expect(last?.role).toBe('user')
    expect(last?.content).toHaveLength(2)
    expect(last?.content.every((b) => b.type === 'tool_result')).toBe(true)
  })

  it('decodes a base64 data URI back to an image source', () => {
    const ir = parseRequestToIR('openai-chat', {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/jpeg;base64,Zm9v' },
            },
          ],
        },
      ],
    })
    expect(ir.messages[0]?.content[0]).toEqual({
      type: 'image',
      source: { kind: 'base64', mediaType: 'image/jpeg', data: 'Zm9v' },
    })
  })
})

describe('stop reason mapping', () => {
  it('round-trips end_turn / tool_use between Anthropic and Chat', () => {
    for (const reason of ['end_turn', 'tool_use', 'max_tokens']) {
      const resp: IRResponse = { ...CANONICAL_RESPONSE, stopReason: reason }
      const wire = serializeResponseFromIR('anthropic-messages', resp)
      const back = parseResponseToIR('openai-chat', translateResponseJson('anthropic-messages', 'openai-chat', wire))
      expect(back.stopReason).toBe(reason)
    }
  })
})

describe('lossy directions', () => {
  it('drops thinking blocks when targeting OpenAI Chat', () => {
    const withThinking: IRResponse = {
      ...CANONICAL_RESPONSE,
      blocks: [
        { type: 'thinking', text: 'secret reasoning' },
        { type: 'text', text: 'visible answer' },
      ],
    }
    const wire = serializeResponseFromIR('openai-chat', withThinking)
    const back = parseResponseToIR('openai-chat', wire)
    expect(back.blocks.some((b) => b.type === 'thinking')).toBe(false)
    expect(back.blocks).toContainEqual({ type: 'text', text: 'visible answer' })
  })

  it('loses a non-truncation stop reason through OpenAI Responses', () => {
    const resp: IRResponse = { ...CANONICAL_RESPONSE, stopReason: 'tool_use' }
    const wire = serializeResponseFromIR('anthropic-messages', resp)
    const back = parseResponseToIR(
      'openai-responses',
      translateResponseJson('anthropic-messages', 'openai-responses', wire),
    )
    expect(back.stopReason).toBeUndefined()
  })
})
