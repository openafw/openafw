// Ensure the agentfw daemon is running before a launch. Previously the daemon
// was bootstrapped by `agentfw wire` (which installed a service); now the
// launcher starts it on demand, like references/claude-code-router's `ccr code`.

import { spawn } from 'node:child_process'
import process from 'node:process'
import { logger } from '../../core/logger.ts'
import { daemonHealthy } from '../util/daemon-client.ts'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Start the daemon if it isn't already answering /health, and wait for it to
 *  come up. Re-execs this same CLI (`<node> [execArgv] <cli> daemon`) detached
 *  so it survives the launcher process. Throws if it never becomes healthy. */
export async function ensureDaemonRunning(opts: { quiet?: boolean } = {}): Promise<void> {
  if (await daemonHealthy()) return

  if (!opts.quiet) logger.print('starting agentfw daemon…')
  const child = spawn(
    process.argv[0]!,
    [...process.execArgv, process.argv[1]!, 'daemon'],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()

  // Poll up to ~10s. The daemon opens the DB + loads routing before it
  // serves /health, so first boot can take a beat.
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    if (await daemonHealthy()) return
  }
  throw new Error('agentfw daemon did not come up — try `agentfw daemon` in another terminal')
}
