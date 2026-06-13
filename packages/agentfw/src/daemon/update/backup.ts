import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { logger } from '../../core/logger.ts'
import { paths } from '../../core/paths.ts'

const DB_PATH = join(paths.wire.traces, 'traces.db')
// A rollback writes this marker; the next daemon boot consumes it and
// restores the DB *before opening it* — so there is never an open-handle
// race against the live database.
const RESTORE_MARKER = join(paths.home, 'pending-db-restore')

/**
 * Snapshot the trace database into the backups directory before an update
 * touches it. Uses SQLite's online backup API so the copy is internally
 * consistent even though the daemon holds the DB open in WAL mode. Returns
 * the backup path, or null if there is no database yet.
 */
export async function backupDb(label: string): Promise<string | null> {
  try {
    await stat(DB_PATH)
  } catch {
    return null
  }
  await mkdir(paths.backups.dir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(paths.backups.dir, `db-${label}-${ts}.sqlite`)
  const src = new Database(DB_PATH, { readonly: true })
  try {
    await src.backup(dest)
  } finally {
    src.close()
  }
  return dest
}

/**
 * Queue a DB restore for the next daemon boot. The caller (rollback) writes
 * the marker, then restarts the daemon — `consumePendingRestore` does the
 * actual copy at boot, before the database is opened.
 */
export async function writeRestoreMarker(backupPath: string): Promise<void> {
  await mkdir(paths.home, { recursive: true })
  await writeFile(RESTORE_MARKER, backupPath, 'utf8')
}

/**
 * If a rollback queued a DB restore, perform it now and clear the marker.
 * MUST be called at daemon boot before the database is opened — that
 * ordering is what makes the restore safe (no open handle to race).
 */
export async function consumePendingRestore(): Promise<void> {
  let backupPath: string
  try {
    backupPath = (await readFile(RESTORE_MARKER, 'utf8')).trim()
  } catch {
    return // no marker — normal boot
  }
  try {
    if (backupPath) {
      await mkdir(paths.wire.traces, { recursive: true })
      await rm(`${DB_PATH}-wal`, { force: true })
      await rm(`${DB_PATH}-shm`, { force: true })
      await copyFile(backupPath, DB_PATH)
      logger.warn(`update: restored database from ${backupPath} (rollback)`)
    }
  } finally {
    await rm(RESTORE_MARKER, { force: true })
  }
}

/** Keep only the most recent `keep` DB backups; delete older ones. */
export async function pruneDbBackups(keep = 3): Promise<void> {
  let backups: string[]
  try {
    backups = (await readdir(paths.backups.dir))
      .filter((f) => f.startsWith('db-') && f.endsWith('.sqlite'))
      .sort()
  } catch {
    return
  }
  for (const f of backups.slice(0, Math.max(0, backups.length - keep))) {
    await rm(join(paths.backups.dir, f), { force: true }).catch(() => {})
  }
}
