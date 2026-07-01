import { useEffect, useMemo, useState } from 'react'
import { fetchRun } from '../api'
import { Cache, Duration, Time, compactTokens } from '../components/Format'
import { HelpTip } from '../components/HelpTip'
import type { ActionSummary, RunDetail as RunDetailT } from '../types'
import { StructuredPrompt, getStructuredContent } from './runDetail/promptRenderer'

export function RunDetail({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<RunDetailT | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const d = await fetchRun(runId)
        if (!cancelled) setDetail(d)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [runId])

  if (error) return <div className="error">Error: {error}</div>
  if (!detail) return <div className="loading">Loading…</div>

  const r = detail.run
  return (
    <div className="run-detail">
      <button
        type="button"
        className="back"
        onClick={() => {
          window.location.hash = r.threadId ? `#/task/${encodeURIComponent(r.threadId)}` : '#/tasks'
        }}
      >
        ← back to task
      </button>
      <div className="run-header">
        <h2>
          <code>{r.id}</code>
        </h2>
        <div className="run-header-meta">
          <span>{r.agent}</span>
          <span>·</span>
          <span>{r.status}</span>
          <span>·</span>
          <span>model: {r.model ? <code>{r.model}</code> : <span className="muted">—</span>}</span>
          <span>·</span>
          <span>
            <Time ms={r.startedAt} />
          </span>
          <span>·</span>
          <span>
            <Duration ms={r.durMs} />
          </span>
        </div>
      </div>

      <RunErrors actions={detail.actions} />

      <TokenBreakdown actions={detail.actions} />

      <div className="meta">
        <dl>
          <dt>Tokens</dt>
          <dd>
            {r.tokensIn ?? 0} / {r.tokensOut ?? 0}
          </dd>
          <dt>Cache R/W</dt>
          <dd>
            <Cache read={r.cacheReadTokens} write={r.cacheWriteTokens} />
          </dd>
        </dl>
      </div>

      <FullMessages actions={detail.actions} />
    </div>
  )
}

// A failed model_call carries its upstream HTTP status and error text in the
// captured payload (see orchestrator/capture.ts buildPayload). The rest of the
// detail page only renders the request/response messages, so a run that errored
// before any assistant turn showed nothing about why. Surface each errored
// model_call as a banner with the status and the upstream error body.
type ModelCallPayload = {
  status?: number
  error?: string
  model?: string
  clientModel?: string
  providerId?: string
  orchestration?: { role?: string; step?: number }
}

function modelCallPayload(a: ActionSummary): ModelCallPayload | null {
  if (a.kind !== 'model_call') return null
  const p = a.payload as ModelCallPayload | null | undefined
  if (!p || typeof p !== 'object') return null
  return p
}

function isErroredCall(p: ModelCallPayload): boolean {
  return (typeof p.status === 'number' && p.status >= 400) || Boolean(p.error)
}

