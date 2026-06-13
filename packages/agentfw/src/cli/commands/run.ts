// `agentfw run` — the explicit/advanced launcher. Launch one agent instance
// with its own wire identity (per-instance capture + routing) without
// touching the agent's shared config. The ergonomic per-agent form is
// `agentfw claude` / `agentfw codex` (see commands/agents.ts); both sit on the
// same launchInstance core.

import { basename } from 'node:path'
import process from 'node:process'
import { Command } from 'commander'
import { logger } from '../../core/logger.ts'
import { ensureDaemonRunning } from '../launch/daemon-autostart.ts'
import { launchInstance } from '../launch/instance.ts'
import { ensureWireRoute } from '../launch/route-setup.ts'
import { wiringForBin } from '../launch/wiring.ts'

type RunOpts = {
  as?: string
  model?: string
  monitor?: boolean
  raw?: boolean
  agent?: string
  ephemeral?: boolean
}

export const runCommand = new Command('run')
  .description(
    'Launch one agent instance with its own wire identity — per-instance capture ' +
      "and routing, without touching the agent's shared config.\n" +
      '  Examples:\n' +
      '    agentfw run --as planner --model claude-opus-4-8 -- claude   # keep Opus\n' +
      '    agentfw run --as worker --model claude-sonnet-4-6 -- claude  # downgrade\n' +
      '    agentfw run --as audit --monitor -- claude                   # track, never reroute\n' +
      '    agentfw run --as solo --raw -- claude                        # bypass agentfw',
  )
  .argument('<command...>', 'the agent command to launch, e.g. `-- claude` (pass it after `--`)')
  .option('--as <label>', 'instance label — stable across relaunches; spend accrues to it')
  .option('--model <id>', 'route this instance to a single model')
  .option('--monitor', 'capture this instance but never reroute (passthrough)')
  .option('--raw', 'bypass agentfw entirely for this instance (no capture, no routing)')
  .option('--agent <id>', 'force the agent type instead of inferring it from the command')
  .option('--ephemeral', 'remove the instance routing policy when the process exits')
  .action(async (command: string[], opts: RunOpts) => {
    const fail = (m: string): never => {
      logger.print(`error: ${m}`)
      process.exit(1)
    }

    if (command.length === 0) {
      fail('no command to launch — pass it after `--`, e.g. `agentfw run -- claude`')
    }
    const chosen = [opts.model, opts.monitor, opts.raw].filter(Boolean)
    if (chosen.length > 1) fail('pass at most one of --model, --monitor, or --raw')

    const [bin, ...rest] = command
    const wiring = wiringForBin(bin!, opts.agent)
    if (!wiring) {
      fail(
        `agentfw run can't wrap "${opts.agent ?? basename(bin!)}" yet — it supports ` +
          'launch-per-task agents (claude, codex). For daemon agents like OpenClaw, ' +
          'run `agentfw openclaw` for setup steps.',
      )
    }

    try {
      if (!opts.raw) {
        await ensureDaemonRunning()
        await ensureWireRoute(wiring!.agent)
      }
      await launchInstance({
        bin: bin!,
        args: rest,
        agentOverride: opts.agent,
        instanceLabel: opts.as,
        model: opts.model,
        monitor: opts.monitor,
        raw: opts.raw,
        ephemeral: opts.ephemeral,
      })
    } catch (e) {
      fail((e as Error).message)
    }
  })
