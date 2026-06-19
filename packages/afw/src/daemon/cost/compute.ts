import type { DecoderKind } from '../../core/routes.ts'
import { pricingFor } from './pricing.ts'

export type CostInput = {
  decoder: DecoderKind
  model: string
  /** Fresh (non-cache-hit) input only — decoders normalize at write time. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export function computeCost(input: CostInput): number {
  const p = pricingFor(input.decoder, input.model)
  if (!p) return 0

  const cacheReadRate = p.cacheReadCostPerToken ?? p.inputCostPerToken
  const cacheWriteRate = p.cacheWriteCostPerToken ?? p.inputCostPerToken
  const cacheRead = input.cacheReadTokens ?? 0
  const cacheWrite = input.cacheWriteTokens ?? 0

  return (
    input.inputTokens * p.inputCostPerToken +
    input.outputTokens * p.outputCostPerToken +
    cacheRead * cacheReadRate +
    cacheWrite * cacheWriteRate
  )
}
