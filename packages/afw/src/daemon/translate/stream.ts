// Live SSE translation. A single-model cross-protocol swap with `stream:true`
// is true-streamed: the upstream's SSE is parsed into a neutral incremental
// event sequence and re-serialized into the client's wire format on the fly,
// so the client sees tokens as they arrive instead of waiting for the buffer.
//
// The neutral event model is block-oriented (Anthropic-shaped): a message
// start, a sequence of content blocks (text / thinking / tool_use) each with
// open → deltas → close, and a finish carrying stop reason and usage. Three
// source readers parse provider SSE into these events; three writers serialize
// them back out. `from === to` is a byte-identical passthrough.
//
// One asymmetry: the OpenAI Responses *source* has no incremental block
// framing worth replaying (its stream parser already keys off the terminal
// `response.completed` payload), so a Responses upstream is read to completion
// and then replayed as events — that direction does not gain time-to-first-
// token, only correctness. Every other direction streams live.

import { createParser } from 'eventsource-parser'
import { nanoid } from 'nanoid'
import { logger } from '../../core/logger.ts'
import type { ModelApi } from '../../core/model-registry.ts'
import type { NormalizedBlock } from '../../core/packet.ts'
import { parseAnthropicStream } from '../decoders/anthropic/sse.ts'
import { parseOpenAIResponsesStream } from '../decoders/openai/responses-sse.ts'
import { parseOpenAIChatStream } from '../decoders/openai/sse.ts'
import { responseToIR } from './from-openai-responses.ts'
import { type IRResponse, type IRUsage, canonicalStopReason, openaiStopReason } from './ir.ts'
import { asObject, num, optNum, parseToolArgs, str, stringifyToolArgs } from './shared.ts'

// ── neutral incremental event model ───────────────────────────────

type BlockKind =
  | { type: 'text' }
  | { type: 'thinking' }
  | { type: 'tool_use'; id: string; name: string }

/** One step of a translated response. `index` is the *source* block index;
 *  writers remap it to their own contiguous numbering. */
type StreamEvent =
  | { t: 'start'; model: string }
  | { t: 'block-open'; index: number; block: BlockKind }
  | { t: 'text'; index: number; text: string }
  | { t: 'thinking'; index: number; text: string }
  | { t: 'tool-args'; index: number; json: string }
  | { t: 'block-close'; index: number }
  | { t: 'finish'; stopReason: string | undefined; usage: IRUsage }

type Emit = (ev: StreamEvent) => void

// ── SSE framing ───────────────────────────────────────────────────

/** Frame one SSE event: an optional `event:` line and a `data:` line. A
 *  string `data` is emitted verbatim (used for the `[DONE]` sentinel). */
function frame(event: string | undefined, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data)
  return event ? `event: ${event}\ndata: ${payload}\n\n` : `data: ${payload}\n\n`
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** Feed an upstream byte stream through an eventsource-parser, handing each
 *  decoded JSON event to `onEvent`. The `[DONE]` sentinel is skipped. */
async function feedParser(
  stream: ReadableStream<Uint8Array>,
  onEvent: (data: unknown) => void,
): Promise<void> {
  const parser = createParser({
    onEvent: (ev) => {
      if (ev.data === '[DONE]') return
      let data: unknown
      try {
        data = JSON.parse(ev.data)
      } catch {
        return
      }
      onEvent(data)
    },
  })
  const td = new TextDecoder()
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    parser.feed(td.decode(chunk, { stream: true }))
  }
  parser.feed(td.decode())
}

// ── source readers ────────────────────────────────────────────────

