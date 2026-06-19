import { restartService } from '../../cli/service/index.ts'
import { logger } from '../../core/logger.ts'
import { DAEMON_BASE_URL } from '../../core/paths.ts'
import { pruneDbBackups } from './backup.ts'
import { patchProgress, readProgress } from './progress.ts'
import { rollback } from './rollback.ts'

// How long the new version has to come up healthy before it is judged a
// failed update and rolled back. Generous — covers the daemon restart plus
// any first-boot migration work.
const HEALTH_TIMEOUT_MS = 120_000

/**
 * The update supervisor. Spawned (detached) by the daemon at the moment of an
 * update restart, so it survives the restart and is unaffected even if the
 * new daemon crash-loops. It health-gates the new version: if it does not
 * come up healthy in time, it rolls back to the previous version and the
 * previous database. This is the auto-rollback authority.
 */
export async function runSupervisor(): Promise<void> {
  const progress = await readProgress()
  if (!progress) {
    logger.warn('supervisor: no update in progress — nothing to watch')
    return
  }
  const { fromVersion, toVersion, dbBackupPath } = progress
  logger.info(`supervisor: watching update ${fromVersion} → ${toVersion}`)

  if (await waitForHealthyVersion(toVersion, HEALTH_TIMEOUT_MS)) {
    await patchProgress({ stage: 'stable', message: `updated to ${toVersion}` })
    await pruneDbBackups(3)
    logger.info(`supervisor: ${toVersion} confirmed healthy`)
    return
  }

  logger.error(`supervisor: ${toVersion} never became healthy — rolling back to ${fromVersion}`)
  await patchProgress({
    stage: 'rolling-back',
    message: `update to ${toVersion} failed; rolling back to ${fromVersion}`,
  })
  try {
    await rollback(fromVersion, dbBackupPath)
    await restartService()
    await patchProgress({
      stage: 'rolled-back',
      message: `update to ${toVersion} failed health checks; rolled back to ${fromVersion}`,
    })
    logger.warn(`supervisor: rolled back to ${fromVersion}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await patchProgress({
      stage: 'rolled-back',
      message: `rollback failed: ${msg} — restore manually from ~/.afw/backups`,
    })
    logger.error(`supervisor: rollback failed — ${msg}`)
  }
}

/** Resolve true once /health reports the target version, ok, for ~6s straight. */
async function waitForHealthyVersion(version: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let streak = 0
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${DAEMON_BASE_URL}/health`, {
        signal: AbortSignal.timeout(1500),
      })
      if (r.ok) {
        const body = (await r.json()) as { version?: string }
        if (body.version === version) {
          streak++
          if (streak >= 3) return true
        } else {
          streak = 0
        }
      } else {
        streak = 0
      }
    } catch {
      streak = 0
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}