function RunErrors({ actions }: { actions: ActionSummary[] }) {
  const calls = actions
    .filter((a) => a.kind === 'model_call')
    .map((a) => ({ id: a.id, ts: a.ts, p: modelCallPayload(a) }))
    .filter((c): c is { id: string; ts: number; p: ModelCallPayload } => c.p != null)
    .sort((a, b) => a.ts - b.ts)

  const errors = calls.filter((c) => isErroredCall(c.p))
  if (errors.length === 0) return null

  // A chain with `switchOn: error` retries on a sibling model. If a later
  // attempt succeeded (the last model_call is clean, or a failover-role call
  // came back 200), the run actually completed — the errored attempt was
  // recovered, not a failure. Surface that so a recovered run doesn't read as
  // broken next to the model that actually served it.
  const recoverer = calls.find((c) => !isErroredCall(c.p) && c.p.orchestration?.role === 'failover')
  const lastClean = !isErroredCall(calls[calls.length - 1]!.p)
  const recovered = recoverer != null || (lastClean && errors.length < calls.length)
  const recoveredModel = recoverer?.p.model ?? calls[calls.length - 1]?.p.model

  return (
    <section className={`run-errors${recovered ? ' run-errors-recovered' : ''}`}>
      {recovered ? (
        <div className="run-recovered-note">
          <span className="run-recovered-badge">recovered</span>
          Chain failed over and completed
          {recoveredModel ? (
            <>
              {' '}
              on <code>{recoveredModel}</code>
            </>
          ) : null}
          . The attempt{errors.length > 1 ? 's' : ''} below errored but did not break the run.
        </div>
      ) : null}
      {errors.map(({ id, p }) => (
        <div className={`run-error-card${recovered ? ' run-error-card-recovered' : ''}`} key={id}>
          <div className="run-error-head">
            <span className="run-error-badge">{recovered ? 'failover' : 'error'}</span>
            {typeof p.status === 'number' ? (
              <span className="run-error-status">HTTP {p.status}</span>
            ) : null}
            <span className="run-error-model">
              {p.clientModel && p.clientModel !== p.model ? (
                <>
                  requested <code>{p.clientModel}</code> →{' '}
                </>
              ) : null}
              {p.model ? <code>{p.model}</code> : null}
              {p.providerId ? <span className="muted"> @ {p.providerId}</span> : null}
            </span>
          </div>
          {p.error ? <pre className="run-error-body">{p.error}</pre> : null}
        </div>
      ))}
    </section>
  )
}

