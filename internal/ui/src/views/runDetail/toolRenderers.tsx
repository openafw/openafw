// Human-readable renderers for tool_use blocks. Each known tool maps to
// a function that returns a short headline (one line) and an optional
// body (multi-line). The default renderer falls back to a tidy key-
// value listing instead of a raw JSON dump.

import type { ReactNode } from 'react'

export type ToolRender = {
  headline: ReactNode
  body?: ReactNode
}

type Args = Record<string, unknown>

function str(v: unknown, max = 80): string {
  if (typeof v !== 'string') return ''
  const s = v.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function path(v: unknown): string {
  if (typeof v !== 'string') return ''
  const parts = v.split('/')
  if (parts.length <= 3) return v
  return `…/${parts.slice(-2).join('/')}`
}

function lines(v: unknown): number {
  if (typeof v !== 'string') return 0
  return v.split('\n').length
}

const RENDERERS: Record<string, (args: Args) => ToolRender> = {
  // ── Claude Code: file ops ────────────────────────────────────
  Read: (a) => ({
    headline: (
      <>
        read <code>{path(a.file_path)}</code>
      </>
    ),
  }),
  Write: (a) => ({
    headline: (
      <>
        write <code>{path(a.file_path)}</code>{' '}
        <span className="dim">({lines(a.content)} lines)</span>
      </>
    ),
  }),
  Edit: (a) => {
    const oldLn = lines(a.old_string)
    const newLn = lines(a.new_string)
    return {
      headline: (
        <>
          edit <code>{path(a.file_path)}</code>{' '}
          <span className="dim">
            {oldLn === newLn ? `${oldLn} lines` : `${oldLn} → ${newLn} lines`}
          </span>
        </>
      ),
      body:
        a.old_string || a.new_string ? (
          <div className="tool-diff">
            {typeof a.old_string === 'string' && a.old_string ? (
              <div className="diff-removed">{trimMiddle(a.old_string, 6)}</div>
            ) : null}
            {typeof a.new_string === 'string' && a.new_string ? (
              <div className="diff-added">{trimMiddle(a.new_string, 6)}</div>
            ) : null}
          </div>
        ) : undefined,
    }
  },
  MultiEdit: (a) => {
    const edits = Array.isArray(a.edits) ? (a.edits as Args[]) : []
    return {
      headline: (
        <>
          multi-edit <code>{path(a.file_path)}</code>{' '}
          <span className="dim">({edits.length} hunks)</span>
        </>
      ),
    }
  },
  Bash: (a) => ({
    headline: (
      <>
        bash <span className="cmd">{str(a.command, 120)}</span>
      </>
    ),
    body:
      typeof a.description === 'string' && a.description ? (
        <div className="tool-note">{a.description}</div>
      ) : undefined,
  }),
  Grep: (a) => ({
    headline: (
      <>
        grep <code>{str(a.pattern, 60)}</code>
        {typeof a.path === 'string' && a.path ? (
          <>
            {' '}
            in <code>{path(a.path)}</code>
          </>
        ) : null}
        {typeof a.glob === 'string' && a.glob ? (
          <>
            {' '}
            · glob <code>{a.glob}</code>
          </>
        ) : null}
      </>
    ),
  }),
  Glob: (a) => ({
    headline: (
      <>
        glob <code>{str(a.pattern, 60)}</code>
        {typeof a.path === 'string' && a.path ? (
          <>
            {' '}
            in <code>{path(a.path)}</code>
          </>
        ) : null}
      </>
    ),
  }),
  WebFetch: (a) => ({
    headline: (
      <>
        fetch <code>{str(a.url, 80)}</code>
      </>
    ),
    body:
      typeof a.prompt === 'string' && a.prompt ? (
        <div className="tool-note">{str(a.prompt, 200)}</div>
      ) : undefined,
  }),
  WebSearch: (a) => ({
    headline: (
      <>
        search <code>"{str(a.query, 80)}"</code>
      </>
    ),
  }),
  Task: (a) => ({
    headline: (
      <>
        delegate to <code>{str(a.subagent_type, 30) || 'sub-agent'}</code>
      </>
    ),
    body:
      typeof a.description === 'string' && a.description ? (
        <div className="tool-note">{str(a.description, 200)}</div>
      ) : undefined,
  }),
  TodoWrite: (a) => {
    const todos = Array.isArray(a.todos) ? (a.todos as Args[]) : []
    return {
      headline: (
        <>
          todo list <span className="dim">({todos.length} items)</span>
        </>
      ),
      body:
        todos.length > 0 ? (
          <ul className="todo-list">
            {todos.slice(0, 8).map((t, i) => {
              const status = String(t.status ?? 'pending')
              const mark = status === 'completed' ? '✓' : status === 'in_progress' ? '…' : '·'
              // biome-ignore lint/suspicious/noArrayIndexKey: list is stable for a captured action
              return (
                <li key={i} className={`todo-${status}`}>
                  {mark} {String(t.content ?? '')}
                </li>
              )
            })}
            {todos.length > 8 ? <li className="dim">+ {todos.length - 8} more</li> : null}
          </ul>
        ) : undefined,
    }
  },
  NotebookEdit: (a) => ({
    headline: (
      <>
        notebook edit <code>{path(a.notebook_path)}</code>
      </>
    ),
  }),

  // ── OpenClaw lowercase variants ──────────────────────────────
  read: (a) => ({
    headline: (
      <>
        read <code>{path(a.path)}</code>
      </>
    ),
  }),
  write: (a) => ({
    headline: (
      <>
        write <code>{path(a.path)}</code>{' '}
        <span className="dim">({lines(a.content ?? a.text)} lines)</span>
      </>
    ),
  }),
  edit: (a) => ({
    headline: (
      <>
        edit <code>{path(a.path)}</code>
      </>
    ),
  }),
  exec: (a) => ({
    headline: (
      <>
        exec <span className="cmd">{str(a.command ?? a.script, 120)}</span>
      </>
    ),
  }),
  process: (a) => ({
    headline: (
      <>
        process <span className="dim">{str(a.action, 40)}</span>
      </>
    ),
  }),
  web_search: (a) => ({
    headline: (
      <>
        search <code>"{str(a.query, 80)}"</code>
      </>
    ),
  }),
  web_fetch: (a) => ({
    headline: (
      <>
        fetch <code>{str(a.url, 80)}</code>
      </>
    ),
  }),
  sessions_spawn: (a) => ({
    headline: (
      <>
        spawn <code>{str(a.persona ?? a.type, 30) || 'sub-session'}</code>
      </>
    ),
    body:
      typeof a.prompt === 'string' && a.prompt ? (
        <div className="tool-note">{str(a.prompt, 200)}</div>
      ) : undefined,
  }),

  // ── Hermes ───────────────────────────────────────────────────
  read_file: (a) => ({
    headline: (
      <>
        read <code>{path(a.path)}</code>
      </>
    ),
  }),
  write_file: (a) => ({
    headline: (
      <>
        write <code>{path(a.path)}</code>{' '}
        <span className="dim">({lines(a.content ?? a.text)} lines)</span>
      </>
    ),
  }),
  patch: (a) => ({
    headline: (
      <>
        patch <code>{path(a.path)}</code>
      </>
    ),
  }),
  search_files: (a) => ({
    headline: (
      <>
        search files <code>{str(a.query ?? a.pattern, 60)}</code>
      </>
    ),
  }),
  terminal: (a) => ({
    headline: (
      <>
        terminal <span className="cmd">{str(a.command ?? a.script, 120)}</span>
      </>
    ),
  }),
  image_generate: (a) => ({
    headline: (
      <>
        generate image <code>"{str(a.prompt, 80)}"</code>
      </>
    ),
  }),
  send_message: (a) => ({
    headline: (
      <>
        send → <code>{str(a.to ?? a.recipient ?? a.channel, 60)}</code>
      </>
    ),
    body:
      typeof a.content === 'string' && a.content ? (
        <div className="tool-note">{str(a.content, 200)}</div>
      ) : undefined,
  }),
  delegate_task: (a) => ({
    headline: (
      <>
        delegate to <code>{str(a.agent ?? a.target, 30)}</code>
      </>
    ),
    body:
      typeof a.task === 'string' && a.task ? (
        <div className="tool-note">{str(a.task, 200)}</div>
      ) : undefined,
  }),
  cronjob: (a) => ({
    headline: (
      <>
        cron <span className="dim">{str(a.action ?? a.op, 40)}</span>{' '}
        <code>{str(a.name ?? a.cron, 40)}</code>
      </>
    ),
  }),
}

export function renderTool(name: string, input: unknown): ToolRender {
  const args = (input && typeof input === 'object' ? input : {}) as Args
  const fn = RENDERERS[name]
  if (fn) return fn(args)

  // Generic fallback: tidy key/value listing
  const keys = Object.keys(args).slice(0, 8)
  return {
    headline: (
      <>
        <code>{name}</code> <span className="dim">({keys.length} args)</span>
      </>
    ),
    body:
      keys.length > 0 ? (
        <dl className="tool-args">
          {keys.map((k) => {
            const v = args[k]
            let display: ReactNode
            if (typeof v === 'string') display = str(v, 120)
            else if (typeof v === 'number' || typeof v === 'boolean') display = String(v)
            else if (Array.isArray(v)) display = <span className="dim">[{v.length} items]</span>
            else if (v == null) display = <span className="dim">—</span>
            else
              display = <span className="dim">{`{${Object.keys(v).slice(0, 3).join(', ')}}`}</span>
            return (
              <span className="tool-arg" key={k}>
                <span className="tool-arg-key">{k}:</span>{' '}
                <span className="tool-arg-val">{display}</span>
              </span>
            )
          })}
        </dl>
      ) : undefined,
  }
}

function trimMiddle(s: string, maxLines: number): string {
  const all = s.split('\n')
  if (all.length <= maxLines) return s
  const head = all.slice(0, Math.ceil(maxLines / 2)).join('\n')
  const tail = all.slice(-Math.floor(maxLines / 2)).join('\n')
  return `${head}\n  … (${all.length - maxLines} more lines)\n${tail}`
}

/**
 * Parse the body of a tool_result block (or an inline ContentBlock
 * payload) into a structured render. Handles four shapes seen in real
 * traces:
 *
 *   1. Plain string output (e.g. Claude Code's `Bash` result)
 *   2. Array of {type: 'text', text}-like blocks
 *   3. JSON-stringified object — Hermes / OpenClaw exec tools encode
 *      shell results as `{"output": "...", "exit_code": 0, "error": null}`,
 *      web tools as `{"success": true, "url": "...", "title": "...",
 *      "snapshot": "..."}`, etc.
 *   4. Already-structured object (some agents return the object directly)
 *
 * Returns a ToolResult discriminated by `kind` so the UI can pick the
 * right card shape (shell / web / object / text). Never produces raw
 * JSON that has to be rendered as a <pre>.
 */
export type ToolResultRender =
  | { kind: 'shell'; output: string; exitCode: number | null; error: string | null }
  | { kind: 'web'; url: string; title: string; snapshot: string }
  | { kind: 'object'; entries: Array<[string, string]>; rest: number }
  | { kind: 'text'; text: string }

export function parseToolResult(content: unknown): ToolResultRender {
  // Unwrap content blocks: [{type:'text', text: '...'}] etc.
  let raw: unknown = content
  if (Array.isArray(content)) {
    raw = content
      .map((b: unknown) => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object' && 'text' in b)
          return String((b as { text: unknown }).text ?? '')
        return ''
      })
      .join('\n')
  }

  // String? Try JSON-parse first — many tools encode results as JSON
  // strings (Hermes terminal, OpenClaw exec, MCP tools/call return values).
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object') {
          return parseObjectResult(parsed as Record<string, unknown>)
        }
      } catch {
        // fall through to text
      }
    }
    return { kind: 'text', text: trimmed }
  }

  if (raw && typeof raw === 'object') {
    return parseObjectResult(raw as Record<string, unknown>)
  }

  return { kind: 'text', text: '' }
}

