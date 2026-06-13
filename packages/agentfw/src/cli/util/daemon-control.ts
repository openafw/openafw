// Stop a running daemon from a separate CLI process. Prefers the PID file the
// daemon writes on boot; falls back to discovering the listener by port (for a
// daemon started before the PID file existed, or after a stale file). SIGTERM
// first — the daemon's signal handler removes its PID file and exits cleanly —
// then escalate to SIGKILL if it doesn't go down.

import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { DAEMON_PORT } from '../../core/paths.ts'
import { readDaemonPid } from '../../daemon/pidfile.ts'
import { daemonHealthy } from './daemon-client.ts'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Find the PID listening on `port` via lsof (macOS/Linux). Returns null when
 *  lsof is missing (e.g. Windows) or nothing is listening. */
function pidByPort(port: number): number | null {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const first = out.split(/\s+/)[0]
    const n = first ? Number.parseInt(first, 10) : Number.NaN
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export type StopResult = 'stopped' | 'not-running'

/** Signal the running daemon to exit and wait for /health to stop answering. */
export async function stopDaemon(): Promise<StopResult> {
  const pid = (await readDaemonPid()) ?? pidByPort(DAEMON_PORT)
  if (pid == null) return 'not-running'

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return 'not-running' // already gone
  }

  for (let i = 0; i < 40; i++) {
    if (!(await daemonHealthy())) return 'stopped'
    await sleep(250)
  }
  // Didn't shut down in ~10s — escalate.
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // gone between checks — fine
  }
  await sleep(250)
  return 'stopped'
}
