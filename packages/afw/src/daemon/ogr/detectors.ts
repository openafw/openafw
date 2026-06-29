// Gateway-altitude reference detectors. Each accepts a GuardEvent and returns a
// Verdict — the OGR contract a security vendor plugs into. A detector that finds
// nothing MUST return an explicit `allow` (abstention), never silence. Ported
// from openguardrails-gateway/ogr_gateway/detectors.py.

import type { ConfigRules, ContentRules } from './policy.ts'
import { findSecrets } from './secrets.ts'
import {
  type Category,
  type Decision,
  type GuardEvent,
  type GuardEventKind,
  OGR_VERSION,
  type Verdict,
  tighten,
} from './types.ts'

export type Detector = {
  provider: string
  handles: GuardEventKind[]
  evaluate: (ev: GuardEvent) => Verdict
}

// Trust labels that mean "the gateway did not author this text".
const RISKY_TRUST = new Set(['untrusted', 'unverified'])

const INJECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  {
    re: /ignore\s+(all|any|the)?\s*(previous|prior|above)\s+(instructions|prompts?)/i,
    label: 'instruction-override',
  },
  {
    re: /disregard\s+(the\s+)?(system|above)\s+(prompt|instructions)/i,
    label: 'system-prompt-override',
  },
  {
    re: /\byou\s+are\s+now\b.*\b(DAN|jailbreak|developer\s+mode)\b/i,
    label: 'jailbreak-roleswap',
  },
  {
    re: /(reveal|print|repeat)\s+(your|the)\s+(system\s+)?(prompt|instructions)/i,
    label: 'system-prompt-exfil',
  },
]

type Segment = { trust: string; text: string }

function baseVerdict(ev: GuardEvent, provider: string): Verdict {
  return {
    ogrVersion: OGR_VERSION,
    eventId: ev.eventId,
    guardId: ev.guardId,
    provider,
    decision: 'allow',
  }
}

function segments(ev: GuardEvent): Segment[] {
  if (ev.kind === 'model_input') {
    const msgs = (ev.payload.messages as Array<{ trust?: string; content?: string }>) ?? []
    return msgs.map((m) => ({ trust: m.trust ?? 'unverified', text: m.content ?? '' }))
  }
  // model_output — the completion is authored by the model.
  return [{ trust: 'model', text: (ev.payload.text as string) ?? '' }]
}

/** Inspects model_input / model_output text for injection and secret leakage. */
export function contentGuardDetector(cfg: ContentRules): Detector {
  return {
    provider: 'afw.gateway.content_guard',
    handles: ['model_input', 'model_output'],
    evaluate(ev) {
      const t0 = performance.now()
      const v = baseVerdict(ev, 'afw.gateway.content_guard')
      const cats: Category[] = []
      const reasons: string[] = []
      const evidence: Array<Record<string, unknown>> = []
      let decision: Decision = 'allow'

      for (const { trust, text } of segments(ev)) {
        if (!text) continue

        // Prompt injection is only meaningful from text the gateway didn't author.
        if (RISKY_TRUST.has(trust)) {
          for (const { re, label } of INJECTION_PATTERNS) {
            if (re.test(text)) {
              const want =
                trust === 'untrusted' ? cfg.injectionFromUntrusted : cfg.injectionFromUnverified
              decision = tighten(decision, want)
              cats.push({ id: 'security.prompt_injection', domain: 'security', score: 0.92 })
              reasons.push(`injection pattern '${label}' in ${trust} content`)
            }
          }
        }

        // Secret / credential leakage — any segment, inbound or outbound.
        for (const hit of findSecrets(text)) {
          decision = tighten(decision, cfg.redactSecrets ? 'redact' : 'block')
          cats.push({ id: 'security.secret_leak', domain: 'security', score: 0.95 })
          reasons.push(`${hit.label} present in ${trust} text`)
          evidence.push({ type: 'redact', ...hit })
        }
      }

      v.decision = decision
      v.categories = cats
      v.reasons = reasons.length > 0 ? reasons : ['no content finding']
      v.evidence = evidence
      v.latencyMs = Math.round((performance.now() - t0) * 1000) / 1000
      return v
    },
  }
}

/** Deterministic command-rule detector — judges any tool_call carried on the
 *  wire, identical to the agent-hook altitude. */
export function configRulesDetector(cfg: ConfigRules): Detector {
  const rules = cfg.commandRules.map((r) => ({ ...r, re: new RegExp(r.regex, 'i') }))
  return {
    provider: 'afw.gateway.config_rules',
    handles: ['tool_call', 'exec'],
    evaluate(ev) {
      const t0 = performance.now()
      const v = baseVerdict(ev, 'afw.gateway.config_rules')
      const cats: Category[] = []
      const reasons: string[] = []
      let decision: Decision = 'allow'

      const text = argumentsText(ev)
      for (const r of rules) {
        if (r.re.test(text)) {
          decision = tighten(decision, r.decision)
          cats.push({ id: r.category, domain: r.domain, score: r.score })
          reasons.push(`[${r.id}] ${r.why}`)
        }
      }

      v.decision = decision
      v.categories = cats
      v.reasons = reasons.length > 0 ? reasons : ['no rule matched']
      v.latencyMs = Math.round((performance.now() - t0) * 1000) / 1000
      return v
    },
  }
}

// Test rules against the raw string leaves of the arguments, not a JSON
// envelope — a rule like `rm -rf /(\s|$)` must see the bare command, not
// `…/"}`. Includes the tool name so name-based rules still fire.
function argumentsText(ev: GuardEvent): string {
  const parts: string[] = []
  if (typeof ev.payload.name === 'string') parts.push(ev.payload.name)
  collectStrings(ev.payload.arguments, parts)
  return parts.join('\n')
}

function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') {
    out.push(v)
  } else if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out)
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v)) collectStrings(x, out)
  }
}
