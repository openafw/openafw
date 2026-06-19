// `afw onboard` — (re)run first-run setup: register a model provider and
// mint an API key for a generic agent. The bare `afw` command runs this
// automatically on a fresh install; this command lets the user revisit it.

import process from 'node:process'
import { Command } from 'commander'
import { logger } from '../../core/logger.ts'
import { ensureDaemonRunning } from '../launch/daemon-autostart.ts'
import { runFirstRun } from '../launch/first-run.ts'

export const onboardCommand = new Command('onboard')
  .description('Set up afw: register a model provider and mint an API key. Re-runnable.')
  .action(async () => {
    try {
      await ensureDaemonRunning()
      const ran = await runFirstRun()
      if (!ran) {
        logger.print(
          'onboarding needs an interactive terminal — run `afw onboard` directly, ' +
            'or configure non-interactively with `afw model add` + `afw key add`.',
        )
        process.exitCode = 1
      }
    } catch (e) {
      logger.print(`error: ${(e as Error).message}`)
      process.exit(1)
    }
  })
