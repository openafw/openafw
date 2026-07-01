import { spawn } from 'node:child_process'
import process from 'node:process'
import { Command } from 'commander'
import { logger } from '../../core/logger.ts'
import { DAEMON_BASE_URL } from '../../core/paths.ts'
import { ensureDaemonRunning } from '../launch/daemon-autostart.ts'

type UiOptions = {
  printUrl: boolean
}

export const uiCommand = new Command('ui')
  .description('Open the afw UI in your default browser.')
  .option('--print-url', 'Print the URL instead of opening a browser.', false)
  .action(async (options: UiOptions) => {
    await openUi({ noOpen: options.printUrl })
  })

export async function openUi(opts: { noOpen: boolean }): Promise<void> {
  const url = DAEMON_BASE_URL

  try {
    await ensureDaemonRunning()
  } catch (e) {
    logger.print(`error: ${(e as Error).message}`)
    process.exitCode = 1
    return
  }

  if (opts.noOpen) {
    logger.print(url)
    return
  }

  openBrowser(url)
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref()
}
