import process from 'node:process'
import { Command } from 'commander'
import { logger } from '../../core/logger.ts'
import { DAEMON_BASE_URL } from '../../core/paths.ts'
import { readProgress } from '../../daemon/update/progress.ts'
import { confirmYesNo } from '../util/prompt.ts'

type UpdateInfo = {
  state: {
    currentVersion: string
    latestVersion: string | null
    available: boolean
    error: string | null
  }
  config: { updateCheck: boolean; autoUpdate: boolean; autoUpdateAsked: boolean }
}

const TERMINAL_STAGES = ['stable', 'rolled-back', 'install-failed']

export const updateCommand = new Command('update')
  .description(
    'Update afw to the latest version — backed up, health-gated, auto-rolled-back on failure.',
  )
  .option('--check', 'Only check whether a new version exists; do not install.', false)
  .option('--force', 'Restart immediately instead of waiting for an idle window.', false)
  .action(async (opts: { check: boolean; force: boolean }) => {
    let info: UpdateInfo
    try {
      const res = await fetch(`${DAEMON_BASE_URL}/api/update`, {
        signal: AbortSignal.timeout(10_000),
      })
      info = (await res.json()) as UpdateInfo
    } catch {
      logger.print('Daemon not reachable. Start it with `afw daemon`, then retry.')
      process.exitCode = 1
      return
    }

    const { currentVersion, latestVersion, available, error } = info.state
    logger.print(`Installed: afw v${currentVersion}`)
    if (error) logger.print(`(last version check failed: ${error})`)
    if (!available || !latestVersion) {
      logger.print('You are on the latest version.')
      return
    }
    logger.print(`Available: afw v${latestVersion}`)
    if (opts.check) {
      logger.print('Run `afw update` to install it.')
      return
    }

    logger.print('')
    logger.print(`Updating v${currentVersion} → v${latestVersion}`)
    logger.print('afw backs up your database, health-checks the new version,')
    logger.print('and automatically rolls back if it fails.')
    logger.print('')

    try {
      await fetch(`${DAEMON_BASE_URL}/api/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: opts.force }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      logger.print('Failed to start the update.')
      process.exitCode = 1
      return
    }

    const stage = await pollProgress()
    logger.print('')
    if (stage === 'stable') {
      logger.print(`✓ Updated to afw v${latestVersion}.`)
      if (!info.config.autoUpdateAsked) {
        logger.print('')
        const yes = await confirmYesNo('Auto-update future releases?', true)
        await setAutoUpdate(yes)
        logger.print(
          yes
            ? 'Auto-update enabled — future releases install themselves (still backed up + health-gated).'
            : 'Left off — run `afw update` whenever you want the next release.',
        )
      }
    } else if (stage === 'rolled-back') {
      const p = await readProgress()
      logger.print(`✗ Update failed — rolled back to v${currentVersion}.`)
      if (p?.message) logger.print(`  ${p.message}`)
      process.exitCode = 1
    } else if (stage === 'install-failed') {
      const p = await readProgress()
      logger.print(`✗ Install failed — still on v${currentVersion}.`)
      if (p?.message) logger.print(`  ${p.message}`)
      process.exitCode = 1
    } else {
      logger.print('Update still in progress (the fleet may be busy) — check the')
      logger.print('dashboard, or re-run `afw update` later to see the result.')
    }
  })

async function pollProgress(): Promise<string> {
  const deadline = Date.now() + 10 * 60_000
  let lastMessage = ''
  while (Date.now() < deadline) {
    const p = await readProgress()
    if (p) {
      if (p.message && p.message !== lastMessage) {
        logger.print(`  ${p.message}`)
        lastMessage = p.message
      }
      if (TERMINAL_STAGES.includes(p.stage)) return p.stage
    }
    await new Promise((r) => setTimeout(r, 1_500))
  }
  return 'timeout'
}

async function setAutoUpdate(autoUpdate: boolean): Promise<void> {
  try {
    await fetch(`${DAEMON_BASE_URL}/api/update/preference`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoUpdate }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    logger.print('(could not save the preference — the daemon may be restarting)')
  }
}
