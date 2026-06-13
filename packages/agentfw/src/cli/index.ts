import process from 'node:process'
import { Command } from 'commander'
import { logger } from '../core/logger.ts'
import { DAEMON_BASE_URL } from '../core/paths.ts'
import { VERSION } from '../core/version.ts'
import { agentCommands } from './commands/agents.ts'
import { daemonCommand } from './commands/daemon.ts'
import { modelCommand } from './commands/model.ts'
import { onboardCommand } from './commands/onboard.ts'
import { routeCommand } from './commands/route.ts'
import { runCommand } from './commands/run.ts'
import { statusCommand } from './commands/status.ts'
import { uiCommand } from './commands/ui.ts'
import { updateSupervisorCommand } from './commands/update-supervisor.ts'
import { updateCommand } from './commands/update.ts'

const NAME = 'agentfw'
const DESCRIPTION =
  'An AI agent firewall on the wire. Taps the traffic between your agents and ' +
  'their model providers — see every request, swap the model per route, and ' +
  'run security detectors over untrusted tool-call content. Free and fully ' +
  'open source.'

export async function run(): Promise<void> {
  const program = new Command()
  program.name(NAME).description(DESCRIPTION).version(VERSION).showHelpAfterError()
  // Required so the per-agent launchers can use passThroughOptions() to forward
  // unknown flags (e.g. `agentfw claude -- -p "…"`) to the launched agent.
  program.enablePositionalOptions()

  // Per-agent commands: launchers for CLI agents (agentfw claude / codex),
  // setup instructions for app/daemon agents (agentfw claude-desktop / openclaw / …).
  for (const cmd of agentCommands()) program.addCommand(cmd)

  program.addCommand(runCommand)
  program.addCommand(onboardCommand)
  program.addCommand(modelCommand)
  program.addCommand(routeCommand)
  program.addCommand(statusCommand)
  program.addCommand(daemonCommand)
  program.addCommand(uiCommand)
  program.addCommand(updateCommand)
  program.addCommand(updateSupervisorCommand, { hidden: true })

  // Default action: bare `agentfw` prints a short overview + common commands.
  // (Opening the dashboard is `agentfw ui` — we don't auto-launch a browser.)
  program.action(printOverview)

  await program.parseAsync(process.argv)
}

/** Bare `agentfw`: a one-glance overview — daemon state, wired agents, and the
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

  logger.print(`agentfw v${VERSION} — an AI agent firewall on the wire`)
  logger.print(healthy ? `daemon:  running at ${DAEMON_BASE_URL}` : 'daemon:  not running')
  if (healthy) {
    logger.print(`wired:   ${wired.length > 0 ? wired.join(', ') : 'no agents yet'}`)
  }
  logger.print('')
  logger.print('Common commands:')
  logger.print('  agentfw claude           launch Claude Code through the firewall')
  logger.print('  agentfw onboard          configure a model provider + route')
  logger.print('  agentfw ui               open the dashboard in your browser')
  logger.print('  agentfw status           daemon + tap health')
  logger.print('  agentfw daemon restart   restart the daemon')
  logger.print('  agentfw --help           all commands')
}
