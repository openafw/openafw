import type { AgentPacket, McpCallPayload, ModelCallPayload, RiskTag } from '../../core/packet.ts'

// Patterns for credential shapes that are unambiguous enough to flag.
// Mirrors src/cli/format/redact.ts but here we only DETECT (no masking).
const PATTERNS: Array<{ tag: string; re: RegExp }> = [
  { tag: 'secret:anthropic-key', re: /sk-ant-[a-zA-Z0-9_-]{40,}/ },
  { tag: 'secret:openai-key', re: /\bsk-[a-zA-Z0-9]{40,}\b/ },
  { tag: 'secret:bearer-token', re: /Bearer\s+[A-Za-z0-9._\-=]{20,}/ },
  { tag: 'secret:github-pat', re: /\b(?:ghp|gho|ghs|ghr)_[a-zA-Z0-9]{30,}\b/ },
  { tag: 'secret:aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { tag: 'secret:slack-token', re: /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/ },
  { tag: 'secret:google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
]

export function secretLeakTagger(packet: AgentPacket): RiskTag[] {
  const text = collectText(packet)
  if (!text) return []

  const tags: RiskTag[] = []
  const seen = new Set<string>()
  for (const p of PATTERNS) {
    const m = text.match(p.re)
    if (m && !seen.has(p.tag)) {
      seen.add(p.tag)
      // Don't include the full match in detail — that would write the secret
      // to the trace. Short prefix only so the user can locate it.
      tags.push({
        tag: p.tag,
        severity: 'high',
        detail: { prefix: m[0].slice(0, 6) },
      })
    }
  }
  return tags
}

function collectText(packet: AgentPacket): string {
  const parts: string[] = []
  if (packet.payload.kind === 'model_call') {
    const p = packet.payload as ModelCallPayload
    if (p.systemPrompt) parts.push(p.systemPrompt)
    safePush(parts, p.messages)
    for (const b of p.response) {
      if ('text' in b && typeof (b as { text: unknown }).text === 'string') {
        parts.push((b as { text: string }).text)
      }
      if ('input' in b) safePush(parts, (b as { input: unknown }).input)
    }
  } else if (packet.payload.kind === 'mcp_call') {
    const p = packet.payload as McpCallPayload
    if (p.params !== undefined) safePush(parts, p.params)
    if (p.result !== undefined) safePush(parts, p.result)
  }
  return parts.join('\n')
}

function safePush(parts: string[], v: unknown): void {
  try {
    parts.push(JSON.stringify(v))
  } catch {
    /* circular or unrepresentable; skip */
  }
}
