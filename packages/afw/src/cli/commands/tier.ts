// `afw tier` — map the three fixed model names (Tall / Grande / Venti, low →
// high) to your own configured models. Each tier can map to a single model, a
// token-limit failover chain, or a Fusion combo. The /v1 endpoint selects a
// tier by the request's model name. The interactive wizard is reused by
// first-run (cli/launch/first-run.ts).

import process from 'node:process'
import { Command } from 'commander'
import { logger } from '../../core/logger.ts'
import type { CombinationModel, ModelEntry, ProviderEntry } from '../../core/model-registry.ts'
import type { RoutingTarget, SwitchPeriod } from '../../core/routing-policy.ts'
import { ensureDaemonRunning } from '../launch/daemon-autostart.ts'
import { daemonFetch } from '../util/daemon-client.ts'
import { confirmYesNo, promptChoice, promptText } from '../util/prompt.ts'

type Registry = { providers: ProviderEntry[]; models: ModelEntry[]; combos: CombinationModel[] }
type TierRow = { tier: string; display: string; rank: number; target?: RoutingTarget }
type TiersResponse = { tiers: TierRow[] }

const SINGLE = 'A single model'
const FALLBACK = 'A model with a token-limit fallback'
const FUSION = 'An existing Fusion combo'
const SKIP = 'Skip (leave unmapped)'

function describeTarget(t: RoutingTarget | undefined): string {
  if (!t || t.kind === 'passthrough') return '(unmapped)'
  if (t.kind === 'composite') return `fusion ${t.comboId}`
  if (t.kind === 'chain') {
    return t.members.length === 1
      ? `model ${t.members[0]!.modelId}`
      : `${t.members.map((m) => m.modelId).join(' → ')} (failover)`
  }
  return '(unmapped)'
}

function modelLabel(m: ModelEntry, providers: ProviderEntry[]): string {
  const prov = providers.find((p) => p.id === m.providerId)?.label ?? m.providerId
  return `${m.id}  (${prov})`
}

async function pickModel(
  reg: Registry,
  prompt: string,
): Promise<{ modelId: string; providerId: string } | null> {
  if (reg.models.length === 0) return null
  const labels = reg.models.map((m) => modelLabel(m, reg.providers))
  const chosen = await promptChoice(prompt, labels)
  const idx = labels.indexOf(chosen)
  const m = reg.models[idx >= 0 ? idx : 0]!
  return { modelId: m.id, providerId: m.providerId }
}

/** Build a routing target interactively. Returns null to skip this tier. */
async function buildTarget(reg: Registry, tierName: string): Promise<RoutingTarget | null> {
  const choices =
    reg.combos.length > 0 ? [SINGLE, FALLBACK, FUSION, SKIP] : [SINGLE, FALLBACK, SKIP]
  const kind = await promptChoice(`Map ${tierName} to…`, choices)
  if (kind === SKIP) return null

  if (kind === FUSION) {
    const labels = reg.combos.map((c) => `${c.label}  (${c.id})`)
    const chosen = await promptChoice('Which Fusion combo?', labels)
    const idx = labels.indexOf(chosen)
    return { kind: 'composite', comboId: reg.combos[idx >= 0 ? idx : 0]!.id }
  }

  const primary = await pickModel(reg, 'Model')
  if (!primary) return null
  if (kind === SINGLE) return { kind: 'chain', members: [primary] }

  const limitRaw = await promptText('Token limit before failover (e.g. 1000000)', '1000000')
  const tokenLimit = Math.max(0, Number.parseInt(limitRaw, 10) || 0)
  const period = (await promptChoice('Measured over', ['day', 'month'])) as SwitchPeriod
  const fallback = await pickModel(reg, 'Fallback model (used after the limit)')
  if (!fallback) return { kind: 'chain', members: [primary] }
  return {
    kind: 'chain',
    members: [
      { ...primary, switchOn: [{ kind: 'tokens', tokenLimit, period }, { kind: 'error' }] },
      fallback,
    ],
  }
}

async function setTier(tier: string, target: RoutingTarget): Promise<void> {
  await daemonFetch('POST', '/api/tiers', { tier, target })
}

