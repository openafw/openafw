// Decide whether to lower Claude Code's auto-compaction window to match a
// smaller routed model. Claude Code sizes context for the window it thinks the
// model has (200k); routed to a smaller third-party model it only compacts near
// 200k and overflows the real window. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` lets us
// lower that — but set too aggressively it compacts on the very first prompt
// (the baseline system prompt + tool schemas + project files already exceed the
// threshold). So we only inject it when the model's compaction threshold sits
// comfortably above the observed baseline. The pure decision lives here so the
// gate is unit-tested without spawning anything.

/** Claude Code's default context window for known models. Above this there's
 *  nothing to gain from lowering — we only ever shrink toward a smaller model. */
export const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000

/** Tokens Claude Code holds back below the window before auto-compacting: a
 *  ~20k summary reservation plus a ~13k buffer (see Claude Code's autoCompact —
 *  effectiveWindow = window − 20k, threshold = effectiveWindow − 13k). */
export const COMPACT_RESERVE_TOKENS = 33_000

/** Required room between the baseline and the compaction threshold. Without it
 *  a conversation would compact after barely a turn — churny and pointless. */
export const COMPACT_HEADROOM_TOKENS = 20_000

export type AutoCompactDecision =
  | { inject: true; window: number }
  | {
      inject: false
      reason: 'no-smaller-window' | 'no-baseline' | 'baseline-too-high'
      threshold?: number
      baselineTokens?: number
    }

/** Decide the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` value to inject for a routed
 *  Claude Code launch, or why we're leaving it unset. */
export function decideAutoCompactWindow(opts: {
  /** The routed model's configured total context window, if any. */
  contextWindow?: number
  /** Smallest model-call input the daemon has seen for this agent; null when
   *  there's no traffic yet. */
  baselineTokens: number | null
}): AutoCompactDecision {
  const { contextWindow, baselineTokens } = opts

  // Only act for a genuinely smaller third-party window.
  if (contextWindow == null || contextWindow >= CLAUDE_DEFAULT_CONTEXT_WINDOW) {
    return { inject: false, reason: 'no-smaller-window' }
  }

  // No observed baseline yet — stay hands-off. New conversations are handled by
  // the output-budget clamp, and by the time a conversation is long enough to
  // need compaction the daemon will have data to gate on.
  if (baselineTokens == null) {
    return { inject: false, reason: 'no-baseline' }
  }

  const threshold = contextWindow - COMPACT_RESERVE_TOKENS
  if (threshold < baselineTokens + COMPACT_HEADROOM_TOKENS) {
    // Lowering the window would compact on (or right after) the first prompt.
    return { inject: false, reason: 'baseline-too-high', threshold, baselineTokens }
  }

  return { inject: true, window: contextWindow }
}
