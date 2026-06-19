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