function parseObjectResult(obj: Record<string, unknown>): ToolResultRender {
  // Shell result: { output, exit_code, error } — Hermes terminal / OpenClaw exec
  if ('output' in obj || 'exit_code' in obj || 'exitCode' in obj || 'stderr' in obj) {
    const output =
      typeof obj.output === 'string' ? obj.output : typeof obj.stdout === 'string' ? obj.stdout : ''
    const exitCodeRaw = (obj.exit_code ?? obj.exitCode) as unknown
    const exitCode =
      typeof exitCodeRaw === 'number'
        ? exitCodeRaw
        : exitCodeRaw == null
          ? null
          : Number(exitCodeRaw)
    const error =
      typeof obj.error === 'string'
        ? obj.error
        : typeof obj.stderr === 'string' && obj.stderr
          ? (obj.stderr as string)
          : null
    return {
      kind: 'shell',
      output,
      exitCode: Number.isFinite(exitCode) ? (exitCode as number) : null,
      error,
    }
  }

  // Web result: { success, url, title, snapshot, ... }
  if ('url' in obj && ('title' in obj || 'snapshot' in obj || 'success' in obj)) {
    return {
      kind: 'web',
      url: typeof obj.url === 'string' ? obj.url : '',
      title: typeof obj.title === 'string' ? obj.title : '',
      snapshot:
        typeof obj.snapshot === 'string'
          ? obj.snapshot
          : typeof obj.content === 'string'
            ? obj.content
            : '',
    }
  }

  // Generic object: render as a flat list of key/value pairs, max 6.
  const entries: Array<[string, string]> = []
  for (const [k, v] of Object.entries(obj)) {
    if (entries.length >= 6) break
    let display: string
    if (typeof v === 'string') display = v
    else if (typeof v === 'number' || typeof v === 'boolean') display = String(v)
    else if (v == null) display = '—'
    else if (Array.isArray(v)) display = `[${v.length} items]`
    else display = '{…}'
    entries.push([k, display])
  }
  return { kind: 'object', entries, rest: Math.max(0, Object.keys(obj).length - entries.length) }
}
