// Best-effort secret redaction for shared reports. Conservative — patterns
// here only match formats that are unambiguously credentials. False
// positives (e.g. random hex that happens to look like an AWS key) cost
// the user nothing; misses cost them a leak.

const PATTERNS: RegExp[] = [
  /sk-ant-[a-zA-Z0-9_-]{40,}/g, // Anthropic API key
  /sk-[a-zA-Z0-9]{20,}/g, // Generic sk- key (OpenAI, etc.)
  /(?<=Bearer\s+)[A-Za-z0-9._\-=]{20,}/g, // Bearer tokens (preserve "Bearer " prefix)
  /AKIA[0-9A-Z]{16}/g, // AWS access key ID
  /ghp_[a-zA-Z0-9]{30,}/g, // GitHub personal access token
  /gho_[a-zA-Z0-9]{30,}/g, // GitHub OAuth token
  /ghs_[a-zA-Z0-9]{30,}/g, // GitHub server token
  /xox[baprs]-[a-zA-Z0-9-]{10,}/g, // Slack tokens
  /AIza[0-9A-Za-z_-]{35}/g, // Google API key
]

export function redactString(s: string): string {
  let out = s
  for (const p of PATTERNS) out = out.replace(p, '[REDACTED]')
  return out
}

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v)
    }
    return out as T
  }
  return value
}
