// launchInstance — spawn one agent process with its own wire identity. Points
// it at `…/wire/<agent>@<instance>` via the agent's per-process seam (see
// wiring.ts), registers a per-instance routing policy, and forwards stdio.
// No shared config is touched. Shared by `afw run` and the per-agent
// launchers (`afw claude`, `afw codex`).

import { spawn } from 'node:child_process'
import process from 'node:process'
import { logger } from '../../core/logger.ts'
import type { ModelEntry } from '../../core/model-registry.ts'
import { type RoutingTarget, policyKeyFor } from '../../core/routing-policy.ts'
import { daemonFetch } from '../util/daemon-client.ts'
import { afwUrlForInstance } from '../wire/url.ts'
import { decideAutoCompactWindow } from './auto-compact.ts'
import { resolveLaunchBin } from './resolve-bin.ts'
import { type LaunchWiring, wiringForBin } from './wiring.ts'

/** Slug a label into a URL/policy-safe instance id; fall back to the pid. */
export function instanceIdFrom(label: string | undefined): string {
  if (label?.trim()) {
    const slug = label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (slug) return slug
  }
  return `pid-${process.pid}`
}

/** Resolve the CLAUDE_CODE_AUTO_COMPACT_WINDOW env to inject so Claude Code
 *  compacts before overflowing a smaller routed model — but only when its
 *  compaction threshold clears the observed baseline (else it would compact on
 *  the first prompt). Best-effort: any daemon hiccup just skips the injection.
 *  Prints a one-line notice so the choice is visible. */
async function resolveAutoCompactEnv(
  agent: string,
  modelId: string,
): Promise<Record<string, string>> {
  try {
    const reg = await daemonFetch<{ models: ModelEntry[] }>('GET', '/api/routing/registry')
    const contextWindow = reg.models.find((m) => m.id === modelId)?.contextWindow
    const { baselineTokens } = await daemonFetch<{ baselineTokens: number | null }>(
      'GET',
      `/api/routing/baseline?agent=${encodeURIComponent(agent)}`,
    )
    const decision = decideAutoCompactWindow({ contextWindow, baselineTokens })
    if (decision.inject) {
      logger.print(
        `  ↳ auto-compact window → ${decision.window} (matches ${modelId}; Claude Code compacts before overflowing it)`,
      )
      return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(decision.window) }
    }
    if (decision.reason === 'baseline-too-high') {
      logger.print(
        `  ↳ auto-compact left off: ${modelId}'s window compacts ~${decision.threshold} tokens, but your baseline context is ~${decision.baselineTokens} — lowering it would compact on the first prompt. Trim CLAUDE.md / MCP tools; afw still clamps output + flags overflow.`,
      )
    }
    return {}
  } catch {
    return {}
  }
}

/** Register (or clear, when target is null) the instance routing policy. */
async function setInstancePolicy(routeKey: string, target: RoutingTarget | null): Promise<void> {
  if (target === null) {
    await daemonFetch('DELETE', `/api/routing/agent?routeKey=${encodeURIComponent(routeKey)}`)
  } else {
    await daemonFetch('POST', '/api/routing/agent', { routeKey, target })
  }
}

export type LaunchInstanceOpts = {
  /** The binary to launch (e.g. `claude`). */
  bin: string
  /** Args to pass through to the binary. */
  args: string[]
  /** Force the agent id instead of inferring from the binary. */
  agentOverride?: string
  /** Resolved instance label (caller derives from --as or the cwd). */
  instanceLabel?: string
  /** Route this instance to one model. */
  model?: string
  /** Capture but never reroute. */
  monitor?: boolean
  /** Bypass afw entirely. */
  raw?: boolean
  /** Remove the instance routing policy when the process exits. */
  ephemeral?: boolean
}

/** Spawn the agent. On child exit this process exits with the child's code —
 *  it is terminal, like a shell wrapper. Throws before spawn if the binary
 *  isn't a known launch-per-task agent or the daemon rejects the policy. */
export async function launchInstance(opts: LaunchInstanceOpts): Promise<void> {
  const wiring: LaunchWiring | undefined = wiringForBin(opts.bin, opts.agentOverride)
  if (!wiring) {
    throw new Error(
      `afw can't launch "${opts.agentOverride ?? opts.bin}" — it wraps launch-per-task agents (claude, codex). For app/daemon agents, run \`afw <agent>\` for setup steps.`,
    )
  }

  const instanceId = instanceIdFrom(opts.instanceLabel)
  const routeKey = policyKeyFor(wiring.agent, '*', instanceId)

  let argvPrefix: string[] = []
  let envOverride: Record<string, string> = {}
  if (!opts.raw) {
    const baseUrl = afwUrlForInstance(wiring.agent, instanceId)
    const target: RoutingTarget | null = opts.monitor
      ? { kind: 'passthrough' }
      : opts.model
        ? { kind: 'chain', members: [{ modelId: opts.model }] }
        : null // inherit the type-level default; still captured per-instance
    if (target !== null) await setInstancePolicy(routeKey, target)
    // For Claude Code routed to a specific model, match its auto-compaction
    // window to the model's so it compacts before overflowing a smaller window.
    const extraEnv =
      wiring.agent === 'claude-code' && !opts.monitor && opts.model
        ? await resolveAutoCompactEnv(wiring.agent, opts.model)
        : {}
    const plan = await wiring.build(baseUrl, extraEnv)
    argvPrefix = plan.argvPrefix
    envOverride = plan.env
  }

  const mode = opts.raw
    ? 'raw (bypassing afw)'
    : opts.monitor
      ? 'monitor-only'
      : opts.model
        ? `→ ${opts.model}`
        : 'type default'
  logger.print(`▶ ${wiring.agent}@${instanceId}  ${mode}`)

  const resolvedBin = await resolveLaunchBin(opts.bin)
  const child = spawn(
    resolvedBin.command,
    [...resolvedBin.argsPrefix, ...argvPrefix, ...opts.args],
    {
      stdio: 'inherit',
      env: { ...process.env, ...envOverride },
      shell: resolvedBin.shell,
    },
  )

  const cleanup = async (): Promise<void> => {
    if (opts.ephemeral && !opts.raw) {
      try {
        await setInstancePolicy(routeKey, null)
      } catch {
        // best-effort; a stale instance policy is harmless and reusable
      }
    }
  }

  child.on('exit', async (code, signal) => {
    await cleanup()
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
  child.on('error', (err) => {
    logger.print(`error: failed to launch ${opts.bin}: ${err.message}`)
    process.exit(127)
  })
}
