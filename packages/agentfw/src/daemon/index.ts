import { mkdir } from 'node:fs/promises'
import { logger } from '../core/logger.ts'
import { DAEMON_PORT, paths } from '../core/paths.ts'
import { writeDaemonPid } from './pidfile.ts'
import { startServer } from './server.ts'
import { startUpdateCheckLoop } from './update/schedule.ts'

export type DaemonOptions = {
  port?: number
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<void> {
  await ensureDirs()
  const port = opts.port ?? DAEMON_PORT
  await startServer({ port })
  writeDaemonPid()
  logger.info(`agentfw daemon listening on http://localhost:${port}`)
  startUpdateCheckLoop()
}

async function ensureDirs(): Promise<void> {
  await mkdir(paths.home, { recursive: true })
  await mkdir(paths.wire.dir, { recursive: true })
  await mkdir(paths.wire.traces, { recursive: true })
  await mkdir(paths.backups.dir, { recursive: true })
  await mkdir(paths.logs.dir, { recursive: true })
}
