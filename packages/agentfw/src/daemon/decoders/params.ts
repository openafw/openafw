// Generation parameters of a decoded request — every top-level field
// except the bulky content (messages / input / system / instructions /
// tools) and the fields captured on their own (model / stream). What's
// left is temperature, max_tokens, top_p, top_k, stop_sequences, the
// reasoning settings, tool_choice, and whatever else the agent sent —
// surfaced verbatim in the Run view.

const OMIT = new Set([
  'messages',
  'input',
  'system',
  'instructions',
  'tools',
  'model',
  'stream',
])

export function extractRequestParams(
  req: unknown,
): Record<string, unknown> | undefined {
  if (!req || typeof req !== 'object' || Array.isArray(req)) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(req as Record<string, unknown>)) {
    if (OMIT.has(k) || v === undefined) continue
    out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}
