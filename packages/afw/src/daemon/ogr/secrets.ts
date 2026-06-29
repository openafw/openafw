// Credential / PII shapes. Matches feed redaction spans (label + match), not
// just a boolean — the engine recomputes the spans to mask from this single
// source so a `redact` verdict can be enforced on the wire. Ported from the
// reference gateway (openguardrails-gateway/ogr_gateway/detectors.py); kept
// separate from risk/secret-leak.ts, which only DETECTS (no masking).

export type SecretHit = { label: string; match: string }

const SECRET_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'openai-api-key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { label: 'anthropic-api-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
  { label: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { label: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { label: 'google-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { label: 'private-key', re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
]

export function findSecrets(text: string): SecretHit[] {
  if (!text) return []
  const out: SecretHit[] = []
  for (const { label, re } of SECRET_PATTERNS) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) out.push({ label, match: m[0] })
  }
  return out
}
