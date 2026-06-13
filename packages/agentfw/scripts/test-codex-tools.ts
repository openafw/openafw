// Diagnostic: route the same minimal request to codex's chatgpt backend
// THREE ways and compare what the model produces. Hypothesis we're
// testing: gpt-5.5 returns reasoning-only (no message blocks) when the
// tool set is not the codex-CLI tool surface it was trained against.
//
//   A. baseline  — codex-shaped body, NO tools field
//   B. codex     — codex-shaped body, codex-CLI tool names (exec_command,
//                  apply_patch, update_plan)
//   C. openclaw  — codex-shaped body, openclaw tool names (read, write,
//                  edit, exec, …) — what the routed call actually sends
//
// Reads ~/.codex/auth.json directly. Tokens are never echoed back. Only
// the per-variant output-block summary (and SSE event types we saw)
// reaches stdout.
//
// Run: node --experimental-strip-types packages/agentfw/scripts/test-codex-tools.ts

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Variant = { name: string; tools: unknown[] | undefined }

const PROMPT = 'List the files in /tmp. Use the available tools.'

const IDENTITY = `You are a coding agent running in the Codex CLI, a terminal-based coding assistant. You are expected to be precise, safe, and helpful.

The host harness provides your operating context as the first developer-role message in this turn. Treat that developer message as authoritative.

Use the tools provided to accomplish the user's task. Stream concise thinking followed by direct, actionable output.`

const DEVELOPER_CONTEXT = `You are a personal assistant. The user is on macOS. Use the provided tools to list files when asked.`

// Codex-CLI's actual tool surface. Names pulled from captured native
// codex requests; schemas trimmed to the minimum that should validate.
const CODEX_TOOLS = [
  {
    type: 'function',
    name: 'exec_command',
    description: 'Run a shell command, returning its stdout/stderr/exit code.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Shell command to execute.' },
      },
      required: ['cmd'],
    },
  },
  {
    type: 'function',
    name: 'apply_patch',
    description: 'Apply a unified-diff style patch to the workspace.',
    strict: false,
    parameters: {
      type: 'object',
      properties: { patch: { type: 'string' } },
      required: ['patch'],
    },
  },
]

// Openclaw's tool surface. Same semantics (list/run/etc.) but with names
// gpt-5.5 has never seen during fine-tuning.
const OPENCLAW_TOOLS = [
  {
    type: 'function',
    name: 'exec',
    description: 'Run a shell command.',
    strict: false,
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    type: 'function',
    name: 'edit',
    description: 'Make precise edits to files.',
    strict: false,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, replacement: { type: 'string' } },
      required: ['path', 'replacement'],
    },
  },
  {
    type: 'function',
    name: 'read',
    description: 'Read file contents.',
    strict: false,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
]

type CodexAuth = {
  auth_mode?: string
  tokens?: { access_token?: string; account_id?: string }
  account_id?: string
  access_token?: string
}

async function loadAuth(): Promise<{ token: string; accountId: string }> {
  const path = join(homedir(), '.codex', 'auth.json')
  const raw = await readFile(path, 'utf8')
  const j = JSON.parse(raw) as CodexAuth
  const token = j.tokens?.access_token ?? j.access_token ?? ''
  const accountId = j.tokens?.account_id ?? j.account_id ?? ''
  if (!token) throw new Error('no access_token in ~/.codex/auth.json')
  if (!accountId) throw new Error('no account_id in ~/.codex/auth.json')
  return { token, accountId }
}

function buildBody(tools: unknown[] | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: 'gpt-5.5',
    instructions: IDENTITY,
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: DEVELOPER_CONTEXT }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: PROMPT }],
      },
    ],
    stream: true,
    store: false,
    reasoning: { effort: 'medium' },
    include: ['reasoning.encrypted_content'],
    text: { verbosity: 'low' },
    tool_choice: 'auto',
    parallel_tool_calls: true,
  }
  if (tools) body.tools = tools
  return body
}

type EventTally = {
  events: Record<string, number>
  textChunks: string[]
  toolCalls: { name: string; arguments: string }[]
  errors: string[]
  finishStatus?: string
  outputItemTypes: string[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

async function runVariant(
  name: string,
  body: unknown,
  auth: { token: string; accountId: string },
): Promise<EventTally> {
  const tally: EventTally = {
    events: {},
    textChunks: [],
    toolCalls: [],
    errors: [],
    outputItemTypes: [],
  }
  const res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${auth.token}`,
      'chatgpt-account-id': auth.accountId,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      originator: 'codex_cli_rs',
      'user-agent': 'codex_cli_rs/0.81.0 (agentfw; openguardrails.com)',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) {
    tally.errors.push(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return tally
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    // SSE: split on blank lines
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let evType = ''
      let evData = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) evType = line.slice(6).trim()
        else if (line.startsWith('data:')) evData += line.slice(5).trim()
      }
      if (!evType && !evData) continue
      tally.events[evType] = (tally.events[evType] ?? 0) + 1
      if (!evData || evData === '[DONE]') continue
      try {
        const data = JSON.parse(evData)
        if (evType === 'response.output_text.delta' && typeof data.delta === 'string') {
          tally.textChunks.push(data.delta)
        }
        if (evType === 'response.completed' && data.response) {
          tally.finishStatus = data.response.status
          tally.usage = data.response.usage
          for (const item of data.response.output ?? []) {
            tally.outputItemTypes.push(item.type)
            if (item.type === 'function_call') {
              tally.toolCalls.push({
                name: item.name ?? '',
                arguments: typeof item.arguments === 'string' ? item.arguments : '',
              })
            }
            if (item.type === 'message' && Array.isArray(item.content)) {
              for (const c of item.content) {
                if ((c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') {
                  tally.textChunks.push(c.text)
                }
              }
            }
          }
        }
        if (evType === 'response.failed' || evType === 'error') {
          tally.errors.push(
            typeof data.error === 'string' ? data.error : JSON.stringify(data.error ?? data).slice(0, 200),
          )
        }
      } catch (e) {
        tally.errors.push(`parse: ${(e as Error).message}`)
      }
    }
  }
  return tally
}

function fmt(name: string, t: EventTally): string {
  const text = t.textChunks.join('')
  const tools = t.toolCalls.map((c) => `${c.name}(${c.arguments.slice(0, 60)})`).join('; ')
  const evSummary = Object.entries(t.events)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ')
  return [
    `── variant: ${name} ──`,
    `  events:       ${evSummary}`,
    `  output items: [${t.outputItemTypes.join(', ')}]`,
    `  finish:       ${t.finishStatus ?? '—'}`,
    `  usage:        in=${t.usage?.input_tokens ?? '?'} out=${t.usage?.output_tokens ?? '?'}`,
    `  text:         ${text ? `"${text.slice(0, 200)}${text.length > 200 ? '…' : ''}"` : '<empty>'}`,
    `  tool calls:   ${tools || '<none>'}`,
    `  errors:       ${t.errors.length ? t.errors.join(' | ') : '<none>'}`,
    '',
  ].join('\n')
}

async function main() {
  const auth = await loadAuth()
  const variants: Variant[] = [
    { name: 'A · no tools', tools: undefined },
    { name: 'B · codex names (exec_command, apply_patch)', tools: CODEX_TOOLS },
    { name: 'C · openclaw names (exec, edit, read)', tools: OPENCLAW_TOOLS },
  ]
  for (const v of variants) {
    const t = await runVariant(v.name, buildBody(v.tools), auth)
    process.stdout.write(fmt(v.name, t))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
