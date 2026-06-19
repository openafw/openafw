import process from 'node:process'
import { Command } from 'commander'
import { type LogLevel, logger } from '../../core/logger.ts'
import { startDaemon } from '../../daemon/index.ts'
import { ensureDaemonRunning } from '../launch/daemon-autostart.ts'
import { stopDaemon } from '../util/daemon-control.ts'

type DaemonOptions = {
  port?: string
  logLevel?: LogLevel
}

export const daemonCommand = new Command('daemon')
  .description('Run the afw daemon in the foreground, or stop/restart a running one.')
  .option('--port <port>', 'Override default port 9877.')
  .option('--log-level <level>', "'silent' | 'error' | 'warn' | 'info' | 'debug'")
  // Bare `afw daemon` runs in the foreground — the shape launchd/systemd
  // and the on-demand autostart expect. Subcommands manage a running one.
  .action(async (options: DaemonOptions) => {
    if (options.logLevel) logger.setLevel(options.logLevel)
    const port = options.port ? Number.parseInt(options.port, 10) : undefined
    await startDaemon({ port })
  })

daemonCommand
  .command('stop')
  .description('Stop the running daemon.')
  .action(async () => {
    const result = await stopDaemon()
    logger.print(result === 'stopped' ? '✓ daemon stopped' : 'no daemon was running')
  })

daemonCommand
  .command('restart')
  .description('Restart the daemon — stop the running one, then start a fresh background daemon.')
  .action(async () => {
    try {
      const result = await stopDaemon()
      if (result === 'stopped') logger.print('stopped old daemon')
      await ensureDaemonRunning({ quiet: true })
      logger.print('✓ daemon restarted')
    } catch (e) {
      logger.print(`error: ${(e as Error).message}`)
      process.exit(1)
    }
  })
