// First-run onboarding. agentfw taps the wire but does nothing useful until it
// knows where to send traffic, so the first time a user launches an agent (or
// runs `agentfw onboard`) we walk them through picking a model provider + model
// and wire it as that agent's default route. The alternative — pass traffic
// through to the agent's own provider unchanged — is offered as an explicit
// choice so existing setups aren't blocked. Re-runnable; gated so it only
// fires on a fresh install.

import process from 'node:process'
import type { AgentId } from '../../core/agent.ts'
import { readConfig, updateConfig } from '../../core/config.ts'
import { logger } from '../../core/logger.ts'
import type { ModelEntry, ProviderEntry } from '../../core/model-registry.ts'
import { addOneProvider } from '../commands/model.ts'
import { daemonFetch } from '../util/daemon-client.ts'
import { confirmYesNo, promptChoice } from '../util/prompt.ts'

type Registry = { providers: ProviderEntry[]; models: ModelEntry[] }

const CONFIGURE = 'Configure a model provider (recommended)'

const PASSTHROUGH_LABEL: Record<string, string> = {
  'claude-code':
    "Use Claude's own Anthropic account (passthrough — capture & guard, no model swap)",
  codex: "Use Codex's own OpenAI account (passthrough — capture & guard, no model swap)",
}

function passthroughLabelFor(agent: AgentId): string {
  return (
    PASSTHROUGH_LABEL[agent] ?? 'Pass traffic through unchanged (capture & guard, no model swap)'
  )
}

/** True when there's no usable model registered and the user hasn't already
 *  opted into passthrough — i.e. a fresh install that still needs setup.
 *  Returns false (don't block) when the daemon can't be reached. */
export async function needsOnboarding(): Promise<boolean> {
  const cfg = await readConfig()
  if (cfg.onboarded) return false
  try {
    const reg = await daemonFetch<Registry>('GET', '/api/routing/registry')
    return reg.models.length === 0
  } catch {
    return false
  }
}

/** Point the agent's type-level default route at a configured model so its
 *  traffic is actually swapped — not merely registered. Every instance of the
 *  agent inherits `<agent>/*` unless a per-dir/per-instance override wins. */
async function routeAgentTo(agent: AgentId, modelId: string, providerId: string): Promise<void> {
  await daemonFetch('POST', '/api/routing/agent', {
    routeKey: `${agent}/*`,
    target: { kind: 'chain', members: [{ modelId, providerId }] },
  })
}

/** Interactive first-run setup for `agent`. Either configures a model (and
 *  wires the route) or records the user's choice to pass traffic through.
 *  No-op returning false when stdin isn't a TTY — never block a piped/CI run. */
export async function runOnboarding(agent: AgentId): Promise<boolean> {
  if (!process.stdin.isTTY) return false

  logger.print('')
  logger.print("Welcome to agentfw — let's set up where this agent's traffic should go.")
  logger.print('agentfw sits on the wire between your agent and its model provider: it sees')
  logger.print('every call, can route it to the model you pick, and guards the untrusted')
  logger.print('content tool calls pull in. Choose how to route — change it anytime with')
  logger.print('`agentfw model` / `agentfw route`, or in the dashboard.')
  logger.print('')

  const choice = await promptChoice('How should agentfw route this agent?', [
    CONFIGURE,
    passthroughLabelFor(agent),
  ] as const)

  if (choice !== CONFIGURE) {
    await updateConfig({ onboarded: true })
    logger.print(
      '\n✓ Passthrough selected — agentfw captures and guards traffic without swapping the model.',
    )
    return true
  }

  // Reuse the exact `model add` wizard; allow several providers, route the
  // agent to the first model registered.
  let first: { modelId: string; providerId: string } | undefined
  for (;;) {
    const added = await addOneProvider()
    if (added?.modelIds[0] && !first) {
      first = { modelId: added.modelIds[0], providerId: added.providerId }
    }
    if (!(await confirmYesNo('Add another provider?', false))) break
  }

  if (!first) {
    logger.print('\nNo model configured — leaving this agent on passthrough for now.')
    await updateConfig({ onboarded: true })
    return true
  }

  await routeAgentTo(agent, first.modelId, first.providerId)
  await updateConfig({ onboarded: true })
  logger.print(`\n✓ ${agent} now routes to ${first.modelId} (${first.providerId}).`)
  logger.print(
    `  Change it later with \`agentfw route set ${agent}/* --model <id>\` or the dashboard.`,
  )
  return true
}

/** Launcher gate: run onboarding once on a fresh install. Safe to call every
 *  launch — returns immediately once configured or in a non-interactive run. */
export async function ensureOnboarded(agent: AgentId): Promise<void> {
  if (await needsOnboarding()) await runOnboarding(agent)
}
