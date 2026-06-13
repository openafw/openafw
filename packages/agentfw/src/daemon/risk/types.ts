import type { AgentPacket, RiskTag } from '../../core/packet.ts'

export type RiskTagger = (packet: AgentPacket) => RiskTag[]