async function readAnthropic(stream: ReadableStream<Uint8Array>, emit: Emit): Promise<void> {
  let started = false
  let stopReason: string | undefined
  const usage: IRUsage = { in: 0, out: 0 }
  const open = new Set<number>()
  const start = (model: string): void => {
    if (!started) {
      started = true
      emit({ t: 'start', model })
    }
  }

  try {
    await feedParser(stream, (d) => {
      const data = asObject(d)
      switch (data.type) {
        case 'message_start': {
          const msg = asObject(data.message)
          start(str(msg.model) ?? '')
          const u = asObject(msg.usage)
          usage.in = num(u.input_tokens)
          if (optNum(u.cache_read_input_tokens) != null) {
            usage.cacheRead = num(u.cache_read_input_tokens)
          }
          if (optNum(u.cache_creation_input_tokens) != null) {
            usage.cacheWrite = num(u.cache_creation_input_tokens)
          }
          break
        }
        case 'content_block_start': {
          start('')
          const idx = num(data.index)
          const cb = asObject(data.content_block)
          if (cb.type === 'text') {
            open.add(idx)
            emit({ t: 'block-open', index: idx, block: { type: 'text' } })
          } else if (cb.type === 'thinking') {
            open.add(idx)
            emit({ t: 'block-open', index: idx, block: { type: 'thinking' } })
          } else if (cb.type === 'tool_use') {
            open.add(idx)
            emit({
              t: 'block-open',
              index: idx,
              block: { type: 'tool_use', id: str(cb.id) ?? '', name: str(cb.name) ?? '' },
            })
          }
          break
        }
        case 'content_block_delta': {
          const idx = num(data.index)
          if (!open.has(idx)) break
          const delta = asObject(data.delta)
          if (delta.type === 'text_delta') {
            emit({ t: 'text', index: idx, text: typeof delta.text === 'string' ? delta.text : '' })
          } else if (delta.type === 'thinking_delta') {
            emit({
              t: 'thinking',
              index: idx,
              text: typeof delta.thinking === 'string' ? delta.thinking : '',
            })
          } else if (delta.type === 'input_json_delta') {
            emit({
              t: 'tool-args',
              index: idx,
              json: typeof delta.partial_json === 'string' ? delta.partial_json : '',
            })
          }
          break
        }
        case 'content_block_stop': {
          const idx = num(data.index)
          if (open.has(idx)) {
            open.delete(idx)
            emit({ t: 'block-close', index: idx })
          }
          break
        }
        case 'message_delta': {
          const delta = asObject(data.delta)
          if (str(delta.stop_reason)) stopReason = str(delta.stop_reason)
          const u = asObject(data.usage)
          if (optNum(u.output_tokens) != null) usage.out = num(u.output_tokens)
          if (optNum(u.input_tokens) != null) usage.in = num(u.input_tokens)
          break
        }
      }
    })
  } finally {
    start('')
    for (const idx of open) emit({ t: 'block-close', index: idx })
    emit({ t: 'finish', stopReason, usage })
  }
}

