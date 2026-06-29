import { logger } from '../../core/logger.ts'
import type { AgentPacket, RiskTag } from '../../core/packet.ts'
import { ogrGatewayTagger } from '../ogr/tagger.ts'
import { secretLeakTagger } from './secret-leak.ts'
import { shellPatternTagger } from './shell-pattern.ts'
import type { RiskTagger } from './types.ts'

// The agent-firewall detector pipeline. Each tagger inspects a decoded
// AgentPacket and returns risk tags; failures are isolated. New security
// detectors plug in here.
//
// `ogrGatewayTagger` is afw acting as the OGR `gateway` altitude: it normalizes
// the packet into GuardEvents, composes the gateway detectors per ~/.afw/
// ogr.policy.json, and folds the effective Verdict back as tags (observe-only).
//
// why: the tool-result prompt-injection detector (./prompt-injection.ts) is
// intentionally not registered — it's a paid feature. The file is kept for when
// it's gated back on.
const TAGGERS: readonly RiskTagger[] = [shellPatternTagger, secretLeakTagger, ogrGatewayTagger]

export function runRiskTaggers(packet: AgentPacket): RiskTag[] {
  const tags: RiskTag[] = []
  for (const t of TAGGERS) {
    try {
      const out = t(packet)
      if (out.length > 0) tags.push(...out)
    } catch (err) {
      logger.warn(`risk tagger threw: ${(err as Error).message}`)
    }
  }
  return tags
}
