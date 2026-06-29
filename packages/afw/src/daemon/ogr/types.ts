// OGR core contract types (spec v0.1, openguardrails/openguardrails-spec):
// GuardEvent → Verdict, composed into one effective decision the interception
// point enforces. afw is the `gateway` observation point — it is the only
// altitude that sees the raw LLM protocol on the wire.

export const OGR_VERSION = '0.1'

export type ObservationPoint = 'gateway' | 'agent_hook' | 'sandbox'

export type GuardEventKind =
  | 'user_input'
  | 'model_input'
  | 'model_output'
  | 'tool_register'
  | 'mcp_connect'
  | 'skill_load'
  | 'tool_call'
  | 'tool_result'
  | 'exec'
  | 'network'
  | 'file'

export type LlmProtocol = 'openai.chat' | 'openai.responses' | 'anthropic.messages'

export type Trust = 'trusted' | 'untrusted' | 'unverified' | 'model'

export type Provenance = {
  source: string
  trust: Trust
  ref?: string
  taintTags?: string[]
}

export type GuardEvent = {
  ogrVersion: string
  eventId: string
  guardId: string
  sessionId?: string
  timestamp: string
  observationPoint: ObservationPoint
  kind: GuardEventKind
  subject: Record<string, unknown>
  payload: Record<string, unknown>
  provenance?: Provenance[]
  llmProtocol?: LlmProtocol | null
  contextRefs?: string[]
}

// allow ⊃ modify ⊃ redact ⊃ require_approval ⊃ block, ordered by severity:
// the most severe verdict across detectors wins (lowest rank).
export type Decision = 'allow' | 'modify' | 'redact' | 'require_approval' | 'block'

export type Category = {
  id: string
  domain: 'safety' | 'security'
  score: number
}

export type Verdict = {
  ogrVersion: string
  eventId: string
  guardId: string
  provider: string
  decision: Decision
  categories?: Category[]
  reasons?: string[]
  evidence?: Array<Record<string, unknown>>
  latencyMs?: number
  confidence?: number
}

const RANK: Record<Decision, number> = {
  block: 0,
  require_approval: 1,
  redact: 2,
  modify: 3,
  allow: 4,
}

export function severity(d: Decision): number {
  return RANK[d]
}

/** Return whichever decision is more severe (lower rank). */
export function tighten(current: Decision, candidate: Decision): Decision {
  return severity(current) <= severity(candidate) ? current : candidate
}

/** redact / modify still forward upstream (after edits); allow forwards as-is. */
export function isAllowed(d: Decision): boolean {
  return d === 'allow' || d === 'modify' || d === 'redact'
}
