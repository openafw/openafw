import { readConfig } from '../../core/config.ts'
import { logger } from '../../core/logger.ts'
import { applyUpdate } from './apply.ts'
import { checkForUpdate } from './check.ts'

const ONE_DAY_MS = 24 * 3_600_000

let timer: ReturnType<typeof setInterval> | null = null

/**
 * Daily background update check. Asks the npm registry whether a newer
 * version exists (a plain GET — no user data, never our servers) and caches
 * the answer for the dashboard banner / CLI hint to read.
 *
 * If the user has turned on auto-update, a found update is applied straight
 * away — but the restart still waits for a quiet window, so it never drops
 * an in-flight model call. Disabled entirely when config.updateCheck is off.
 */
export function startUpdateCheckLoop(): void {
  if (timer) return

  const tick = async (): Promise<void> => {
    try {
      const config = await readConfig()
      if (!config.updateCheck) return
      const state = await checkForUpdate()
      if (!state.available || !state.latestVersion) return
      logger.info(`update: ${state.latestVersion} is available (current ${state.currentVersion})`)
      if (config.autoUpdate) {
        logger.info(`update: auto-update is on — applying ${state.latestVersion}`)
        await applyUpdate(state.latestVersion)
      }
    } catch (err) {
      logger.debug(`update: scheduled check failed — ${(err as Error).message}`)
    }
  }

  // First check a couple of minutes after boot (jittered so installs don't
  // all hit the registry at once), then once a day.
  const firstDelay = 120_000 + Math.floor(Math.random() * 120_000)
  setTimeout(() => void tick(), firstDelay).unref()
  timer = setInterval(() => void tick(), ONE_DAY_MS)
  timer.unref()
  logger.info('update: daily version check enabled')
}

export function stopUpdateCheckLoop(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
