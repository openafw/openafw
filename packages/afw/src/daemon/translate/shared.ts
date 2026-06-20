// Defensive accessors shared by the protocol translators. Every translator
// input is untrusted third-party JSON, so each field read is guarded.

// biome-ignore lint/suspicious/noExplicitAny: third-party JSON payloads.
export type Any = any

export function asObject(v: unknown): Any {
  return v != null && typeof v === 'object' ? (v as Any) : {}
}

/** A non-empty string, or undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** A finite number, or the fallback (default 0). */
export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** A finite number, or undefined. */
export function optNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Parse a tool-call `arguments` value: a JSON string, an object, or absent. */
export function parseToolArgs(raw: unknown): unknown {
  if (raw == null) return {}
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

/** Serialize a tool-call input back to the JSON-string form OpenAI expects. */
export function stringifyToolArgs(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input ?? {})
  } catch {
    return '{}'
  }
}

// ── codex's `local_shell` built-in ────────────────────────────────
//
// Codex ships its shell capability as the OpenAI Responses *built-in*
// `local_shell` tool — `{type:"local_shell"}`, an object with a type but no
// `name`. Chat Completions has no built-in equivalent, so to route codex to a
// chat-completions backend we expose it as an ordinary function tool the model
// can call, and turn the model's call back into the `local_shell_call` item
// codex expects on the response. The shared name keeps that round-trip stable
// across the parser (from-openai-responses) and serializer (to-openai-responses).

export const LOCAL_SHELL_TOOL = 'local_shell'

/** Function-tool JSON schema mirroring `local_shell`'s exec action — an argv
 *  array plus the optional working-directory / timeout codex passes through. */
export const LOCAL_SHELL_SCHEMA = {
  type: 'object',
  properties: {
    command: {
      type: 'array',
      items: { type: 'string' },
      description: 'The command to run as an argv array, e.g. ["bash","-lc","ls -la"].',
    },
    workdir: { type: 'string', description: 'Working directory for the command.' },
    timeout_ms: { type: 'number', description: 'Timeout in milliseconds.' },
  },
  required: ['command'],
} as const

/** A `local_shell_call` action → the function-call input we hand the chat
 *  backend. Keeps `command` plus whatever optional knobs were present. */
export function shellActionToInput(action: unknown): Record<string, unknown> {
  const a = asObject(action)
  const input: Record<string, unknown> = {}
  if (Array.isArray(a.command) || typeof a.command === 'string') input.command = a.command
  const workdir = a.workdir ?? a.working_directory
  if (typeof workdir === 'string') input.workdir = workdir
  if (typeof a.timeout_ms === 'number') input.timeout_ms = a.timeout_ms
  return input
}

/** The chat backend's function-call input → a `local_shell_call` exec action,
 *  the shape codex consumes. Tolerates a `command` given as a string. */
export function inputToShellAction(input: unknown): Record<string, unknown> {
  const i = typeof input === 'string' ? safeJson(input) : asObject(input)
  const command = Array.isArray(i.command)
    ? i.command
    : typeof i.command === 'string'
      ? ['bash', '-lc', i.command]
      : []
  const action: Record<string, unknown> = { type: 'exec', command }
  const workdir = i.workdir ?? i.working_directory
  if (typeof workdir === 'string') action.working_directory = workdir
  if (typeof i.timeout_ms === 'number') action.timeout_ms = i.timeout_ms
  return action
}

function safeJson(raw: string): Any {
  try {
    return asObject(JSON.parse(raw))
  } catch {
    return {}
  }
}
