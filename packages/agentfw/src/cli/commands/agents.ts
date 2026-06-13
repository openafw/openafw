// Per-agent commands, dispatched by runtime form:
//   • launch-per-task (claude, codex) → a LAUNCHER: start one instance pointed
//     at agentfw (per-process, no global config rewrite), remembering this
//     directory's routing choice.
//   • app / daemon / manual (claude-desktop, openclaw, hermes, …) → an
//     INSTRUCTIONS printer: agentfw never rewrites their config; it tells the
//     user how to point them at the wire.

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import process from 'node:process'
import { Command } from 'commander'
import type { AgentId } from '../../core/agent.ts'
import { logger } from '../../core/logger.ts'
import { detectorFor } from '../detect/index.ts'
import type { Detection } from '../detect/types.ts'
import { ensureDaemonRunning } from '../launch/daemon-autostart.ts'
import { launchInstance } from '../launch/instance.ts'
import { ensureOnboarded } from '../launch/onboard.ts'
import { type LaunchConfig, readLaunchConfig, writeLaunchConfig } from '../launch/per-dir.ts'
import { ensureWireRoute } from '../launch/route-setup.ts'
import { wiringForAgent } from '../launch/wiring.ts'
import { agentfwUrlFor } from '../wire/url.ts'

// ── launcher (CLI agents) ─────────────────────────────────────────

/** A stable per-directory instance label: the dir name plus a short hash of
 *  the absolute path, so two projects named "app" don't share a cost bucket. */
function dirLabel(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 6)
  return `${basename(cwd) || 'root'}-${hash}`
}

type LauncherOpts = {
  model?: string
  monitor?: boolean
  raw?: boolean
  as?: string
  ephemeral?: boolean
}

function buildLauncher(agent: AgentId, bin: string): Command {
  return new Command(bin)
    .description(
      `Launch ${bin} through agentfw — this instance only, no global config change. Remembers this directory's choice for next time. Pass agent args after \`--\`.`,
    )
    .argument('[args...]', `arguments forwarded to ${bin} (use \`-- <args>\` for flags)`)
    .option('--model <id>', 'route this instance to a single model (remembered for this dir)')
    .option('--monitor', 'capture but never reroute')
    .option('--raw', 'bypass agentfw entirely for this launch')
    .option('--as <label>', 'instance label (defaults to a per-directory id)')
    .option('--ephemeral', 'forget the instance routing policy when it exits')
    .allowUnknownOption()
    .passThroughOptions()
    .action(async (args: string[], opts: LauncherOpts) => {
      try {
        const cwd = process.cwd()

        // Merge remembered config with this invocation's flags. Any flag given
        // updates the memory; a bare launch reuses what's saved.
        const saved = (await readLaunchConfig(cwd, agent)) ?? {}
        const flagGiven = opts.model != null || opts.monitor || opts.raw || opts.as != null
        const cfg: LaunchConfig = {
          model: opts.monitor || opts.raw ? undefined : (opts.model ?? saved.model),
          mode: opts.raw ? 'raw' : opts.monitor ? 'monitor' : flagGiven ? undefined : saved.mode,
          as: opts.as ?? saved.as,
        }
        if (flagGiven) await writeLaunchConfig(cwd, agent, cfg)

        await ensureDaemonRunning()
        await ensureWireRoute(agent)

        // Fresh install with nothing routed → walk the user through picking a
        // model (or passthrough) before we hand off to the agent. Skipped for
        // raw/monitor launches and once configured. See onboard.ts.
        if (cfg.mode !== 'raw' && cfg.mode !== 'monitor') await ensureOnboarded(agent)

        await launchInstance({
          bin,
          args,
          agentOverride: agent,
          instanceLabel: cfg.as ?? dirLabel(cwd),
          model: cfg.model,
          monitor: cfg.mode === 'monitor',
          raw: cfg.mode === 'raw',
          ephemeral: opts.ephemeral,
        })
      } catch (e) {
        logger.print(`error: ${(e as Error).message}`)
        process.exit(1)
      }
    })
}

// ── instructions (app / daemon / manual agents) ───────────────────

function emptyDetection(agent: AgentId): Detection {
  const det = detectorFor(agent)
  return {
    agent,
    mode: det?.mode ?? 'manual',
    configPaths: [],
    endpoints: [],
    mcpServers: [],
    caveats: [],
  }
}

// App / daemon / manual agents — can't be launched per-process, so agentfw
// prints how to point them at the wire (it never edits their config).
const SETUP_AGENTS = ['claude-desktop', 'openclaw', 'hermes', 'cursor', 'gemini'] as AgentId[]

function printSetup(agent: AgentId): Promise<void> {
  return (async () => {
    const det = detectorFor(agent)
    const detection = (det ? await det.detect() : null) ?? emptyDetection(agent)
    const text = det?.manualInstructions?.(detection)
    logger.print(`Setting up ${agent} with agentfw\n`)
    if (text) {
      logger.print(text)
    } else {
      logger.print(
        [
          "Point this agent's model base URL at the agentfw wire:",
          '',
          `  ${agentfwUrlFor(agent)}`,
          '',
          'Then register the upstream model(s) you want to use:',
          '',
          '  agentfw model add',
          '',
          `And route them:  agentfw route set ${agent}/* --model <id>`,
        ].join('\n'),
      )
    }
  })()
}

function buildSetupCommand(): Command {
  return new Command('setup')
    .description(
      `Print how to point an app/daemon agent at agentfw (${SETUP_AGENTS.join(', ')}). agentfw never edits the agent's own config.`,
    )
    .argument('<agent>', `agent to set up: ${SETUP_AGENTS.join(' | ')}`)
    .action(async (agent: string) => {
      if (!SETUP_AGENTS.includes(agent as AgentId)) {
        logger.print(`unknown agent "${agent}". Known: ${SETUP_AGENTS.join(', ')}`)
        process.exitCode = 1
        return
      }
      await printSetup(agent as AgentId)
    })
}

// ── registry ──────────────────────────────────────────────────────

/** Per-agent commands: a launcher per CLI agent (claude, codex), plus one
 *  `setup <agent>` that prints wiring instructions for app/daemon agents. */
export function agentCommands(): Command[] {
  const cmds: Command[] = []
  // CLI launchers, named after the binary the user actually types.
  for (const agent of ['claude-code', 'codex'] as AgentId[]) {
    const wiring = wiringForAgent(agent)
    if (wiring) cmds.push(buildLauncher(agent, wiring.bins[0]!))
  }
  cmds.push(buildSetupCommand())
  return cmds
}