async function readOpenAIChat(stream: ReadableStream<Uint8Array>, emit: Emit): Promise<void> {
  let started = false
  let model = ''
  let stopReason: string | undefined
  const usage: IRUsage = { in: 0, out: 0 }
  let nextIndex = 0
  let textIndex = -1
  let textClosed = false
  const toolMap = new Map<number, number>()
  const start = (): void => {
    if (!started) {
      started = true
      emit({ t: 'start', model })
    }
  }

  try {
    await feedParser(stream, (d) => {
      const data = asObject(d)
      if (str(data.model) && !model) model = str(data.model) ?? ''
      start()

      const u = asObject(data.usage)
      if (optNum(u.prompt_tokens) != null) usage.in = num(u.prompt_tokens)
      if (optNum(u.completion_tokens) != null) usage.out = num(u.completion_tokens)
      const ptd = asObject(u.prompt_tokens_details)
      if (optNum(ptd.cached_tokens) != null) usage.cacheRead = num(ptd.cached_tokens)

      const choice = asObject(arr(data.choices)[0])
      const delta = asObject(choice.delta)

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (textIndex < 0 || textClosed) {
          textIndex = nextIndex++
          textClosed = false
          emit({ t: 'block-open', index: textIndex, block: { type: 'text' } })
        }
        emit({ t: 'text', index: textIndex, text: delta.content })
      }

      const toolCalls = arr(delta.tool_calls)
      // A tool call ends the text block — keep destination blocks sequential.
      if (toolCalls.length > 0 && textIndex >= 0 && !textClosed) {
        emit({ t: 'block-close', index: textIndex })
        textClosed = true
      }
      for (const raw of toolCalls) {
        const t = asObject(raw)
        const oi = num(t.index)
        let si = toolMap.get(oi)
        if (si === undefined) {
          si = nextIndex++
          toolMap.set(oi, si)
          const fn = asObject(t.function)
          emit({
            t: 'block-open',
            index: si,
            block: { type: 'tool_use', id: str(t.id) ?? '', name: str(fn.name) ?? '' },
          })
        }
        const fn = asObject(t.function)
        if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
          emit({ t: 'tool-args', index: si, json: fn.arguments })
        }
      }

      if (str(choice.finish_reason)) {
        stopReason = canonicalStopReason(str(choice.finish_reason))
      }
    })
  } finally {
    start()
    if (textIndex >= 0 && !textClosed) emit({ t: 'block-close', index: textIndex })
    for (const si of toolMap.values()) emit({ t: 'block-close', index: si })
    emit({ t: 'finish', stopReason, usage })
  }
}

/** Replay a buffered IRResponse as the neutral event sequence — used for the
 *  OpenAI Responses source, which is read to completion before replay. */
function emitIR(ir: IRResponse, model: string, emit: Emit): void {
  emit({ t: 'start', model: model || ir.model })
  ir.blocks.forEach((b, index) => {
    if (b.type === 'text') {
      emit({ t: 'block-open', index, block: { type: 'text' } })
      emit({ t: 'text', index, text: b.text })
      emit({ t: 'block-close', index })
    } else if (b.type === 'thinking') {
      emit({ t: 'block-open', index, block: { type: 'thinking' } })
      emit({ t: 'thinking', index, text: b.text })
      emit({ t: 'block-close', index })
    } else if (b.type === 'tool_use') {
      emit({ t: 'block-open', index, block: { type: 'tool_use', id: b.id, name: b.name } })
      emit({ t: 'tool-args', index, json: stringifyToolArgs(b.input) })
      emit({ t: 'block-close', index })
    }
  })
  emit({ t: 'finish', stopReason: ir.stopReason, usage: ir.usage })
}

async function readOpenAIResponses(stream: ReadableStream<Uint8Array>, emit: Emit): Promise<void> {
  let completed: unknown = null
  let model = ''
  let deltaText = ''
  // codex's chatgpt session backend (store:false) ships an empty `output`
  // array on `response.completed`; the real output items arrive on
  // `response.output_item.done`. We accumulate them here and splice into
  // the completed payload before handing it to responseToIR.
  const finalizedItems: unknown[] = []

  try {
    await feedParser(stream, (d) => {
      const data = asObject(d)
      const resp = asObject(data.response)
      if (str(resp.model) && !model) model = str(resp.model) ?? ''
      if (data.type === 'response.output_text.delta' && typeof data.delta === 'string') {
        deltaText += data.delta
      } else if (data.type === 'response.output_item.done') {
        if (data.item && typeof data.item === 'object') finalizedItems.push(data.item)
      } else if (data.type === 'response.completed') {
        completed = data.response ?? null
      }
    })
  } finally {
    if (completed) {
      // If the upstream omitted output (codex store:false), splice in the
      // items we collected from per-item-done events so responseToIR sees
      // them.
      const c = completed as Record<string, unknown>
      const out = Array.isArray(c.output) ? c.output : []
      if (out.length === 0 && finalizedItems.length > 0) {
        c.output = finalizedItems
      }
      emitIR(responseToIR(c), model, emit)
    } else if (finalizedItems.length > 0) {
      emitIR(
        responseToIR({ output: finalizedItems, usage: { input_tokens: 0, output_tokens: 0 } }),
        model,
        emit,
      )
    } else if (deltaText) {
      emit({ t: 'start', model })
      emit({ t: 'block-open', index: 0, block: { type: 'text' } })
      emit({ t: 'text', index: 0, text: deltaText })
      emit({ t: 'block-close', index: 0 })
      emit({ t: 'finish', stopReason: undefined, usage: { in: 0, out: 0 } })
    } else {
      emit({ t: 'start', model })
      emit({ t: 'finish', stopReason: undefined, usage: { in: 0, out: 0 } })
    }
  }
}

