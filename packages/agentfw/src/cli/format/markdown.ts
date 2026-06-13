// Markdown formatter for a single run. Output is designed to be pasted into
// GitHub issues, Slack, or Discord — readable as plain text, GitHub-flavored
// where possible (tables, <details>, fenced code).

import { redactDeep, redactString } from './redact.ts'

type RunDetail = {
  run: {
    id: string
    threadId: string
    agent: string
    status: string
    startedAt: number
    endedAt: number | null
    durMs: number | null
    costUsd: number
    tokensIn: number | null
    tokensOut: number | null
    cacheReadTokens: number | null
    cacheWriteTokens: number | null
    actionCount: number
  }
  actions: Array<{
    id: string
    kind: string
    sourceAgent: string
    ts: number
    durMs: number
    costUsd: number
    tokensIn: number | null
    tokensOut: number | null
    cacheReadTokens: number | null
    cacheWriteTokens: number | null
    riskTags: unknown[]
    // biome-ignore lint/suspicious/noExplicitAny: payload is per-kind
    payload: any
  }>
}

export function formatMarkdown(detail: RunDetail, opts: { redact: boolean }): string {
  const r = detail.run
  const out: string[] = []

  out.push(`# agentfw trace — \`${r.id}\``)
  out.push('')
  out.push('| | |')
  out.push('|---|---|')
  out.push(`| Agent | \`${r.agent}\` |`)
  out.push(`| Started | ${formatTime(r.startedAt)} |`)
  out.push(`| Duration | ${formatDuration(r.durMs)} |`)
  out.push(`| Status | ${r.status} |`)
  out.push(`| Cost | ${formatCost(r.costUsd)} |`)
  {
    const buckets = tokenBuckets(r)
    out.push(
      `| Tokens | ${buckets.cachedIn.toLocaleString()} cached-in · ` +
        `${buckets.freshIn.toLocaleString()} fresh-in · ` +
        `${buckets.out.toLocaleString()} out |`,
    )
  }
  out.push(`| Actions | ${r.actionCount} |`)
  out.push('')

  for (let i = 0; i < detail.actions.length; i++) {
    const a = detail.actions[i]
    if (!a) continue
    out.push('---')
    out.push('')
    out.push(`## Action ${i + 1} — \`${a.kind}\` · ${formatTimeShort(a.ts)}`)
    out.push('')

    if (a.kind === 'model_call' && a.payload) {
      formatModelCall(out, a, opts)
    } else {
      out.push('```json')
      const p = opts.redact ? redactDeep(a.payload) : a.payload
      out.push(JSON.stringify(p, null, 2))
      out.push('```')
      out.push('')
    }
  }

  out.push('---')
  out.push('')
  out.push(`_Captured by [agentfw](https://github.com/agentfw-com/agentfw) — \`agentfw report ${r.id}\`._`)

  return `${out.join('\n')}\n`
}

function formatModelCall(
  out: string[],
  // biome-ignore lint/suspicious/noExplicitAny: action shape
  a: any,
  opts: { redact: boolean },
): void {
  const p = a.payload
  out.push(`**Endpoint:** \`${p.endpoint ?? '?'}\``)
  out.push(`**Model:** \`${p.model || '?'}\`  `)
  out.push(`**Status:** ${p.status ?? '?'} · **Stop:** \`${p.stopReason ?? '—'}\`  `)
  out.push(`**Duration:** ${formatDuration(a.durMs)}  `)
  {
    const b = tokenBuckets(a)
    out.push(
      `**Cost:** ${formatCost(a.costUsd)} ` +
        `(${b.cachedIn.toLocaleString()} cached-in · ` +
        `${b.freshIn.toLocaleString()} fresh-in · ` +
        `${b.out.toLocaleString()} out)`,
    )
  }
  out.push('')

  if (p.error) {
    out.push(`> **Error:** ${opts.redact ? redactString(String(p.error)) : p.error}`)
    out.push('')
  }

  if (typeof p.systemPrompt === 'string' && p.systemPrompt.length > 0) {
    const prompt = opts.redact ? redactString(p.systemPrompt) : p.systemPrompt
    out.push(`<details><summary>System prompt (${p.systemPrompt.length} chars)</summary>`)
    out.push('')
    out.push('```')
    out.push(prompt)
    out.push('```')
    out.push('')
    out.push('</details>')
    out.push('')
  }

  if (Array.isArray(p.messages) && p.messages.length > 0) {
    const messages = opts.redact ? redactDeep(p.messages) : p.messages
    out.push(`<details><summary>Messages (${p.messages.length})</summary>`)
    out.push('')
    out.push('```json')
    out.push(JSON.stringify(messages, null, 2))
    out.push('```')
    out.push('')
    out.push('</details>')
    out.push('')
  }

  if (Array.isArray(p.response) && p.response.length > 0) {
    out.push('### Response')
    out.push('')
    for (const b of p.response) {
      formatBlock(out, b, opts)
    }
  }
}

function formatBlock(
  out: string[],
  // biome-ignore lint/suspicious/noExplicitAny: block shape per-type
  block: any,
  opts: { redact: boolean },
): void {
  if (block?.type === 'text') {
    const text = opts.redact ? redactString(String(block.text)) : block.text
    out.push(text)
    out.push('')
    return
  }
  if (block?.type === 'tool_use') {
    out.push(`**Tool call:** \`${block.name}\``)
    out.push('```json')
    const input = opts.redact ? redactDeep(block.input) : block.input
    out.push(JSON.stringify(input, null, 2))
    out.push('```')
    out.push('')
    return
  }
  if (block?.type === 'thinking') {
    const text = opts.redact ? redactString(String(block.text)) : block.text
    out.push('> **Thinking:**')
    for (const line of String(text).split('\n')) out.push(`> ${line}`)
    out.push('')
    return
  }
  out.push(`_[${block?.type ?? 'unknown'} block]_`)
  out.push('')
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

function formatTimeShort(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

/** Same three-bucket convention as the rest of agentfw — see cli/tui/table.ts. */
function tokenBuckets(row: {
  tokensIn: number | null
  tokensOut: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
}): { cachedIn: number; freshIn: number; out: number } {
  return {
    cachedIn: row.cacheReadTokens ?? 0,
    freshIn: (row.tokensIn ?? 0) + (row.cacheWriteTokens ?? 0),
    out: row.tokensOut ?? 0,
  }
}
