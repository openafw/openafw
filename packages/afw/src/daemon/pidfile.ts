// The daemon's PID file. Written once the server is listening, removed on a
// clean exit. `afw daemon stop/restart` reads it to signal a daemon this
// process didn't spawn. Best-effort throughout — a stale or missing file never
// blocks the daemon; the stop path falls back to port discovery.

import { unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { paths } from '../core/paths.ts'

let cleanupInstalled = false

export function writeDaemonPid(): void {
  try {
    writeFileSync(paths.wire.daemonPid, String(process.pid))
  } catch {
    return
  }
  if (cleanupInstalled) return
  cleanupInstalled = true
  const clean = (): void => {
    try {
      unlinkSync(paths.wire.daemonPid)
    } catch {
      // already gone — fine
    }
  }
  process.on('exit', clean)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      clean()
      process.exit(0)
    })
  }
}

export async function readDaemonPid(): Promise<number | null> {
  try {
    const n = Number.parseInt((await readFile(paths.wire.daemonPid, 'utf8')).trim(), 10)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}