function readSource(api: ModelApi, stream: ReadableStream<Uint8Array>, emit: Emit): Promise<void> {
  if (api === 'anthropic-messages') return readAnthropic(stream, emit)
  if (api === 'openai-chat') return readOpenAIChat(stream, emit)
  return readOpenAIResponses(stream, emit)
}

// ── destination writers ───────────────────────────────────────────

interface Writer {
  handle(ev: StreamEvent): string
}

class AnthropicWriter implements Writer {
  private destIndex = 0
  private readonly map = new Map<number, number>()

  handle(ev: StreamEvent): string {
    switch (ev.t) {
      case 'start':
        return frame('message_start', {
          type: 'message_start',
          message: {
            id: `msg_${nanoid()}`,
            type: 'message',
            role: 'assistant',
            model: ev.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })
      case 'block-open': {
        const di = this.destIndex++
        this.map.set(ev.index, di)
        const cb =
          ev.block.type === 'text'
            ? { type: 'text', text: '' }
            : ev.block.type === 'thinking'
              ? { type: 'thinking', thinking: '' }
              : { type: 'tool_use', id: ev.block.id, name: ev.block.name, input: {} }
        return frame('content_block_start', {
          type: 'content_block_start',
          index: di,
          content_block: cb,
        })
      }
      case 'text': {
        const di = this.map.get(ev.index)
        if (di === undefined) return ''
        return frame('content_block_delta', {
          type: 'content_block_delta',
          index: di,
          delta: { type: 'text_delta', text: ev.text },
        })
      }
      case 'thinking': {
        const di = this.map.get(ev.index)
        if (di === undefined) return ''
        return frame('content_block_delta', {
          type: 'content_block_delta',
          index: di,
          delta: { type: 'thinking_delta', thinking: ev.text },
        })
      }
      case 'tool-args': {
        const di = this.map.get(ev.index)
        if (di === undefined) return ''
        return frame('content_block_delta', {
          type: 'content_block_delta',
          index: di,
          delta: { type: 'input_json_delta', partial_json: ev.json },
        })
      }
      case 'block-close': {
        const di = this.map.get(ev.index)
        if (di === undefined) return ''
        return frame('content_block_stop', { type: 'content_block_stop', index: di })
      }
      case 'finish': {
        const usage: Record<string, number> = {
          input_tokens: ev.usage.in,
          output_tokens: ev.usage.out,
        }
        if (ev.usage.cacheRead != null) usage.cache_read_input_tokens = ev.usage.cacheRead
        if (ev.usage.cacheWrite != null) usage.cache_creation_input_tokens = ev.usage.cacheWrite
        return (
          frame('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: ev.stopReason ?? 'end_turn', stop_sequence: null },
            usage,
          }) + frame('message_stop', { type: 'message_stop' })
        )
      }
    }
  }
}

class OpenAIChatWriter implements Writer {
  private readonly id = `chatcmpl-${nanoid()}`
  private readonly created = Math.floor(Date.now() / 1000)
  private model = ''
  private toolIndex = 0
  private readonly map = new Map<number, number>()

