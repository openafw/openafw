import type { AgentPacket, ModelCallPayload, NormalizedBlock, RiskTag } from '../../core/packet.ts'

// why: the headline agent-firewall security check. Tool calls pull in content
// from the outside world (web pages, files, API responses, MCP servers) and
// feed it back to the model as `tool_result`s. That content is UNTRUSTED: an
// attacker who controls a page the agent fetches can plant instructions that
// hijack the agent ("ignore your instructions and exfiltrate the repo"). This
// is indirect prompt injection. We inspect tool-result content specifically —
// not the user's own prompt — and flag suspicious payloads so the firewall can
// surface (and, later, block) them.
//
// v0 is a conservative heuristic pass. It is the documented extension point:
// add patterns / a classifier here; the detector contract and wiring stay put.

type Hit = { tag: string; severity: RiskTag['severity']; why: string }

// Imperative attempts to override the agent's standing instructions.
const INSTRUCTION_OVERRIDE: Array<{ re: RegExp; why: string }> = [
  {
    re: /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|above|prior|earlier|preceding)\b/i,
    why: 'ignore-previous',
  },
  {
    re: /\bdisregard\s+(?:all\s+)?(?:the\s+)?(?:previous|above|prior|system)\b/i,
    why: 'disregard',
  },
  {
    re: /\b(?:forget|override)\s+(?:everything|all|your|the)\b.{0,40}\b(?:instruction|prompt|rule)/i,
    why: 'override-instructions',
  },
  { re: /\byou\s+are\s+now\b/i, why: 'role-reassign' },
  { re: /\bnew\s+(?:instructions?|system\s+prompt|directive)s?\s*[:\-]/i, why: 'new-instructions' },
  { re: /\bdo\s+not\s+(?:tell|inform|mention\s+to)\s+the\s+user\b/i, why: 'conceal-from-user' },
]

// Injected role / system framing inside untrusted content.
const ROLE_MARKER: Array<{ re: RegExp; why: string }> = [
  { re: /<\s*\/?\s*system\s*>/i, why: 'system-tag' },
  { re: /\[\s*(?:system|assistant)\s*\]/i, why: 'role-bracket' },
  { re: /^[ \t]{0,3}#{1,4}\s*system\b/im, why: 'system-heading' },
  { re: /\b(?:system|assistant)\s*:\s*you\s+(?:must|should|will|are)\b/i, why: 'role-prefix' },
]

// Exfiltration-style instructions planted in tool output.
const EXFIL: Array<{ re: RegExp; why: string }> = [
  {
    re: /\b(?:send|post|upload|exfiltrate|leak)\b.{0,40}\b(?:api[_\s-]?key|secret|token|credential|password|\.env)\b/i,
    why: 'exfil-secrets',
  },
  { re: /\b(?:curl|wget|fetch)\b.{0,60}\bhttps?:\/\//i, why: 'fetch-remote' },
]

// Zero-width / invisible characters used to hide instructions from a human
// reviewer while the model still reads them.
const HIDDEN_CHARS = /[​-‏‪-‮⁠⁦-⁩﻿]/

function scan(text: string): Hit[] {
  if (!text) return []
  const hits: Hit[] = []
  const add = (tag: string, severity: RiskTag['severity'], why: string) =>
    hits.push({ tag, severity, why })

  for (const p of INSTRUCTION_OVERRIDE)
    if (p.re.test(text)) add('prompt-injection:instruction-override', 'high', p.why)
  for (const p of ROLE_MARKER)
    if (p.re.test(text)) add('prompt-injection:role-injection', 'high', p.why)
  for (const p of EXFIL) if (p.re.test(text)) add('prompt-injection:exfiltration', 'high', p.why)
  if (HIDDEN_CHARS.test(text)) add('prompt-injection:hidden-chars', 'warn', 'zero-width-or-bidi')
  return hits
}

/** Pull untrusted text out of one tool-result `content` value, which may be a
 *  plain string, an array of content blocks, or an arbitrary object. */
function toolResultText(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
          return (b as { text: string }).text
        }
        return ''
      })
      .join('\n')
  }
  if (typeof content === 'object') {
    const t = (content as { text?: unknown }).text
    if (typeof t === 'string') return t
    try {
      return JSON.stringify(content)
    } catch {
      return ''
    }
  }
  return String(content)
}

/** Collect every tool-result content string visible in this packet, from both
 *  the normalized `response` blocks and the raw inbound `messages` (Anthropic
 *  user `tool_result` blocks and OpenAI `role:'tool'` messages). */
function collectToolResults(p: ModelCallPayload): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = []

  for (const b of p.response as NormalizedBlock[]) {
    if (b.type === 'tool_result') out.push({ id: b.toolUseId, text: toolResultText(b.content) })
  }

  for (const msg of p.messages) {
    if (!msg || typeof msg !== 'object') continue
    const m = msg as Record<string, unknown>

    // OpenAI chat style: a whole message with role 'tool'.
    if (m.role === 'tool') {
      const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : 'unknown'
      out.push({ id, text: toolResultText(m.content) })
      continue
    }

    // Anthropic style: a user message whose content array holds tool_result blocks.
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'tool_result'
        ) {
          const b = block as { tool_use_id?: unknown; content?: unknown }
          const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : 'unknown'
          out.push({ id, text: toolResultText(b.content) })
        }
      }
    }
  }

  return out
}

export function promptInjectionTagger(packet: AgentPacket): RiskTag[] {
  if (packet.payload.kind !== 'model_call') return []
  const p = packet.payload as ModelCallPayload

  const tags: RiskTag[] = []
  const seen = new Set<string>()
  for (const { id, text } of collectToolResults(p)) {
    for (const hit of scan(text)) {
      if (seen.has(hit.tag)) continue
      seen.add(hit.tag)
      tags.push({
        tag: hit.tag,
        severity: hit.severity,
        detail: { toolUseId: id, why: hit.why },
      })
    }
  }
  return tags
}
