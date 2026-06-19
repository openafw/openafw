// First-run experience. After `npm i`, a bare `afw` lands here on a fresh
// install: afw taps the wire but does nothing useful until it knows where to
// send traffic. We walk the user through (1) registering a model provider, (2)
// mapping the three fixed model names (Tall / Grande / Venti) to their models, and
// (3) minting an API key for a generic OpenAI/Anthropic-compatible agent
// (OpenClaw, Hermes, …) so it can point at the local /v1 endpoint. Claude Code
// and Codex skip all of this — they're launched zero-config with `afw
// claude` / `afw codex` (which auto-mint their own session key).
// Re-runnable via `afw onboard`.

import process from 'node:process'
import type { AgentId } from '../../core/agent.ts'
import { readConfig, updateConfig } from '../../core/config.ts'
import { logger } from '../../core/logger.ts'
import type { ModelEntry, ProviderEntry } from '../../core/model-registry.ts'
import { createAndShowKey } from '../commands/key.ts'
import { addOneProvider } from '../commands/model.ts'
import { runTierWizard } from '../commands/tier.ts'
import { daemonFetch } from '../util/daemon-client.ts'
import { confirmYesNo, promptChoice } from '../util/prompt.ts'

type Registry = { providers: ProviderEntry[]; models: ModelEntry[] }

/** True when there's no usable model registered and the user hasn't already
 *  completed setup — i.e. a fresh install. False (don't block) when the daemon
 *  can't be reached. */
export async function needsFirstRun(): Promise<boolean> {
  const cfg = await readConfig()
  if (cfg.onboarded) return false
  try {
    const reg = await daemonFetch<Registry>('GET', '/api/routing/registry')
    return reg.models.length === 0
  } catch {
    return false
  }
}

/** Interactive first-run setup. No-op returning false when stdin isn't a TTY,
 *  so a piped/CI run never blocks. Assumes the daemon is already running. */
export async function runFirstRun(): Promise<boolean> {
  if (!process.stdin.isTTY) return false

  logger.print('')
  logger.print('Welcome to afw — the local firewall for your AI agents.')
  logger.print('It taps the wire between your agents and their model providers: it sees every')
  logger.print('call, routes it to the model you pick, and guards the untrusted content tool')
  logger.print("calls pull in. Let's configure a model, then connect your agent.")
  logger.print('')

  // 1. Register at least one model provider (reuses the `afw model add`
  //    wizard — base URL, API key, model id, live probe).
  logger.print('Step 1 — add a model provider:')
  let anyModel = false
  for (;;) {
    const added = await addOneProvider()
    if (added?.modelIds.length) anyModel = true
    if (!(await confirmYesNo('Add another provider?', false))) break
  }
  if (!anyModel) {
    logger.print('\nNo model configured. Run `afw onboard` anytime to finish setup.')
    return true
  }

  // 2. Map the three fixed model names (Tall / Grande / Venti) to the models above.
  logger.print('')
  logger.print('Step 2 — map afw’s three model names to your models.')
  logger.print('Agents always ask for Tall / Grande / Venti (low → high); you decide what each is.')
  await runTierWizard()

  // 3. Connect an agent. Claude Code / Codex auto-mint their own session key on
  //    launch; OpenClaw / Hermes get a key here (or later via `afw <agent>`).
  logger.print('')
  logger.print('Step 3 — connect an agent.')
  logger.print(
    '  • Claude Code / Codex:  just run `afw claude` or `afw codex` — a session key is auto-created.',
  )
  logger.print(
    '  • OpenClaw / Hermes / any OpenAI- or Anthropic-compatible agent: needs an API key.',
  )
  logger.print('')
  const NONE = 'Not now'
  const choice = await promptChoice('Mint an API key for an app/daemon agent now?', [
    'openclaw',
    'hermes',
    NONE,
  ] as const)
  if (choice !== NONE) {
    await createAndShowKey({ label: choice, agent: choice as AgentId })
  }

  await updateConfig({ onboarded: true })
  logger.print('')
  logger.print('Done. Mint more keys with `afw openclaw` / `afw hermes`, remap tiers with')
  logger.print('`afw tier`, or open the dashboard with `afw ui`.')
  return true
}
