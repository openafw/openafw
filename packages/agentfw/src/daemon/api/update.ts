import type { Context } from 'hono'
import { logger } from '../../core/logger.ts'
import { readConfig, updateConfig } from '../../core/config.ts'
import { checkForUpdate, readUpdateState } from '../update/check.ts'
import { applyUpdate } from '../update/apply.ts'
import { readProgress } from '../update/progress.ts'

/**
 * GET /api/update — everything the CLI and dashboard need: the check cache
 * (is a new version available), the staged-update progress (if one is
 * running), and the user's preferences.
 */
export async function handleGetUpdate(c: Context): Promise<Response> {
  const [state, progress, config] = await Promise.all([
    readUpdateState(),
    readProgress(),
    readConfig(),
  ])
  return c.json({ state, progress, config })
}

/** POST /api/update/check — force a fresh npm-registry version check. */
export async function handlePostUpdateCheck(c: Context): Promise<Response> {
  const config = await readConfig()
  if (!config.updateCheck) {
    return c.json({ error: 'update checks are disabled' }, 403)
  }
  const state = await checkForUpdate()
  return c.json({ state })
}

/**
 * POST /api/update — apply the latest update. Kicks off the staged update
 * (backup → install → quiet-window restart → supervised health-gate) and
 * returns immediately; the caller polls GET /api/update for progress.
 */
export async function handlePostUpdate(c: Context): Promise<Response> {
  const state = await readUpdateState()
  if (!state.available || !state.latestVersion) {
    return c.json({ error: 'no update available' }, 409)
  }
  const body = (await c.req.json().catch(() => ({}))) as { force?: boolean }
  // Do not await — the daemon will be restarted out from under this request.
  void applyUpdate(state.latestVersion, { force: body.force }).catch((e) => {
    logger.error(`update: applyUpdate failed — ${e instanceof Error ? e.message : e}`)
  })
  return c.json({ ok: true, updatingTo: state.latestVersion })
}

/**
 * POST /api/update/preference — persist the user's auto-update choice. The
 * dashboard posts this after the first manual update, when it asks whether
 * to keep updates automatic.
 */
export async function handlePostUpdatePreference(c: Context): Promise<Response> {
  const body = (await c.req.json().catch(() => ({}))) as {
    autoUpdate?: boolean
    updateCheck?: boolean
  }
  const patch: Parameters<typeof updateConfig>[0] = {}
  if (typeof body.autoUpdate === 'boolean') {
    patch.autoUpdate = body.autoUpdate
    // Answering the question — either way — means we stop asking.
    patch.autoUpdateAsked = true
  }
  if (typeof body.updateCheck === 'boolean') patch.updateCheck = body.updateCheck
  const config = await updateConfig(patch)
  return c.json({ config })
}
