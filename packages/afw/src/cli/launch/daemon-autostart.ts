// Ensure the afw daemon is running before a launch. Previously the daemon
// was bootstrapped by `afw wire` (which installed a service); now the
// launcher starts it on demand, like references/claude-code-router's `ccr code`.

import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import process from 'node:process'
import { logger } from '../../core/logger.ts'
import { paths } from '../../core/paths.ts'
import { daemonHealthy } from '../util/daemon-client.ts'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** stdio for the detached daemon — append its stdout/stderr to the same log
 *  files the installed service uses (~/.afw/logs/daemon.{log,err}), so an
 *  on-demand daemon (the `afw codex` / `afw claude` autostart) is just as
 *  inspectable as a serviced one. The logger only writes to stdout/stderr, so
 *  without this the autostart daemon's output goes nowhere. Falls back to
 *  discarding output if the log dir can't be opened (read-only home, etc.) —
 *  losing logs must never block the launch. */
function daemonStdio(): ['ignore', number, number] | 'ignore' {
  try {
    mkdirSync(paths.logs.dir, { recursive: true })
    const out = openSync(paths.logs.daemon, 'a')
    const err = openSync(paths.logs.daemonErr, 'a')
    return ['ignore', out, err]
  } catch {
    return 'ignore'
  }
}

/** Start the daemon if it isn't already answering /health, and wait for it to
 *  come up. Re-execs this same CLI (`<node> [execArgv] <cli> daemon`) detached
 *  so it survives the launcher process. Throws if it never becomes healthy. */
export async function ensureDaemonRunning(opts: { quiet?: boolean } = {}): Promise<void> {
  if (await daemonHealthy()) return

  if (!opts.quiet) logger.print('starting afw daemon…')
  const child = spawn(process.argv[0]!, [...process.execArgv, process.argv[1]!, 'daemon'], {
    detached: true,
    stdio: daemonStdio(),
  })
  child.unref()

  // Poll up to ~10s. The daemon opens the DB + loads routing before it
  // serves /health, so first boot can take a beat.
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    if (await daemonHealthy()) return
  }
  throw new Error('afw daemon did not come up — try `afw daemon` in another terminal')
}