  private chunk(choices: unknown[], usage?: unknown): string {
    const data: Record<string, unknown> = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices,
    }
    if (usage) data.usage = usage
    return frame(undefined, data)
  }

  handle(ev: StreamEvent): string {
    switch (ev.t) {
      case 'start':
        this.model = ev.model
        return this.chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])
      case 'block-open': {
        if (ev.block.type !== 'tool_use') return ''
        const ti = this.toolIndex++
        this.map.set(ev.index, ti)
        return this.chunk([
          {
            index: 0,
            finish_reason: null,
            delta: {
              tool_calls: [
                {
                  index: ti,
                  id: ev.block.id,
                  type: 'function',
                  function: { name: ev.block.name, arguments: '' },
                },
              ],
            },
          },
        ])
      }
      case 'text':
        return this.chunk([{ index: 0, delta: { content: ev.text }, finish_reason: null }])
      case 'thinking':
        // OpenAI Chat Completions has no thinking channel — dropped.
        return ''
      case 'tool-args': {
        const ti = this.map.get(ev.index)
        if (ti === undefined) return ''
        return this.chunk([
          {
            index: 0,
            finish_reason: null,
            delta: { tool_calls: [{ index: ti, function: { arguments: ev.json } }] },
          },
        ])
      }
      case 'block-close':
        return ''
      case 'finish': {
        const fin = this.chunk([
          { index: 0, delta: {}, finish_reason: openaiStopReason(ev.stopReason) },
        ])
        const usage: Record<string, unknown> = {
          prompt_tokens: ev.usage.in,
          completion_tokens: ev.usage.out,
          total_tokens: ev.usage.in + ev.usage.out,
        }
        if (ev.usage.cacheRead != null) {
          usage.prompt_tokens_details = { cached_tokens: ev.usage.cacheRead }
        }
        return fin + this.chunk([], usage) + frame(undefined, '[DONE]')
      }
    }
  }
}

// OpenAI Responses true-streaming writer. Emits the full event sequence
// codex's strict parser needs: response.created → in_progress → per item
// added / content_part.added / output_text.delta / output_text.done /
// content_part.done / output_item.done → completed. Every delta carries the
// `item_id` / `output_index` / `content_index` fields its parent item used,
// using the same ids referenced from `response.completed`.
class OpenAIResponsesWriter implements Writer {
  private seq = 0
  private model = ''
  private readonly responseId = `resp_${nanoid()}`
  private readonly createdAt = Math.floor(Date.now() / 1000)
  private readonly order: number[] = []
  private readonly acc = new Map<
    number,
    {
      block: NormalizedBlock
      toolJson: string
      itemId: string
      outputIndex: number
      contentIndex: number
    }
  >()
  private outputIndexNext = 0

  private finalizeTool(entry: { block: NormalizedBlock; toolJson: string }): void {
    if (entry.block.type === 'tool_use') {
      entry.block.rawJson = entry.toolJson || undefined
      entry.block.input = entry.toolJson ? parseToolArgs(entry.toolJson) : {}
    }
  }