// afw measures usage in tokens, not dollars. This splits the run's
// total token throughput (input + output) by action kind so you can see
// where the context budget went.
function TokenBreakdown({ actions }: { actions: ActionSummary[] }) {
  const byKind = new Map<string, { tokens: number; count: number }>()
  for (const a of actions) {
    const e = byKind.get(a.kind) ?? { tokens: 0, count: 0 }
    e.tokens += (a.tokensIn ?? 0) + (a.tokensOut ?? 0)
    e.count += 1
    byKind.set(a.kind, e)
  }
  const rows = Array.from(byKind.entries()).sort((a, b) => b[1].tokens - a[1].tokens)
  const total = rows.reduce((sum, [, e]) => sum + e.tokens, 0)
  const max = Math.max(...rows.map((r) => r[1].tokens), 1)

  return (
    <section className="cost-breakdown">
      <div className="cost-breakdown-head">
        <span className="cost-breakdown-title">
          Token breakdown
          <HelpTip>
            This run's input + output tokens, split by action kind.
            <br />
            <code>model_call</code> = a call to an LLM endpoint.
            <br />
            <code>mcp_call</code> = MCP JSON-RPC frame (usually 0 tokens).
            <br />
            <code>network</code> = other HTTP through the proxy.
          </HelpTip>
        </span>
        <span className="cost-breakdown-total">{compactTokens(total)} tok</span>
      </div>
      <div className="cost-breakdown-rows">
        {rows.map(([kind, e]) => (
          <div className="cost-breakdown-row" key={kind}>
            <span className={`kind kind-${kind}`}>{kind}</span>
            <span className="cost-breakdown-count">({e.count})</span>
            <span className="cost-breakdown-bar-track">
              <span
                className="cost-breakdown-bar-fill"
                style={{ width: `${(e.tokens / max) * 100}%` }}
              />
            </span>
            <span className="cost-breakdown-cost">{compactTokens(e.tokens)}</span>
            <span className="cost-breakdown-pct">
              {total > 0 ? `${Math.round((e.tokens / total) * 100)}%` : '—'}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────
// Full messages — openguardrails-style per-message cards
// ─────────────────────────────────────────────────────────────

type OpenAIToolCall = {
  id?: string
  type?: string
  function?: { name?: string; arguments?: unknown }
}

type GuardEdit = {
  ruleId: string
  path: string
  role?: string
  before: string
  after: string
}

type FlatMessage = {
  role: string
  content: unknown
  name?: string
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
  guardEdits?: GuardEdit[]
}

const PREVIEW_CHARS = 800

function FullMessages({ actions }: { actions: ActionSummary[] }) {
  const messages = useMemo(() => buildFlatMessages(actions), [actions])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  if (messages.length === 0) {
    return <div className="empty">No model calls captured for this run.</div>
  }

  const toggle = (idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  return (
    <section className="full-messages">
      <div className="full-messages-head">
        <span className="full-messages-title">Full messages</span>
        <span className="full-messages-count">{messages.length}</span>
      </div>
      <div className="full-messages-list">
        {messages.map((m, idx) => (
          <MessageCard
            // biome-ignore lint/suspicious/noArrayIndexKey: index IS the visible identity (#N)
            key={idx}
            index={idx + 1}
            message={m}
            isExpanded={expanded.has(idx)}
            onToggle={() => toggle(idx)}
          />
        ))}
      </div>
    </section>
  )
}

function MessageCard({
  index,
  message,
  isExpanded,
  onToggle,
}: {
  index: number
  message: FlatMessage
  isExpanded: boolean
  onToggle: () => void
}) {
  const role = message.role || 'unknown'
  const edits = message.guardEdits ?? []
  const rawContent = flattenContent(message.content)
  const focusedEdits = edits.map(focusGuardEdit)
  const content = applyGuardEditsToText(rawContent, focusedEdits)

  // why: tool-role results are often JSON-stringified objects. If we can
  // parse to an object, render as structured key/value rows (same shape
  // as the tool-call arguments). Otherwise fall back to text.
  const structuredResult = role === 'tool' ? parseArgsObject(content) : null
  // System prompts and Claude-Code-style <system-reminder> user messages
  // get a multi-section card rendering instead of one big text blob.
  const structuredPrompt =
    !structuredResult && focusedEdits.length === 0 ? getStructuredContent(role, content) : null
  const display =
    structuredResult || structuredPrompt ? '' : role === 'tool' ? tryPrettyJson(content) : content
  const isLong = display.length > PREVIEW_CHARS
  const shown = isLong && !isExpanded ? `${display.slice(0, PREVIEW_CHARS)}…` : display

  // For the chars-in-header label, prefer the original content length even
  // when we render structurally (so the user still sees how big the payload
  // is).
  const charsHint = content.length

  return (
    <div className="msg-card">
      <div className="msg-card-head">
        <div className="msg-card-head-left">
          <span className="msg-card-num">#{index}</span>
          <span className={`msg-role msg-role-${role}`}>{role}</span>
          {message.name ? (
            <span className="msg-meta">
              name: <code>{message.name}</code>
            </span>
          ) : null}
          {message.tool_call_id ? (
            <span className="msg-meta">
              tool_call_id: <code>{message.tool_call_id}</code>
            </span>
          ) : null}
          {charsHint ? (
            <span
              className="msg-meta"
              title="Approximate token count (ASCII ÷ 4 + CJK × 0.6). Real count comes from the upstream usage field; this is just a budget hint."
            >
              {charsHint.toLocaleString()} chars · ~{formatTokens(approxTokens(content))} tok
            </span>
          ) : null}
        </div>
        {!structuredResult && !structuredPrompt && isLong ? (
          <button type="button" className="msg-expand-btn" onClick={onToggle}>
            {isExpanded ? '▾ collapse' : '▸ expand'}
          </button>
        ) : null}
      </div>
      {structuredResult ? (
        <div className="msg-card-result">
          <ArgsList args={structuredResult} variant="result" />
        </div>
      ) : structuredPrompt ? (
        <div className="msg-card-prompt">
          <StructuredPrompt content={structuredPrompt} />
        </div>
      ) : display ? (
        <pre className="msg-card-body">
          {focusedEdits.length > 0 ? (
            <HighlightedText text={shown} edits={focusedEdits} />
          ) : (
            shown
          )}
        </pre>
      ) : null}
      {Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? (
        <div className="msg-card-toolcalls">
          {message.tool_calls.map((tc, i) => (
            <ToolCallNested
              // biome-ignore lint/suspicious/noArrayIndexKey: tool_calls stable in a captured msg
              key={tc.id || i}
              call={tc}
            />
          ))}
        </div>
      ) : null}
      {focusedEdits.length ? <GuardEdits edits={focusedEdits} /> : null}
    </div>
  )
}

function HighlightedText({ text, edits }: { text: string; edits: GuardEdit[] }) {
  const highlights = edits
    .map((edit) => edit.after)
    .filter((s, index, arr) => s && arr.indexOf(s) === index)
    .sort((a, b) => b.length - a.length)
  if (highlights.length === 0) return <>{text}</>

  const parts: Array<{ text: string; mark: boolean }> = []
  let index = 0
  while (index < text.length) {
    const hit = highlights
      .map((h) => ({ h, at: text.indexOf(h, index) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at || b.h.length - a.h.length)[0]
    if (!hit) {
      parts.push({ text: text.slice(index), mark: false })
      break
    }
    if (hit.at > index) parts.push({ text: text.slice(index, hit.at), mark: false })
    parts.push({ text: hit.h, mark: true })
    index = hit.at + hit.h.length
  }

  return (
    <>
      {parts.map((part, i) =>
        part.mark ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: text fragments are positional
          <mark className="msg-guard-highlight" key={i}>
            {part.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: text fragments are positional
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  )
}

function GuardEdits({ edits }: { edits: GuardEdit[] }) {
  return (
    <div className="msg-card-edits">
      <div className="msg-card-edits-title">Guard edits</div>
      {edits.map((edit, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: edits are immutable captured metadata
        <div className="msg-edit" key={`${edit.ruleId}-${edit.path}-${index}`}>
          <div className="msg-edit-meta">
            <code>{edit.ruleId}</code>
            <span>{edit.path}</span>
          </div>
          <div className="msg-edit-grid">
            <div className="msg-edit-label">Before</div>
            <pre className="msg-edit-text msg-edit-before">{edit.before}</pre>
            <div className="msg-edit-label">After</div>
            <pre className="msg-edit-text msg-edit-after">{edit.after}</pre>
          </div>
        </div>
      ))}
    </div>
  )
}

function applyGuardEditsToText(text: string, edits: GuardEdit[]): string {
  let out = text
  for (const edit of edits) {
    if (!edit.before || edit.before === edit.after) continue
    if (out.includes(edit.before)) {
      out = out.split(edit.before).join(edit.after)
      continue
    }
    const focused = focusGuardEdit(edit)
    if (focused.before && out.includes(focused.before)) {
      out = out.split(focused.before).join(focused.after)
    }
  }
  return out
}

function focusGuardEdit(edit: GuardEdit): GuardEdit {
  if (edit.before.length < 500 && edit.after.length < 500) return edit
  const fragment = changedFragment(edit.before, edit.after)
  return { ...edit, before: fragment.before, after: fragment.after }
}

function changedFragment(before: string, after: string): { before: string; after: string } {
  if (before === after) return { before, after }
  let start = 0
  const maxStart = Math.min(before.length, after.length)
  while (start < maxStart && before[start] === after[start]) start++

  let beforeEnd = before.length
  let afterEnd = after.length
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--
    afterEnd--
  }

  const left = expandFragmentLeft(before, start)
  return {
    before: before.slice(left, expandFragmentRight(before, beforeEnd)),
    after: after.slice(left, expandFragmentRight(after, afterEnd)),
  }
}

function expandFragmentLeft(text: string, index: number): number {
  let i = index
  while (i > 0 && !/\s/.test(text[i - 1])) i--
  return i
}

function expandFragmentRight(text: string, index: number): number {
  let i = index
  while (i < text.length && !/\s/.test(text[i])) i++
  return i
}

function ToolCallNested({ call }: { call: OpenAIToolCall }) {
  const name = call.function?.name || 'function'
  const args = parseArgsObject(call.function?.arguments)
  const sizingSource = sizingStringForArgs(call.function?.arguments)
  const chars = sizingSource.length
  return (
    <div className="toolcall-card">
      <div className="toolcall-card-head">
        <span className="toolcall-badge">tool call</span>
        <code className="toolcall-name">{name}</code>
        {call.id ? (
          <span className="toolcall-id">
            id: <code>{call.id}</code>
          </span>
        ) : null}
        {chars > 0 ? (
          <span className="toolcall-id" title="Approximate token count for the tool-call arguments">
            {chars.toLocaleString()} chars · ~{formatTokens(approxTokens(sizingSource))} tok
          </span>
        ) : null}
      </div>
      {args ? <ArgsList args={args} /> : null}
    </div>
  )
}

function sizingStringForArgs(args: unknown): string {
  if (args == null) return ''
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args)
  } catch {
    return String(args)
  }
}

function parseArgsObject(args: unknown): Record<string, unknown> | null {
  if (args == null) return null
  if (typeof args === 'string') {
    const trimmed = args.trim()
    if (!trimmed) return null
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed)
        if (keys.length === 0) return null
        return parsed as Record<string, unknown>
      }
      return null
    } catch {
      return null
    }
  }
  if (Array.isArray(args)) return null
  if (typeof args === 'object') {
    const obj = args as Record<string, unknown>
    if (Object.keys(obj).length === 0) return null
    return obj
  }
  return null
}

function ArgsList({
  args,
  variant = 'args',
}: {
  args: Record<string, unknown>
  variant?: 'args' | 'result'
}) {
  const keys = Object.keys(args)
  if (keys.length === 0) return null
  return (
    <dl className={`args-list args-list-${variant}`}>
      {keys.map((k) => (
        <div className="args-row" key={k}>
          <dt className="args-key">{k}</dt>
          <dd className="args-val">
            <ArgValue value={args[k]} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

function ArgValue({ value }: { value: unknown }) {
  if (value == null) return <span className="args-dim">null</span>
  if (typeof value === 'string') {
    if (value === '') return <span className="args-dim">""</span>
    return <span className="args-string">{value}</span>
  }
  if (typeof value === 'number') return <span className="args-num">{value}</span>
  if (typeof value === 'boolean') return <span className="args-bool">{String(value)}</span>
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="args-dim">[]</span>
    // For short scalar arrays, show inline. For longer or nested, abbreviate.
    const scalars = value.every(
      (v) => v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
    )
    if (scalars && value.length <= 8) {
      return (
        <span className="args-array">
          [
          {value.map((v, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: array order is the identity
            <span key={i} className="args-array-item">
              {String(v)}
            </span>
          ))}
          ]
        </span>
      )
    }
    return <span className="args-dim">[{value.length} items]</span>
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    if (keys.length === 0) return <span className="args-dim">{'{}'}</span>
    // Nested object: render as an indented mini-list (one level deep), then
    // dim {…} for deeper structures.
    return (
      <div className="args-nested">
        {keys.slice(0, 8).map((k) => (
          <div className="args-row" key={k}>
            <dt className="args-key args-key-nested">{k}</dt>
            <dd className="args-val">
              <ArgValueLeaf value={obj[k]} />
            </dd>
          </div>
        ))}
        {keys.length > 8 ? <div className="args-dim">+ {keys.length - 8} more fields</div> : null}
      </div>
    )
  }
  return <span className="args-string">{String(value)}</span>
}

// why: cheap per-message token estimate so users get a budget signal
// alongside char count without paying the cost of shipping tiktoken to
// the browser (~1MB WASM). Counts ASCII bytes ÷ 4 + non-ASCII × 0.6 —
// close enough to cl100k_base/o200k_base for the "is this message
// large?" question. Real counts come from the upstream usage field.
function approxTokens(s: string): number {
  if (!s) return 0
  let ascii = 0
  let nonAscii = 0
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 128) ascii++
    else nonAscii++
  }
  return Math.round(ascii / 4 + nonAscii * 0.6)
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function ArgValueLeaf({ value }: { value: unknown }) {
  // Inside an already-nested arg, don't recurse deeper — abbreviate instead.
  if (value == null) return <span className="args-dim">null</span>
  if (typeof value === 'string') {
    if (value === '') return <span className="args-dim">""</span>
    return <span className="args-string">{value}</span>
  }
  if (typeof value === 'number') return <span className="args-num">{value}</span>
  if (typeof value === 'boolean') return <span className="args-bool">{String(value)}</span>
  if (Array.isArray(value)) {
    return (
      <span className="args-dim">
        [{value.length} {value.length === 1 ? 'item' : 'items'}]
      </span>
    )
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    return (
      <span className="args-dim">{`{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}`}</span>
    )
  }
  return <span className="args-string">{String(value)}</span>
}

// ─── data flattening ──────────────────────────────────────────

function buildFlatMessages(actions: ActionSummary[]): FlatMessage[] {
  // why: model_call payloads carry the FULL conversation history each turn;
  // intermediate actions duplicate prior messages. The last model_call holds
  // the most complete prefix, and its `response` is the assistant turn that
  // didn't get echoed back yet. So: take the last model_call's messages,
  // expand each into 1+ FlatMessages, then append a synthetic assistant
  // message built from its response.
  const modelCalls = actions.filter((a) => a.kind === 'model_call').sort((a, b) => a.ts - b.ts)
  if (modelCalls.length === 0) return []

  const last = modelCalls[modelCalls.length - 1]!
  const payload = (last.payload ?? {}) as {
    messages?: unknown
    response?: unknown
    guardEdits?: unknown
  }
  const baseRaw = Array.isArray(payload.messages) ? (payload.messages as unknown[]) : []
  const base: FlatMessage[] = []
  for (const m of baseRaw) {
    for (const flat of expandMessage(m)) base.push(flat)
  }

  // Append the last assistant response if response[] holds anything not yet
  // echoed back into messages (Anthropic runs typically leave it out).
  const response = Array.isArray(payload.response) ? (payload.response as unknown[]) : []
  if (response.length > 0) {
    for (const flat of convertAnthropicContentToMessages('assistant', response)) {
      base.push(flat)
    }
  }

  attachGuardEdits(base, readGuardEdits(payload.guardEdits))
  return base
}

function readGuardEdits(value: unknown): GuardEdit[] {
  if (!Array.isArray(value)) return []
  const edits: GuardEdit[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    if (
      typeof e.ruleId !== 'string' ||
      typeof e.path !== 'string' ||
      typeof e.before !== 'string' ||
      typeof e.after !== 'string'
    ) {
      continue
    }
    edits.push({
      ruleId: e.ruleId,
      path: e.path,
      ...(typeof e.role === 'string' ? { role: e.role } : {}),
      before: e.before,
      after: e.after,
    })
  }
  return edits
}

function attachGuardEdits(messages: FlatMessage[], edits: GuardEdit[]): void {
  for (const edit of edits) {
    const candidates = messages.filter((m) => !edit.role || m.role === edit.role)
    const target =
      candidates.find((m) => {
        const content = flattenContent(m.content)
        return content.includes(edit.after) || content.includes(edit.before)
      }) ?? candidates[0]
    if (!target) continue
    target.guardEdits = [...(target.guardEdits ?? []), edit]
  }
}

/**
 * Expand one raw message into 1+ FlatMessages. The split exists because
 * Anthropic encodes tool results as blocks inside user-role messages,
 * but humans (and openguardrails) read them most easily as their own
 * #N tool card. So: pull tool_result blocks out into synthetic
 * role='tool' messages, leaving the user message with just text.
 */
function expandMessage(raw: unknown): FlatMessage[] {
  if (!raw || typeof raw !== 'object') return []
  const m = raw as Record<string, unknown>
  if (typeof m.role !== 'string') return []

  if (Array.isArray(m.content) && hasAnthropicBlocks(m.content)) {
    return convertAnthropicContentToMessages(m.role, m.content as unknown[], m)
  }

  const flat: FlatMessage = { role: m.role, content: m.content }
  if (typeof m.name === 'string') flat.name = m.name
  if (typeof m.tool_call_id === 'string') flat.tool_call_id = m.tool_call_id
  if (Array.isArray(m.tool_calls)) flat.tool_calls = m.tool_calls as OpenAIToolCall[]
  return [flat]
}

/**
 * Expand an Anthropic content array into FlatMessages.
 *
 *   text / thinking         → joined into the parent message's content
 *   tool_use                → lifted to OpenAI tool_calls on the parent
 *   tool_result (in user)   → emitted as a separate synthetic role='tool'
 *                              message with tool_call_id set, paired to the
 *                              earlier assistant tool_use card
 */
function convertAnthropicContentToMessages(
  role: string,
  blocks: unknown[],
  parentRaw?: Record<string, unknown>,
): FlatMessage[] {
  const textParts: string[] = []
  const toolCalls: OpenAIToolCall[] = []
  const splitResults: FlatMessage[] = []

  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    const block = b as {
      type?: unknown
      text?: unknown
      thinking?: unknown
      name?: unknown
      input?: unknown
      id?: unknown
      content?: unknown
      tool_use_id?: unknown
      tool_call_id?: unknown
      is_error?: unknown
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text)
    } else if (block.type === 'thinking') {
      const t =
        typeof block.thinking === 'string'
          ? block.thinking
          : typeof block.text === 'string'
            ? block.text
            : ''
      if (t.trim()) textParts.push(`[thinking]\n${t}`)
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: typeof block.id === 'string' ? block.id : undefined,
        type: 'function',
        function: {
          name: typeof block.name === 'string' ? block.name : 'tool',
          arguments: block.input,
        },
      })
    } else if (block.type === 'tool_result') {
      // Split out as its own #N tool message.
      const inner = block.content
      let body = ''
      if (typeof inner === 'string') body = inner
      else if (Array.isArray(inner)) body = flattenContent(inner)
      else if (inner != null) body = safeStringify(inner)
      const tcId =
        typeof block.tool_use_id === 'string'
          ? block.tool_use_id
          : typeof block.tool_call_id === 'string'
            ? block.tool_call_id
            : undefined
      const toolMsg: FlatMessage = { role: 'tool', content: body }
      if (tcId) toolMsg.tool_call_id = tcId
      splitResults.push(toolMsg)
    }
  }

  const out: FlatMessage[] = []
  if (textParts.length > 0 || toolCalls.length > 0) {
    const main: FlatMessage = { role, content: textParts.join('\n\n') }
    if (toolCalls.length > 0) main.tool_calls = toolCalls
    if (parentRaw) {
      if (typeof parentRaw.name === 'string') main.name = parentRaw.name
      if (typeof parentRaw.tool_call_id === 'string') main.tool_call_id = parentRaw.tool_call_id
      if (Array.isArray(parentRaw.tool_calls)) {
        main.tool_calls = [
          ...(main.tool_calls ?? []),
          ...(parentRaw.tool_calls as OpenAIToolCall[]),
        ]
      }
    }
    out.push(main)
  }
  for (const r of splitResults) out.push(r)
  return out
}

function hasAnthropicBlocks(content: unknown[]): boolean {
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    const type = (b as { type?: unknown }).type
    if (type === 'text' || type === 'thinking' || type === 'tool_use' || type === 'tool_result') {
      return true
    }
  }
  return false
}

function flattenContent(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (part == null) return ''
        if (typeof part === 'string') return part
        if (typeof part !== 'object') return String(part)
        const p = part as { type?: unknown; text?: unknown; content?: unknown }
        if (p.type === 'text' && typeof p.text === 'string') return p.text
        // Anthropic-style tool_result inside content array: flatten its content
        if (p.type === 'tool_result') {
          if (typeof p.content === 'string') return p.content
          if (Array.isArray(p.content)) return flattenContent(p.content)
          return safeStringify(p.content)
        }
        return safeStringify(part)
      })
      .filter(Boolean)
      .join('\n')
  }
  return safeStringify(content)
}

function tryPrettyJson(value: string): string {
  if (!value) return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return value
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
