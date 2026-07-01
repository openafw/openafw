import process from 'node:process'
import { Command } from 'commander'
import { readConfig } from '../core/config.ts'
import { logger } from '../core/logger.ts'
import { DAEMON_BASE_URL } from '../core/paths.ts'
import { VERSION } from '../core/version.ts'
import { agentCommands } from './commands/agents.ts'
import { daemonCommand } from './commands/daemon.ts'
import { keyCommand } from './commands/key.ts'
import { modelCommand } from './commands/model.ts'
import { oauthCommand } from './commands/oauth.ts'
import { ogrCommand } from './commands/ogr.ts'
import { onboardCommand } from './commands/onboard.ts'
import { routeCommand } from './commands/route.ts'
import { runCommand } from './commands/run.ts'
import { statusCommand } from './commands/status.ts'
import { tierCommand } from './commands/tier.ts'
import { uiCommand } from './commands/ui.ts'
import { updateSupervisorCommand } from './commands/update-supervisor.ts'
import { updateCommand } from './commands/update.ts'
import { ensureDaemonRunning } from './launch/daemon-autostart.ts'
import { needsFirstRun, runFirstRun } from './launch/first-run.ts'

const NAME = 'afw'
const DESCRIPTION =
  'An AI agent firewall on the wire. Taps the traffic between your agents and ' +
  'their model providers — see every request, swap the model per route, and ' +
  'run security detectors over untrusted tool-call content. Free and fully ' +
  'open source.'

export async function run(): Promise<void> {
  const program = new Command()
  program.name(NAME).description(DESCRIPTION).version(VERSION).showHelpAfterError()
  // Required so the per-agent launchers can use passThroughOptions() to forward
  // unknown flags (e.g. `afw claude -- -p "…"`) to the launched agent.
  program.enablePositionalOptions()

  // Per-agent commands: launchers for CLI agents (afw claude / codex),
  // setup instructions for app/daemon agents (afw claude-desktop / openclaw / …).
  for (const cmd of agentCommands()) program.addCommand(cmd)

  program.addCommand(runCommand)
  program.addCommand(onboardCommand)
  program.addCommand(modelCommand)
  program.addCommand(oauthCommand)
  program.addCommand(tierCommand)
  program.addCommand(keyCommand)
  program.addCommand(routeCommand)
  program.addCommand(ogrCommand)
  program.addCommand(statusCommand)
  program.addCommand(daemonCommand)
  program.addCommand(uiCommand)
  program.addCommand(updateCommand)
  program.addCommand(updateSupervisorCommand, { hidden: true })

  // Default action: bare `afw`. On a fresh install (no model configured)
  // this walks first-run setup; once configured it prints a short overview.
  // (Opening the dashboard is `afw ui` — we don't auto-launch a browser.)
  program.action(bareAfw)

  await program.parseAsync(process.argv)
}

/** Bare `afw`: first-run wizard on a fresh install, else the overview. */
async function bareAfw(): Promise<void> {
  // Cheap, daemon-free gate: only a not-yet-onboarded install can need setup.
  // On a fresh install the daemon isn't running yet, so we must start it before
  // needsFirstRun can read the (empty) registry.
  if (!(await readConfig()).onboarded && process.stdin.isTTY) {
    await ensureDaemonRunning()
    if (await needsFirstRun()) {
      await runFirstRun()
      return
    }
  }
  await printOverview()
}

/** Bare `afw`: a one-glance overview — daemon state, wired agents, and the
 *  commands most people want next. Never starts the daemon or opens a browser. */
async function printOverview(): Promise<void> {
  let healthy = false
  let wired: string[] = []
  try {
    const h = await fetch(`${DAEMON_BASE_URL}/health`, { signal: AbortSignal.timeout(1500) })
    healthy = h.ok
    if (healthy) {
      const w = await fetch(`${DAEMON_BASE_URL}/api/wire/status`, {
        signal: AbortSignal.timeout(1500),
      })
      if (w.ok) wired = ((await w.json()) as { wiredAgents?: string[] }).wiredAgents ?? []
    }
  } catch {
    // daemon not reachable — fall through to the "not running" line
  }

  logger.print(`afw v${VERSION} — an AI agent firewall on the wire`)
  logger.print(healthy ? `daemon:  running at ${DAEMON_BASE_URL}` : 'daemon:  not running')
  if (healthy) {
    logger.print(`wired:   ${wired.length > 0 ? wired.join(', ') : 'no agents yet'}`)
  }
  logger.print('')
  logger.print('Common commands:')
  logger.print('  afw claude           launch Claude Code through the firewall')
  logger.print('  afw model add        register a model provider')
  logger.print('  afw tier             map Tall/Grande/Venti to your models')
  logger.print('  afw key add          mint an API key for an OpenAI/Anthropic agent')
  logger.print('  afw ui               open the dashboard in your browser')
  logger.print('  afw daemon start     start the daemon in the background')
  logger.print('  afw daemon stop      stop the running daemon')
  logger.print('  afw daemon restart   restart the daemon in the background')
  logger.print('  afw status           daemon + tap health')
  logger.print('  afw --help           all commands')
}