  handle(ev: StreamEvent): string {
    switch (ev.t) {
      case 'start': {
        this.model = ev.model
        const base = {
          id: this.responseId,
          object: 'response',
          created_at: this.createdAt,
          status: 'in_progress',
          model: this.model,
          output: [] as unknown[],
        }
        const created = frame('response.created', {
          type: 'response.created',
          sequence_number: this.seq++,
          response: base,
        })
        const inProgress = frame('response.in_progress', {
          type: 'response.in_progress',
          sequence_number: this.seq++,
          response: base,
        })
        return created + inProgress
      }
      case 'block-open': {
        const outputIndex = this.outputIndexNext++
        if (ev.block.type === 'text') {
          const itemId = `msg_${nanoid()}`
          this.acc.set(ev.index, {
            block: { type: 'text', text: '' },
            toolJson: '',
            itemId,
            outputIndex,
            contentIndex: 0,
          })
          this.order.push(ev.index)
          const itemAdded = frame('response.output_item.added', {
            type: 'response.output_item.added',
            sequence_number: this.seq++,
            output_index: outputIndex,
            item: {
              id: itemId,
              type: 'message',
              status: 'in_progress',
              role: 'assistant',
              content: [],
            },
          })
          const partAdded = frame('response.content_part.added', {
            type: 'response.content_part.added',
            sequence_number: this.seq++,
            item_id: itemId,
            output_index: outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          })
          return itemAdded + partAdded
        }
        if (ev.block.type === 'tool_use') {
          const itemId = `fc_${nanoid()}`
          this.acc.set(ev.index, {
            block: { type: 'tool_use', id: ev.block.id, name: ev.block.name, input: {} },
            toolJson: '',
            itemId,
            outputIndex,
            contentIndex: 0,
          })
          this.order.push(ev.index)
          return frame('response.output_item.added', {
            type: 'response.output_item.added',
            sequence_number: this.seq++,
            output_index: outputIndex,
            item: {
              id: itemId,
              type: 'function_call',
              status: 'in_progress',
              arguments: '',
              call_id: ev.block.id || `call_${nanoid()}`,
              name: ev.block.name,
            },
          })
        }
        // thinking → tracked for state but emits no openai-responses event.
        this.acc.set(ev.index, {
          block: { type: 'thinking', text: '' },
          toolJson: '',
          itemId: '',
          outputIndex,
          contentIndex: 0,
        })
        this.order.push(ev.index)
        return ''
      }
      case 'text': {
        const entry = this.acc.get(ev.index)
        if (!entry) return ''
        if (entry.block.type === 'text') entry.block.text += ev.text
        return frame('response.output_text.delta', {
          type: 'response.output_text.delta',
          sequence_number: this.seq++,
          item_id: entry.itemId,
          output_index: entry.outputIndex,
          content_index: entry.contentIndex,
          delta: ev.text,
        })
      }
      case 'thinking': {
        const entry = this.acc.get(ev.index)
        if (entry?.block.type === 'thinking') entry.block.text += ev.text
        return ''
      }
      case 'tool-args': {
        const entry = this.acc.get(ev.index)
        if (!entry) return ''
        entry.toolJson += ev.json
        return frame('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          sequence_number: this.seq++,
          item_id: entry.itemId,
          output_index: entry.outputIndex,
          delta: ev.json,
        })
      }
      case 'block-close': {
        const entry = this.acc.get(ev.index)
        if (!entry) return ''
        this.finalizeTool(entry)
        if (entry.block.type === 'text') {
          const text = entry.block.text
          const textDone = frame('response.output_text.done', {
            type: 'response.output_text.done',
            sequence_number: this.seq++,
            item_id: entry.itemId,
            output_index: entry.outputIndex,
            content_index: entry.contentIndex,
            text,
          })
          const partDone = frame('response.content_part.done', {
            type: 'response.content_part.done',
            sequence_number: this.seq++,
            item_id: entry.itemId,
            output_index: entry.outputIndex,
            content_index: entry.contentIndex,
            part: { type: 'output_text', text, annotations: [] },
          })
          const itemDone = frame('response.output_item.done', {
            type: 'response.output_item.done',
            sequence_number: this.seq++,
            output_index: entry.outputIndex,
            item: {
              id: entry.itemId,
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text, annotations: [] }],
            },
          })
          return textDone + partDone + itemDone
        }
        if (entry.block.type === 'tool_use') {
          const argsStr = entry.toolJson || ''
          const argsDone = frame('response.function_call_arguments.done', {
            type: 'response.function_call_arguments.done',
            sequence_number: this.seq++,
            item_id: entry.itemId,
            output_index: entry.outputIndex,
            arguments: argsStr,
          })
          const itemDone = frame('response.output_item.done', {
            type: 'response.output_item.done',
            sequence_number: this.seq++,
            output_index: entry.outputIndex,
            item: {
              id: entry.itemId,
              type: 'function_call',
              status: 'completed',
              arguments: argsStr,
              call_id: entry.block.id || `call_${nanoid()}`,
              name: entry.block.name,
            },
          })
          return argsDone + itemDone
        }
        return ''
      }
      case 'finish': {
        const output: unknown[] = []
        for (const idx of this.order) {
          const entry = this.acc.get(idx)
          if (!entry) continue
          this.finalizeTool(entry)
          if (entry.block.type === 'text') {
            output.push({
              id: entry.itemId,
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: entry.block.text, annotations: [] }],
            })
          } else if (entry.block.type === 'tool_use') {
            output.push({
              id: entry.itemId,
              type: 'function_call',
              status: 'completed',
              arguments: entry.toolJson || '',
              call_id: entry.block.id || `call_${nanoid()}`,
              name: entry.block.name,
            })
          }
        }
        const usage: Record<string, unknown> = {
          input_tokens: ev.usage.in,
          output_tokens: ev.usage.out,
          total_tokens: ev.usage.in + ev.usage.out,
        }
        if (ev.usage.cacheRead != null) {
          usage.input_tokens_details = { cached_tokens: ev.usage.cacheRead }
        }
        const incomplete = ev.stopReason === 'max_tokens'
        return frame('response.completed', {
          type: 'response.completed',
          sequence_number: this.seq++,
          response: {
            id: this.responseId,
            object: 'response',
            created_at: this.createdAt,
            status: incomplete ? 'incomplete' : 'completed',
            model: this.model,
            output,
            usage,
            ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
          },
        })
      }
    }
  }
}

