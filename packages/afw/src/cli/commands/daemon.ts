import process from 'node:process'
import { Command } from 'commander'
import { type LogLevel, logger } from '../../core/logger.ts'
import { startDaemon } from '../../daemon/index.ts'
import { ensureDaemonRunning } from '../launch/daemon-autostart.ts'
import { stopDaemon } from '../util/daemon-control.ts'

type DaemonRunOptions = {
  port?: string
  logLevel?: LogLevel
}

export const daemonCommand = new Command('daemon')
  .description('Manage the afw daemon.')
  .action(async () => {
    printDaemonHelp()
  })

daemonCommand
  .command('start')
  .description('Start the daemon in the background.')
  .action(async () => {
    try {
      await ensureDaemonRunning({ quiet: true })
      logger.print('✓ daemon started')
    } catch (e) {
      logger.print(`error: ${(e as Error).message}`)
      process.exit(1)
    }
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

daemonCommand
  .command('run', { hidden: true })
  .description('Run the daemon in the foreground.')
  .option('--port <port>', 'Override default port 9877.')
  .option('--log-level <level>', "'silent' | 'error' | 'warn' | 'info' | 'debug'")
  .action(async (options: DaemonRunOptions) => {
    if (options.logLevel) logger.setLevel(options.logLevel)
    const port = options.port ? Number.parseInt(options.port, 10) : undefined
    await startDaemon({ port })
  })

function printDaemonHelp(): void {
  logger.print('afw daemon manages the background daemon.')
  logger.print('')
  logger.print('Common commands:')
  logger.print('  afw daemon start     start the daemon in the background')
  logger.print('  afw daemon stop      stop the running daemon')
  logger.print('  afw daemon restart   restart the daemon in the background')
}
