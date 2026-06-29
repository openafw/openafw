// Observe-only OGR gateway tagger. Runs the gateway engine over a decoded
// packet and folds the effective GatewayDecision back into afw's RiskTag stream,
// so OGR verdicts flow through the existing trace / store / Guard-view UI without
// touching the wire. Wire enforcement (block = rewrite response, redact = reuse
// the masking pass, require_approval = hold) is a deliberate second step.

import type { AgentPacket, ModelCallPayload, RiskTag } from '../../core/packet.ts'
import { protocolOf, toNormRequest } from './adapt.ts'
import { type GatewayDecision, GatewayEngine } from './engine.ts'
import { loadOgrPolicy } from './policy.ts'
import type { Decision } from './types.ts'

const SEVERITY: Record<Decision, RiskTag['severity']> = {
  block: 'high',
  require_approval: 'high',
  redact: 'warn',
  modify: 'warn',
  allow: 'info',
}

export function ogrGatewayTagger(packet: AgentPacket): RiskTag[] {
  if (packet.payload.kind !== 'model_call') return []
  const p = packet.payload as ModelCallPayload

  const engine = new GatewayEngine(loadOgrPolicy())
  const now = new Date(packet.ts).toISOString()
  const req = engine.inspectRequest(toNormRequest(p, packet.threadId), now)

  // The completion afw is relaying back is itself a gateway-observed event;
  // reuse the request's guardId so both altitudes correlate as one action.
  const res = engine.inspectResponse(responseText(p), {
    protocol: protocolOf(p),
    guardId: req.guardId,
    now,
  })

  return [...toTags(req), ...toTags(res)]
}

function toTags(d: GatewayDecision): RiskTag[] {
  if (d.decision === 'allow') return []
  const categories = d.verdicts.flatMap((v) => v.categories ?? []).map((c) => c.id)
  return [
    {
      tag: `ogr:${d.decision}`,
      severity: SEVERITY[d.decision],
      detail: {
        guardId: d.guardId,
        categories: [...new Set(categories)],
        reasons: d.reasons,
        redactions: d.redactions.length,
      },
    },
  ]
}

function responseText(p: ModelCallPayload): string {
  const parts: string[] = []
  for (const b of p.response) {
    if (b.type === 'text') parts.push(b.text)
  }
  return parts.join('\n')
}
