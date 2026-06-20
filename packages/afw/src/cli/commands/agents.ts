// Per-agent commands, two shapes:
//   • launch-per-task (claude, codex) → a LAUNCHER: start one instance pointed
//     at afw, remembering this directory's routing choice, and auto-mint a
//     short session API key for the directory the first time it's launched.
//   • app/daemon (openclaw, hermes) → a KEY MANAGER: list the agent's API keys
//     and create a new one to paste into the agent's config.

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import process from 'node:process'
import { Command } from 'commander'
import type { AgentId } from '../../core/agent.ts'
import { logger } from '../../core/logger.ts'
import { ensureDaemonRunning } from '../launch/daemon-autostart.ts'
import { instanceIdFrom, launchInstance } from '../launch/instance.ts'
import { ensureOnboarded } from '../launch/onboard.ts'
import { type LaunchConfig, readLaunchConfig, writeLaunchConfig } from '../launch/per-dir.ts'
import { ensureWireRoute } from '../launch/route-setup.ts'
import { wiringForAgent } from '../launch/wiring.ts'
import { confirmYesNo } from '../util/prompt.ts'
import { createAndShowKey, ensureSessionKey, listKeysFor, printKeyList } from './key.ts'

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
      `Launch ${bin} through afw — this instance only, no global config change. Remembers this directory's choice for next time. Pass agent args after \`--\`.`,
    )
    .argument('[args...]', `arguments forwarded to ${bin} (use \`-- <args>\` for flags)`)
    .option('--model <id>', 'route this instance to a single model (remembered for this dir)')
    .option('--monitor', 'capture but never reroute')
    .option('--raw', 'bypass afw entirely for this launch')
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
        await ensureWireRoute(agent, { modelOverride: cfg.model })

        const instanceLabel = cfg.as ?? dirLabel(cwd)

        // Auto-mint a short API key for this directory's session the first time
        // it's launched, so afw tracks each session under a stable id.
        // Idempotent — a re-launch in the same dir reuses it. Best-effort.
        if (cfg.mode !== 'raw') {
          try {
            const { key, created } = await ensureSessionKey(agent, instanceIdFrom(instanceLabel))
            if (created) logger.print(`  ↳ session key ${key.token} (new)`)
          } catch {
            // a missing session key never blocks the launch
          }
        }

        // Fresh install with nothing routed → walk the user through picking a
        // model (or passthrough) before we hand off to the agent. Skipped for
        // raw/monitor launches and once configured. See onboard.ts.
        if (cfg.mode !== 'raw' && cfg.mode !== 'monitor') await ensureOnboarded(agent)

        await launchInstance({
          bin,
          args,
          agentOverride: agent,
          instanceLabel,
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

// ── key manager (app / daemon agents) ─────────────────────────────

// App/daemon agents can't be launched per-process; they connect by presenting
// an afw API key to /v1. `afw <agent>` lists this agent's keys and
// offers to create one.
const KEY_AGENTS = ['openclaw', 'hermes'] as AgentId[]

function buildKeyManager(agent: AgentId): Command {
  return new Command(agent)
    .description(`List and create afw API keys for ${agent}.`)
    .option('--new', 'create a new API key')
    .option('--label <name>', 'label for the new key')
    .action(async (opts: { new?: boolean; label?: string }) => {
      try {
        await ensureDaemonRunning()
        const keys = await listKeysFor(agent)
        if (keys.length > 0) {
          logger.print(`Existing ${agent} keys:`)
          printKeyList(keys)
        } else {
          logger.print(`No ${agent} keys yet.`)
        }

        const wantNew =
          opts.new === true ||
          (process.stdin.isTTY &&
            (await confirmYesNo(`Create a new API key for ${agent}?`, keys.length === 0)))
        if (wantNew) {
          await createAndShowKey({ label: opts.label ?? agent, agent })
        } else if (keys.length > 0) {
          logger.print('\nRun `afw key show <id>` for an existing key’s connection details.')
        }
      } catch (e) {
        logger.print(`error: ${(e as Error).message}`)
        process.exitCode = 1
      }
    })
}

// ── registry ──────────────────────────────────────────────────────

/** Per-agent commands: a launcher per CLI agent (claude, codex) and a key
 *  manager per app/daemon agent (openclaw, hermes). */
export function agentCommands(): Command[] {
  const cmds: Command[] = []
  // CLI launchers, named after the binary the user actually types.
  for (const agent of ['claude-code', 'codex'] as AgentId[]) {
    const wiring = wiringForAgent(agent)
    if (wiring) cmds.push(buildLauncher(agent, wiring.bins[0]!))
  }
  for (const agent of KEY_AGENTS) cmds.push(buildKeyManager(agent))
  return cmds
}
