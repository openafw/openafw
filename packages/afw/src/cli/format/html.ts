// Self-contained HTML formatter for a single run — one static page with
// inline CSS, no external assets, openable straight in a browser or attached
// to a ticket. Mirrors the markdown report's structure.

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

export function formatHtml(detail: RunDetail, opts: { redact: boolean }): string {
  const r = detail.run
  const b = tokenBuckets(r)
  const out: string[] = []

  out.push('<!doctype html>')
  out.push('<html lang="en"><head><meta charset="utf-8">')
  out.push(`<title>afw trace — ${esc(r.id)}</title>`)
  out.push(`<style>${STYLE}</style>`)
  out.push('</head><body>')
  out.push(`<h1>afw trace <code>${esc(r.id)}</code></h1>`)

  out.push('<table class="meta">')
  row(out, 'Agent', `<code>${esc(r.agent)}</code>`)
  row(out, 'Started', esc(formatTime(r.startedAt)))
  row(out, 'Duration', esc(formatDuration(r.durMs)))
  row(out, 'Status', esc(r.status))
  row(out, 'Cost', esc(formatCost(r.costUsd)))
  row(
    out,
    'Tokens',
    `${b.cachedIn.toLocaleString()} cached-in · ${b.freshIn.toLocaleString()} fresh-in · ${b.out.toLocaleString()} out`,
  )
  row(out, 'Actions', String(r.actionCount))
  out.push('</table>')

  for (let i = 0; i < detail.actions.length; i++) {
    const a = detail.actions[i]
    if (!a) continue
    out.push('<section class="action">')
    out.push(
      `<h2>Action ${i + 1} — <code>${esc(a.kind)}</code> <span class="dim">${esc(formatTimeShort(a.ts))}</span></h2>`,
    )
    if (a.kind === 'model_call' && a.payload) {
      formatModelCall(out, a, opts)
    } else {
      out.push(
        `<pre class="json">${esc(JSON.stringify(opts.redact ? redactDeep(a.payload) : a.payload, null, 2))}</pre>`,
      )
    }
    out.push('</section>')
  }

  out.push(
    `<footer>Captured by <a href="https://github.com/openafw/openafw">afw</a> — <code>afw report ${esc(r.id)} --format html</code></footer>`,
  )
  out.push('</body></html>')
  return `${out.join('\n')}\n`
}

function formatModelCall(
  out: string[],
  // biome-ignore lint/suspicious/noExplicitAny: action shape
  a: any,
  opts: { redact: boolean },
): void {
  const p = a.payload
  const b = tokenBuckets(a)
  out.push('<dl class="kv">')
  row2(out, 'Endpoint', `<code>${esc(p.endpoint ?? '?')}</code>`)
  row2(out, 'Model', `<code>${esc(p.model || '?')}</code>`)
  row2(
    out,
    'Status',
    `${esc(String(p.status ?? '?'))} · stop <code>${esc(p.stopReason ?? '—')}</code>`,
  )
  row2(out, 'Duration', esc(formatDuration(a.durMs)))
  row2(
    out,
    'Cost',
    `${esc(formatCost(a.costUsd))} (${b.cachedIn.toLocaleString()} cached-in · ${b.freshIn.toLocaleString()} fresh-in · ${b.out.toLocaleString()} out)`,
  )
  out.push('</dl>')

  if (p.error) {
    out.push(
      `<p class="error"><strong>Error:</strong> ${esc(opts.redact ? redactString(String(p.error)) : String(p.error))}</p>`,
    )
  }

  if (typeof p.systemPrompt === 'string' && p.systemPrompt.length > 0) {
    const prompt = opts.redact ? redactString(p.systemPrompt) : p.systemPrompt
    details(out, `System prompt (${p.systemPrompt.length} chars)`, `<pre>${esc(prompt)}</pre>`)
  }

  if (Array.isArray(p.messages) && p.messages.length > 0) {
    const messages = opts.redact ? redactDeep(p.messages) : p.messages
    details(
      out,
      `Messages (${p.messages.length})`,
      `<pre class="json">${esc(JSON.stringify(messages, null, 2))}</pre>`,
    )
  }

  if (Array.isArray(p.response) && p.response.length > 0) {
    out.push('<h3>Response</h3>')
    for (const block of p.response) formatBlock(out, block, opts)
  }
}

function formatBlock(
  out: string[],
  // biome-ignore lint/suspicious/noExplicitAny: block shape per-type
  block: any,
  opts: { redact: boolean },
): void {
  if (block?.type === 'text') {
    out.push(
      `<p class="text">${esc(opts.redact ? redactString(String(block.text)) : String(block.text))}</p>`,
    )
    return
  }
  if (block?.type === 'tool_use') {
    out.push(`<p class="tool"><strong>Tool call:</strong> <code>${esc(block.name)}</code></p>`)
    out.push(
      `<pre class="json">${esc(JSON.stringify(opts.redact ? redactDeep(block.input) : block.input, null, 2))}</pre>`,
    )
    return
  }
  if (block?.type === 'thinking') {
    out.push(
      `<blockquote class="thinking"><strong>Thinking:</strong><br>${esc(opts.redact ? redactString(String(block.text)) : String(block.text))}</blockquote>`,
    )
    return
  }
  out.push(`<p class="dim">[${esc(block?.type ?? 'unknown')} block]</p>`)
}

function row(out: string[], k: string, vHtml: string): void {
  out.push(`<tr><th>${esc(k)}</th><td>${vHtml}</td></tr>`)
}
function row2(out: string[], k: string, vHtml: string): void {
  out.push(`<dt>${esc(k)}</dt><dd>${vHtml}</dd>`)
}
function details(out: string[], summary: string, inner: string): void {
  out.push(`<details><summary>${esc(summary)}</summary>${inner}</details>`)
}

/** Escape text for safe interpolation into HTML — captured payloads are
 *  untrusted (they contain whatever the model emitted). */
function esc(s: unknown): string {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const STYLE = `
:root { color-scheme: light dark; }
body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 56rem; margin: 2rem auto; padding: 0 1rem; }
h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
table.meta { border-collapse: collapse; margin: 1rem 0; }
table.meta th { text-align: right; padding: 2px 12px 2px 0; color: #888; font-weight: 500; white-space: nowrap; }
.action { border: 1px solid #8884; border-radius: 8px; padding: 0 1rem 1rem; margin: 1rem 0; }
dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; }
dl.kv dt { color: #888; } dl.kv dd { margin: 0; }
pre { background: #8881; border-radius: 6px; padding: 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.text { white-space: pre-wrap; }
.error { color: #c0392b; } .dim { color: #888; }
.thinking { border-left: 3px solid #8884; padding-left: 10px; color: #888; }
details summary { cursor: pointer; color: #888; margin: 6px 0; }
footer { margin-top: 2rem; color: #888; font-size: 0.85rem; }
`.trim()

function formatTime(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC')
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
