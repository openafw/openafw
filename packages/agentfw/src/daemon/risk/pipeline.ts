import { logger } from '../../core/logger.ts'
import type { AgentPacket, RiskTag } from '../../core/packet.ts'
import { secretLeakTagger } from './secret-leak.ts'
import { shellPatternTagger } from './shell-pattern.ts'
import type { RiskTagger } from './types.ts'

// The agent-firewall detector pipeline. Each tagger inspects a decoded
// AgentPacket and returns risk tags; failures are isolated. New security
// detectors plug in here.
//
// why: the tool-result prompt-injection detector (./prompt-injection.ts) is
// intentionally not registered — it's a paid feature. The file is kept for when
// it's gated back on.
const TAGGERS: readonly RiskTagger[] = [shellPatternTagger, secretLeakTagger]

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
