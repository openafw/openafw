import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { restartService } from '../../cli/service/index.ts'
import { logger } from '../../core/logger.ts'
import { VERSION } from '../../core/version.ts'
import { backupDb } from './backup.ts'
import { npmInstallGlobal } from './npm.ts'
import { patchProgress, writeProgress } from './progress.ts'
import { waitForQuiet } from './restart.ts'

const PKG = 'openafw'

/**
 * Apply an update, end to end. Runs inside the daemon:
 *   1. back up the trace DB
 *   2. npm install -g the new version  (throws if this fails — the daemon is
 *      left untouched on the old version, no restart, no rollback needed)
 *   3. hand off to finishUpdate(): wait for a quiet window, spawn the
 *      supervisor, restart the daemon onto the new code.
 *
 * Returns once the install is done and the restart is scheduled — the caller
 * (the API handler) can respond before the daemon is actually killed.
 */
export async function applyUpdate(toVersion: string, opts?: { force?: boolean }): Promise<void> {
  const fromVersion = VERSION
  logger.info(`update: applying ${fromVersion} → ${toVersion}`)

  await writeProgress({
    stage: 'installing',
    fromVersion,
    toVersion,
    dbBackupPath: null,
    startedAt: Date.now(),
    message: 'backing up the database',
  })

  const dbBackupPath = await backupDb(`pre-${toVersion}`)
  await patchProgress({ dbBackupPath, message: `installing ${PKG}@${toVersion}` })

  try {
    await npmInstallGlobal(`${PKG}@${toVersion}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await patchProgress({ stage: 'install-failed', message: msg })
    logger.error(`update: install failed — ${msg}`)
    throw e
  }

  await patchProgress({
    stage: 'awaiting-restart',
    message: 'installed; waiting for a quiet window to restart',
  })

  // Fire-and-forget: the daemon is about to be killed, so the caller must
  // not await this. The supervisor takes over once the restart happens.
  void finishUpdate(opts?.force)
}

async function finishUpdate(force?: boolean): Promise<void> {
  try {
    if (!force) {
      // A busy fleet is not a failure — keep waiting for a genuine idle
      // window so the restart never drops an in-flight model call.
      let quiet = await waitForQuiet()
      while (!quiet) {
        await patchProgress({ message: 'waiting for a quiet window (fleet busy)…' })
        quiet = await waitForQuiet({ timeoutMs: 60 * 60 * 1000 })
      }
    }
    await patchProgress({ stage: 'pending-confirm', message: 'restarting…' })
    spawnSupervisor()
    // Let the supervisor get polling before this daemon goes down.
    await new Promise((r) => setTimeout(r, 800))
    await restartService()
  } catch (e) {
    logger.error(`update: finishUpdate failed — ${e instanceof Error ? e.message : e}`)
  }
}

/**
 * Spawn the detached supervisor — it must outlive this daemon's restart so it
 * can health-gate the new version and roll back if it fails.
 */
function spawnSupervisor(): void {
  const entry = process.argv[1]
  if (!entry) {
    logger.error('update: cannot resolve entry path to spawn the supervisor')
    return
  }
  let resolved = entry
  try {
    resolved = realpathSync(entry)
  } catch {
    // use the unresolved path
  }
  const args = resolved.endsWith('.ts')
    ? ['--experimental-strip-types', resolved, '__supervise-update']
    : [resolved, '__supervise-update']
  spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref()
  logger.info('update: supervisor spawned')
}
