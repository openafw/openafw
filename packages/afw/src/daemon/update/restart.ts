import { restartService } from '../../cli/service/index.ts'
import { logger } from '../../core/logger.ts'
import { inFlightCount } from '../proxy/inflight.ts'

export type QuietOptions = {
  // Continuous idle time (no in-flight requests) required before it is safe
  // to restart.
  quietMs?: number
  // Give up looking for a quiet window after this long.
  timeoutMs?: number
  pollMs?: number
}

const DEFAULTS = {
  quietMs: 3_000,
  timeoutMs: 10 * 60 * 1_000,
  pollMs: 500,
}

/**
 * Resolve true once there have been zero in-flight proxied requests for
 * `quietMs` continuously — a window in which restarting the daemon will not
 * drop an agent's model call. Resolve false if no such window appears before
 * `timeoutMs`; the caller decides whether to keep waiting or force.
 */
export async function waitForQuiet(opts: QuietOptions = {}): Promise<boolean> {
  const quietMs = opts.quietMs ?? DEFAULTS.quietMs
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs
  const pollMs = opts.pollMs ?? DEFAULTS.pollMs
  const deadline = Date.now() + timeoutMs
  let quietSince: number | null = null

  while (Date.now() < deadline) {
    if (inFlightCount() === 0) {
      quietSince ??= Date.now()
      if (Date.now() - quietSince >= quietMs) return true
    } else {
      quietSince = null
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return false
}

/**
 * Wait for a quiet window, then restart the daemon so it reloads the
 * freshly-installed code. With `force`, skip the wait. Returns false if no
 * quiet window was found and `force` was not set.
 */
export async function restartWhenQuiet(
  opts: QuietOptions & { force?: boolean } = {},
): Promise<boolean> {
  if (!opts.force) {
    const quiet = await waitForQuiet(opts)
    if (!quiet) {
      logger.warn('update: no quiet window found in time; deferring restart')
      return false
    }
  }
  logger.info('update: quiet window — restarting daemon')
  await restartService()
  return true
}