function makeWriter(api: ModelApi): Writer {
  if (api === 'anthropic-messages') return new AnthropicWriter()
  if (api === 'openai-chat') return new OpenAIChatWriter()
  return new OpenAIResponsesWriter()
}

// ── public API ────────────────────────────────────────────────────

/** Translate an upstream SSE stream from one wire API to another, live.
 *  `from === to` is a byte-identical passthrough — the upstream stream is
 *  returned unchanged. */
export function translateSseStream(
  from: ModelApi,
  to: ModelApi,
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  if (from === to) return upstream
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const writer = makeWriter(to)
      try {
        await readSource(from, upstream, (ev) => {
          const out = writer.handle(ev)
          if (out) controller.enqueue(encoder.encode(out))
        })
      } catch (err) {
        logger.error(
          `translate: stream translation ${from}→${to} failed: ${(err as Error).message}`,
        )
      }
      controller.close()
    },
  })
}

/** Drain an SSE stream in `api`'s wire format into an IRResponse — the capture
 *  branch of a true-streamed swap, parsed off the client's hot path. */
export async function parseStreamToIR(
  api: ModelApi,
  body: ReadableStream<Uint8Array>,
): Promise<IRResponse> {
  if (api === 'anthropic-messages') {
    const r = await parseAnthropicStream(body)
    return {
      model: r.model ?? '',
      blocks: r.blocks,
      stopReason: r.stopReason,
      usage: {
        in: r.usage.inputTokens ?? 0,
        out: r.usage.outputTokens ?? 0,
        cacheRead: r.usage.cacheReadInputTokens,
        cacheWrite: r.usage.cacheCreationInputTokens,
      },
    }
  }
  if (api === 'openai-chat') {
    const r = await parseOpenAIChatStream(body)
    return {
      model: r.model ?? '',
      blocks: r.blocks,
      stopReason: canonicalStopReason(r.finishReason),
      usage: {
        in: r.usage.inputTokens ?? 0,
        out: r.usage.outputTokens ?? 0,
        cacheRead: r.usage.cacheReadInputTokens,
      },
    }
  }
  const r = await parseOpenAIResponsesStream(body)
  return {
    model: r.model ?? '',
    blocks: r.blocks,
    stopReason: canonicalStopReason(r.finishReason),
    usage: {
      in: r.usage.inputTokens ?? 0,
      out: r.usage.outputTokens ?? 0,
      cacheRead: r.usage.cacheReadInputTokens,
    },
  }
}
