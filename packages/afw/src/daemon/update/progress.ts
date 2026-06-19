import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { paths } from '../../core/paths.ts'

// The staged-update state machine, persisted to ~/.afw/update-progress.json.
// Distinct from update.json (the "is a new version available" check cache) —
// this file tracks an update that is actively happening, and is what the
// supervisor and the CLI/dashboard read to drive and report it.
const PROGRESS_PATH = join(paths.home, 'update-progress.json')

export type UpdateStage =
  | 'installing' //       npm install is running
  | 'install-failed' //   npm install failed — daemon untouched, still on fromVersion
  | 'awaiting-restart' // installed; waiting for a quiet window to restart
  | 'pending-confirm' //  daemon restarted; supervisor is health-gating it
  | 'stable' //           new version confirmed healthy
  | 'rolling-back' //     auto-rollback in progress
  | 'rolled-back' //      reverted to fromVersion after a failed update

export type UpdateProgress = {
  stage: UpdateStage
  fromVersion: string
  toVersion: string
  dbBackupPath: string | null
  startedAt: number
  message: string | null
}

export async function readProgress(): Promise<UpdateProgress | null> {
  try {
    return JSON.parse(await readFile(PROGRESS_PATH, 'utf8')) as UpdateProgress
  } catch {
    return null
  }
}

export async function writeProgress(p: UpdateProgress): Promise<void> {
  await mkdir(dirname(PROGRESS_PATH), { recursive: true })
  await writeFile(PROGRESS_PATH, `${JSON.stringify(p, null, 2)}\n`, 'utf8')
}

export async function patchProgress(
  patch: Partial<UpdateProgress>,
): Promise<UpdateProgress | null> {
  const current = await readProgress()
  if (!current) return null
  const next = { ...current, ...patch }
  await writeProgress(next)
  return next
}

export async function clearProgress(): Promise<void> {
  await rm(PROGRESS_PATH, { force: true })
}
