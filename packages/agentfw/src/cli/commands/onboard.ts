// `agentfw onboard` — (re)run the first-run setup for an agent: pick a model
// provider + model and wire it as that agent's default route, or choose
// passthrough. The launchers call this automatically on a fresh install; this
// command lets the user revisit the choice anytime.

import process from 'node:process'
import { Command } from 'commander'
import type { AgentId } from '../../core/agent.ts'
import { logger } from '../../core/logger.ts'
import { ensureDaemonRunning } from '../launch/daemon-autostart.ts'
import { runOnboarding } from '../launch/onboard.ts'

export const onboardCommand = new Command('onboard')
  .description("Set up where an agent's traffic is routed (model provider + model). Re-runnable.")
  .argument('[agent]', 'agent to configure', 'claude-code')
  .action(async (agent: string) => {
    try {
      await ensureDaemonRunning()
      const ran = await runOnboarding(agent as AgentId)
      if (!ran) {
        logger.print(
          'onboarding needs an interactive terminal — run `agentfw onboard` directly, ' +
            'or configure non-interactively with `agentfw model add` + `agentfw route set`.',
        )
        process.exitCode = 1
      }
    } catch (e) {
      logger.print(`error: ${(e as Error).message}`)
      process.exit(1)
    }
  })
