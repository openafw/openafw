// GatewayEngine — protocol-agnostic. Turns a normalized request/response into
// OGR GuardEvents (observationPoint="gateway"), runs them through the composed
// detectors, and returns one GatewayDecision the caller acts on. Protocol
// parsing lives in adapt.ts. Ported from openguardrails-gateway/ogr_gateway/engine.py.

import { type Detector, configRulesDetector, contentGuardDetector } from './detectors.ts'
import type { OgrPolicy } from './policy.ts'
import { type SecretHit, findSecrets } from './secrets.ts'
import {
  type Decision,
  type GuardEvent,
  type GuardEventKind,
  type LlmProtocol,
  OGR_VERSION,
  type Provenance,
  type Trust,
  type Verdict,
  isAllowed,
  severity,
} from './types.ts'

// Map a message role to (trust, taint). A gateway serves callers it does not
// fully trust, so `user` is "unverified"; tool/function output is "untrusted".
const ROLE_PROVENANCE: Record<string, { trust: Trust; taint: string[] }> = {
  system: { trust: 'trusted', taint: [] },
  developer: { trust: 'trusted', taint: [] },
  user: { trust: 'unverified', taint: [] },
  assistant: { trust: 'model', taint: [] },
  tool: { trust: 'untrusted', taint: ['tool_result'] },
  function: { trust: 'untrusted', taint: ['tool_result'] },
}

export type NormMessage = { role: string; content: string; toolCalls?: NormToolCall[] }
export type NormToolCall = { name: string; arguments: unknown }
export type NormRequest = {
  protocol?: LlmProtocol | null
  model?: string
  caller?: string
  sessionId?: string
  messages: NormMessage[]
}

export type GatewayDecision = {
  decision: Decision
  verdicts: Verdict[]
  redactions: SecretHit[]
  guardId: string
  /** Forward upstream (after any edits) vs. stop. */
  allowed: boolean
  /** `[provider] reason` lines from every non-allow verdict. */
  reasons: string[]
}

export class GatewayEngine {
  private readonly detectors: Detector[]
  private seq = 0

  constructor(policy: OgrPolicy) {
    // Detectors are stateless and shared; the effective-decision composition is
    // per call. ContentGuard is the gateway's own plane (messages, completion);
    // ConfigRules judges tool_calls exactly as the agent-hook altitude does.
    this.detectors = [
      contentGuardDetector(policy.contentRules),
      configRulesDetector(policy.configRules),
    ]
  }

  private id(prefix: string): string {
    this.seq += 1
    return `${prefix}-${this.seq.toString(36).padStart(4, '0')}`
  }

  private evaluate(ev: GuardEvent): Verdict[] {
    const out: Verdict[] = []
    for (const d of this.detectors) {
      if (!d.handles.includes(ev.kind)) continue
      out.push(d.evaluate(ev))
    }
    return out
  }

  /** Inspect the prompt + any tool calls on an outbound request. */
  inspectRequest(norm: NormRequest, now: string): GatewayDecision {
    const guardId = this.id('gw')
    const sessionId = norm.sessionId ?? this.id('sess')
    const verdicts: Verdict[] = []

    const msgs: Array<{ role: string; trust: Trust; content: string }> = []
    const provenance: Provenance[] = []
    for (const m of norm.messages) {
      const { trust, taint } = ROLE_PROVENANCE[m.role] ?? { trust: 'unverified', taint: [] }
      msgs.push({ role: m.role, trust, content: m.content })
      provenance.push({ source: m.role, trust, taintTags: [...taint] })
    }
    verdicts.push(
      ...this.evaluate(
        this.event('model_input', guardId, sessionId, now, {
          subject: { caller: norm.caller ?? 'anonymous', model: norm.model },
          payload: { messages: msgs, model: norm.model },
          protocol: norm.protocol,
          provenance,
        }),
      ),
    )

    // Tool calls proposed off the back of the prompt — judged by the SAME
    // ConfigRules detector the agent hook uses.
    for (const tc of toolCalls(norm)) {
      verdicts.push(
        ...this.evaluate(
          this.event('tool_call', guardId, sessionId, now, {
            subject: { caller: norm.caller ?? 'anonymous' },
            payload: { name: tc.name, arguments: tc.arguments },
            protocol: norm.protocol,
            provenance: [{ source: 'model', trust: 'unverified' }],
          }),
        ),
      )
    }

    const redactions = msgs.flatMap((m) => findSecrets(m.content))
    return this.decide(guardId, verdicts, redactions)
  }

  /** Inspect a completion coming back from the model. */
  inspectResponse(
    text: string,
    opts: { protocol?: LlmProtocol | null; guardId?: string; now: string },
  ): GatewayDecision {
    const guardId = opts.guardId ?? this.id('gw')
    const verdicts = this.evaluate(
      this.event('model_output', guardId, undefined, opts.now, {
        subject: {},
        payload: { text },
        protocol: opts.protocol,
        provenance: [{ source: 'model', trust: 'model' }],
      }),
    )
    return this.decide(guardId, verdicts, findSecrets(text))
  }

  private event(
    kind: GuardEventKind,
    guardId: string,
    sessionId: string | undefined,
    now: string,
    rest: {
      subject: Record<string, unknown>
      payload: Record<string, unknown>
      protocol?: LlmProtocol | null
      provenance?: Provenance[]
    },
  ): GuardEvent {
    return {
      ogrVersion: OGR_VERSION,
      eventId: this.id('evt'),
      guardId,
      sessionId,
      timestamp: now,
      observationPoint: 'gateway',
      kind,
      subject: rest.subject,
      payload: rest.payload,
      provenance: rest.provenance,
      llmProtocol: rest.protocol ?? null,
    }
  }

  private decide(guardId: string, verdicts: Verdict[], redactions: SecretHit[]): GatewayDecision {
    let effective: Decision = 'allow'
    for (const v of verdicts) {
      if (severity(v.decision) < severity(effective)) effective = v.decision
    }
    const reasons: string[] = []
    for (const v of verdicts) {
      if (v.decision !== 'allow' && v.reasons) {
        for (const r of v.reasons) reasons.push(`[${v.provider}] ${r}`)
      }
    }
    return {
      decision: effective,
      verdicts,
      redactions,
      guardId,
      allowed: isAllowed(effective),
      reasons,
    }
  }
}

function toolCalls(norm: NormRequest): NormToolCall[] {
  const out: NormToolCall[] = []
  for (const m of norm.messages) {
    for (const tc of m.toolCalls ?? []) out.push(tc)
  }
  return out
}

/** Apply redaction spans to text — replaces each secret match in place. */
export function applyRedactions(text: string, redactions: SecretHit[]): string {
  let out = text
  for (const r of redactions) out = out.split(r.match).join(`[REDACTED:${r.label}]`)
  return out
}
