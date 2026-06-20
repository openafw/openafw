// OpenAI Responses → neutral IR. The Responses request `input` is a flat item
// stream — `message`, `function_call`, `function_call_output` — which the IR
// folds back into user/assistant turns. Response output is parsed by the same
// `collectOutputBlocks` the Responses decoder already uses.

import { collectOutputBlocks } from '../decoders/openai/responses-sse.ts'
import {
  type IRBlock,
  type IRMessage,
  type IRRequest,
  type IRResponse,
  type IRTool,
  mergeConsecutive,
  urlToImageSource,
} from './ir.ts'
import {
  LOCAL_SHELL_SCHEMA,
  LOCAL_SHELL_TOOL,
  asObject,
  num,
  optNum,
  parseToolArgs,
  shellActionToInput,
  str,
} from './shared.ts'

export function requestToIR(body: unknown): IRRequest {
  const b = asObject(body)
  const messages: IRMessage[] = []
  if (typeof b.input === 'string') {
    if (b.input.length > 0) {
      messages.push({ role: 'user', content: [{ type: 'text', text: b.input }] })
    }
  } else if (Array.isArray(b.input)) {
    for (const raw of b.input) {
      const it = asObject(raw)
      if (it.type === 'function_call' || it.type === 'custom_tool_call') {
        // `custom_tool_call` is codex's freeform-tool call (e.g. apply_patch);
        // its argument lives in `input` as a raw string rather than `arguments`.
        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: str(it.call_id) ?? str(it.id) ?? '',
              name: str(it.name) ?? '',
              input: parseToolArgs(it.arguments ?? it.input),
            },
          ],
        })
      } else if (it.type === 'local_shell_call') {
        // Codex's shell call — fold into a tool_use against the synthetic
        // `local_shell` function tool so the conversation history stays
        // consistent with the tool we expose to the chat backend.
        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: str(it.call_id) ?? str(it.id) ?? '',
              name: LOCAL_SHELL_TOOL,
              input: shellActionToInput(it.action),
            },
          ],
        })
      } else if (
        it.type === 'function_call_output' ||
        it.type === 'tool_result' ||
        it.type === 'custom_tool_call_output' ||
        it.type === 'local_shell_call_output'
      ) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: str(it.call_id) ?? str(it.id) ?? '',
              content: [{ type: 'text', text: outputToText(it.output ?? it.content) }],
            },
          ],
        })
      } else if (it.type === 'message' || (it.role && it.content !== undefined)) {
        const role = it.role === 'assistant' ? 'assistant' : 'user'
        messages.push({ role, content: contentToBlocks(it.content) })
      }
    }
  }
  return {
    model: str(b.model) ?? '',
    system: str(b.instructions),
    messages: mergeConsecutive(messages),
    tools: toolsToIR(b.tools),
    maxTokens: optNum(b.max_output_tokens),
    temperature: optNum(b.temperature),
    stream: b.stream === true,
  }
}

export function responseToIR(json: unknown): IRResponse {
  const j = asObject(json)
  const usage = asObject(j.usage)
  return {
    model: str(j.model) ?? '',
    blocks: collectOutputBlocks(j.output),
    stopReason: statusToStopReason(j),
    usage: {
      in: num(usage.input_tokens ?? usage.prompt_tokens),
      out: num(usage.output_tokens ?? usage.completion_tokens),
      cacheRead: optNum(
        asObject(usage.input_tokens_details).cached_tokens ??
          asObject(usage.prompt_tokens_details).cached_tokens,
      ),
    },
  }
}

// ── helpers ───────────────────────────────────────────────────────

function statusToStopReason(j: Record<string, unknown>): string | undefined {
  const status = str(j.status)
  if (!status || status === 'completed' || status === 'in_progress') return undefined
  // `incomplete` on the Responses API means an output cap was hit.
  if (status === 'incomplete') return 'max_tokens'
  return status
}

function outputToText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map((p) => {
        const o = asObject(p)
        return typeof o.text === 'string' ? o.text : ''
      })
      .join('')
  }
  return ''
}

function contentToBlocks(content: unknown): IRBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: IRBlock[] = []
  for (const raw of content) {
    const p = asObject(raw)
    if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
      blocks.push({ type: 'text', text: typeof p.text === 'string' ? p.text : '' })
    } else if (p.type === 'input_image') {
      const url = typeof p.image_url === 'string' ? p.image_url : str(asObject(p.image_url).url)
      if (url) blocks.push({ type: 'image', source: urlToImageSource(url) })
    }
  }
  return blocks
}

function toolsToIR(tools: unknown): IRTool[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const out: IRTool[] = []
  for (const raw of tools) {
    const t = asObject(raw)
    // Codex's `local_shell` built-in has a `type` but no `name`. Chat
    // Completions can't express a built-in, so surface it as a function tool
    // the routed model can actually call — otherwise the old `if (!name)`
    // guard dropped it silently and the model saw only codex's named tools
    // (apply_patch / update_plan), reporting it had no way to read or run.
    if (t.type === 'local_shell') {
      out.push({
        name: LOCAL_SHELL_TOOL,
        description:
          "Run a shell command on the user's machine and return its " +
          'stdout/stderr. Provide the command as an argv array.',
        inputSchema: LOCAL_SHELL_SCHEMA,
      })
      continue
    }
    const fn = asObject(t.function)
    const name = str(t.name) ?? str(fn.name)
    if (!name) continue
    out.push({
      name,
      description: str(t.description) ?? str(fn.description),
      inputSchema: t.parameters ?? fn.parameters ?? { type: 'object' },
    })
  }
  return out.length > 0 ? out : undefined
}
