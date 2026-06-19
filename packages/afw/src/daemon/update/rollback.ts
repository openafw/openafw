import { logger } from '../../core/logger.ts'
import { writeRestoreMarker } from './backup.ts'
import { npmInstallGlobal } from './npm.ts'

const PKG = 'openafw'

/**
 * Revert to a prior version: reinstall it from the npm registry and queue the
 * pre-update DB backup to be restored on the next boot. The caller must
 * restart the daemon afterwards — the restored daemon picks up both the old
 * code and (via consumePendingRestore) the old database. Shared by the
 * supervisor's auto-rollback and the manual `afw rollback` command.
 */
export async function rollback(toVersion: string, dbBackupPath: string | null): Promise<void> {
  logger.warn(`update: rolling back to ${toVersion}`)
  await npmInstallGlobal(`${PKG}@${toVersion}`)
  if (dbBackupPath) {
    await writeRestoreMarker(dbBackupPath)
  }
}