/** Interactive: walk the three tiers and map each. Assumes the daemon is up. */
export async function runTierWizard(): Promise<void> {
  const reg = await daemonFetch<Registry>('GET', '/api/routing/registry')
  if (reg.models.length === 0) {
    logger.print('No models registered yet — run `afw model add` first.')
    return
  }
  const { tiers } = await daemonFetch<TiersResponse>('GET', '/api/tiers')
  logger.print('Map the three model names (Tall / Grande / Venti, low → high) to your models:')
  for (const row of tiers) {
    const current = row.target ? `  [currently: ${describeTarget(row.target)}]` : ''
    logger.print('')
    logger.print(`${row.display}${current}`)
    const target = await buildTarget(reg, row.display)
    if (target) {
      await setTier(row.tier, target)
      logger.print(`  ✓ ${row.display} → ${describeTarget(target)}`)
    }
  }
}

// ── subcommands ───────────────────────────────────────────────────

const listCmd = new Command('list')
  .description('Show the three model tiers and what each maps to.')
  .action(async () => {
    try {
      const { tiers } = await daemonFetch<TiersResponse>('GET', '/api/tiers')
      for (const t of tiers) {
        logger.print(`  ${t.display.padEnd(8)} (${t.tier.padEnd(6)}) → ${describeTarget(t.target)}`)
      }
    } catch (e) {
      logger.print(`error: ${(e as Error).message}`)
      process.exitCode = 1
    }
  })

const setCmd = new Command('set')
  .description('Map a tier (Tall, Grande, or Venti) to a model or fusion.')
  .argument('<tier>', 'tier name: Tall | Grande | Venti (case-insensitive)')
  .option('--model <id>', 'map to a single model')
  .option('--provider <id>', 'disambiguate the model when it exists under several providers')
  .option('--fusion <comboId>', 'map to an existing Fusion combo')
  .action(async (tier: string, opts: { model?: string; provider?: string; fusion?: string }) => {
    try {
      await ensureDaemonRunning()
      if (opts.model || opts.fusion) {
        const target: RoutingTarget = opts.fusion
          ? { kind: 'composite', comboId: opts.fusion }
          : {
              kind: 'chain',
              members: [
                { modelId: opts.model!, ...(opts.provider ? { providerId: opts.provider } : {}) },
              ],
            }
        await setTier(tier, target)
        logger.print(`✓ ${tier} → ${describeTarget(target)}`)
        return
      }
      // Interactive single-tier mapping.
      const reg = await daemonFetch<Registry>('GET', '/api/routing/registry')
      if (reg.models.length === 0) {
        logger.print('No models registered yet — run `afw model add` first.')
        process.exitCode = 1
        return
      }
      const target = await buildTarget(reg, tier)
      if (!target) {
        logger.print('No change.')
        return
      }
      await setTier(tier, target)
      logger.print(`✓ ${tier} → ${describeTarget(target)}`)
    } catch (e) {
      logger.print(`error: ${(e as Error).message}`)
      process.exitCode = 1
    }
  })

const unsetCmd = new Command('unset')
  .description('Clear a tier mapping.')
  .argument('<tier>', 'tier name: Tall | Grande | Venti (case-insensitive)')
  .action(async (tier: string) => {
    try {
      await daemonFetch('DELETE', `/api/tiers?tier=${encodeURIComponent(tier)}`)
      logger.print(`✓ cleared ${tier}`)
    } catch (e) {
      logger.print(`error: ${(e as Error).message}`)
      process.exitCode = 1
    }
  })

export const tierCommand = new Command('tier')
  .description('Map the three model names (Tall / Grande / Venti) to your configured models.')
  .addCommand(listCmd)
  .addCommand(setCmd)
  .addCommand(unsetCmd)
  .action(async () => {
    // Bare `afw tier` → interactive wizard for all three.
    try {
      await ensureDaemonRunning()
      if (!process.stdin.isTTY) {
        logger.print('Run `afw tier` in a terminal, or use `afw tier set <tier> --model <id>`.')
        process.exitCode = 1
        return
      }
      await runTierWizard()
    } catch (e) {
      logger.print(`error: ${(e as Error).message}`)
      process.exitCode = 1
    }
  })
