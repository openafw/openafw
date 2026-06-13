import type { AgentId } from '../../core/agent.ts'
import { claudeCodeDetector } from './claude-code.ts'
import { claudeDesktopDetector } from './claude-desktop.ts'
import { codexDetector } from './codex.ts'
import { hermesDetector } from './hermes.ts'
import { openclawDetector } from './openclaw.ts'
import type { Detection, Detector } from './types.ts'

/**
 * Order matters for UX (output order in `agentfw wire`). High-confidence
 * detectors first.
 */
export const DETECTORS: readonly Detector[] = [
  claudeCodeDetector,
  claudeDesktopDetector,
  codexDetector,
  openclawDetector,
  hermesDetector,
  // opencodeDetector,    // future
]

export function detectorFor(agent: AgentId): Detector | undefined {
  return DETECTORS.find((d) => d.agent === agent)
}

export async function detectAll(
  opts: { only?: AgentId[] } = {},
): Promise<Detection[]> {
  const targets = opts.only
    ? DETECTORS.filter((d) => opts.only?.includes(d.agent))
    : DETECTORS

  const results = await Promise.all(targets.map((d) => d.detect()))
  return results.filter((d): d is Detection => d !== null)
}
