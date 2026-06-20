import { describe, expect, it } from 'vitest'
import type { ModelApi } from '../../core/model-registry.ts'
import type { NormalizedBlock } from '../../core/packet.ts'
import { parseAnthropicStream } from '../decoders/anthropic/sse.ts'
import { parseOpenAIResponsesStream } from '../decoders/openai/responses-sse.ts'
import { parseOpenAIChatStream } from '../decoders/openai/sse.ts'
import { synthesizeSse } from '../orchestrator/synth-sse.ts'
import type { IRResponse } from './ir.ts'
import { translateSseStream } from './stream.ts'

function streamOf(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

const IR: IRResponse = {
  model: 'test-model',
  blocks: [
    { type: 'text', text: 'Hello world' },
    { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
  ],
  stopReason: 'tool_use',
  usage: { in: 10, out: 5, cacheRead: 3 },
}

const APIS: ModelApi[] = ['anthropic-messages', 'openai-chat', 'openai-responses']

/** The translated stream must carry both content blocks across every pair. */
function assertBlocks(blocks: NormalizedBlock[]): void {
  const text = blocks.find((b) => b.type === 'text')
  expect(text).toEqual({ type: 'text', text: 'Hello world' })

  const tool = blocks.find((b) => b.type === 'tool_use')
  expect(tool?.type).toBe('tool_use')
  if (tool?.type !== 'tool_use') return
  expect(tool.name).toBe('get_weather')
  expect(tool.input).toEqual({ city: 'Paris' })
}

describe('translateSseStream', () => {
  for (const from of APIS) {
    for (const to of APIS) {
      it(`translates ${from} → ${to}`, async () => {
        const src = synthesizeSse(from, IR)
        const out = translateSseStream(from, to, streamOf(src))

        if (to === 'anthropic-messages') {
          const r = await parseAnthropicStream(out)
          expect(r.errors).toEqual([])
          expect(r.model).toBe('test-model')
          expect(r.usage.inputTokens).toBe(10)
          expect(r.usage.outputTokens).toBe(5)
          // OpenAI Responses has no tool-call stop reason to carry across.
          if (from !== 'openai-responses') expect(r.stopReason).toBe('tool_use')
          assertBlocks(r.blocks)
        } else if (to === 'openai-chat') {
          const r = await parseOpenAIChatStream(out)
          expect(r.errors).toEqual([])
          expect(r.model).toBe('test-model')
          expect(r.usage.inputTokens).toBe(10)
          expect(r.usage.outputTokens).toBe(5)
          if (from !== 'openai-responses') expect(r.finishReason).toBe('tool_calls')
          assertBlocks(r.blocks)
        } else {
          const r = await parseOpenAIResponsesStream(out)
          expect(r.errors).toEqual([])
          expect(r.model).toBe('test-model')
          expect(r.usage.inputTokens).toBe(10)
          expect(r.usage.outputTokens).toBe(5)
          assertBlocks(r.blocks)
        }
      })
    }
  }

  it('streams a chat local_shell tool call back to codex as a local_shell_call', async () => {
    // A chat backend streams a tool call to the synthetic `local_shell`
    // function; translated to Responses it must become a local_shell_call the
    // codex client (and our Responses decoder) reads back as a shell tool_use.
    const shellIR: IRResponse = {
      model: 'test-model',
      blocks: [{ type: 'tool_use', id: 'call_1', name: 'local_shell', input: { command: ['ls'] } }],
      stopReason: 'tool_use',
      usage: { in: 4, out: 2 },
    }
    const chatSse = synthesizeSse('openai-chat', shellIR)
    const out = translateSseStream('openai-chat', 'openai-responses', streamOf(chatSse))
    const r = await parseOpenAIResponsesStream(out)
    expect(r.errors).toEqual([])
    const tool = r.blocks.find((b) => b.type === 'tool_use')
    expect(tool?.type).toBe('tool_use')
    if (tool?.type !== 'tool_use') return
    expect(tool.name).toBe('local_shell')
    expect((tool.input as { command: string[] }).command).toEqual(['ls'])
  })

  it('synthesizes a local_shell_call SSE for codex on the buffered path', async () => {
    const shellIR: IRResponse = {
      model: 'test-model',
      blocks: [{ type: 'tool_use', id: 'call_2', name: 'local_shell', input: { command: ['pwd'] } }],
      stopReason: 'tool_use',
      usage: { in: 1, out: 1 },
    }
    const sse = synthesizeSse('openai-responses', shellIR)
    const r = await parseOpenAIResponsesStream(streamOf(sse))
    expect(r.errors).toEqual([])
    const tool = r.blocks.find((b) => b.type === 'tool_use')
    expect(tool?.type === 'tool_use' && tool.name).toBe('local_shell')
  })

  it('is an identity passthrough when source and destination match', async () => {
    const src = synthesizeSse('anthropic-messages', IR)
    const stream = streamOf(src)
    expect(translateSseStream('anthropic-messages', 'anthropic-messages', stream)).toBe(stream)
  })
})
