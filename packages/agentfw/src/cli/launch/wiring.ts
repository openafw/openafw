// Per-agent launch wiring. Each entry knows how to point ONE launched process
// at a custom base URL without touching the agent's shared config — the
// per-instance firewall seam. Two seam kinds exist:
//   • settings-env  (Claude Code): inject ANTHROPIC_BASE_URL through the
//     clobber-proof `--settings` inline-JSON override.
//   • config-flags  (Codex): emit `-c key=value` overrides, which beat
//     ~/.codex/config.toml for that invocation only.
// This mirrors references/claude-code-router's `ccr code` mechanism.

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import process from 'node:process'
import type { AgentId } from '../../core/agent.ts'
import { paths } from '../../core/paths.ts'
import { parseJsonc } from '../rewrite/jsonc.ts'

/** What to prepend to the launched argv and merge into its environment so the
 *  process talks to `baseUrl` instead of the real provider. */
export type LaunchPlan = { argvPrefix: string[]; env: Record<string, string> }

export type LaunchWiring = {
  agent: AgentId
  /** Binary names that map to this wiring (the user types one of these). */
  bins: string[]
  /** Build the override for a wired launch pointed at `baseUrl`. `extraEnv`
   *  carries agentfw-derived env vars (e.g. CLAUDE_CODE_AUTO_COMPACT_WINDOW)
   *  that the wiring injects without clobbering a value the user already set. */
  build(baseUrl: string, extraEnv?: Record<string, string>): Promise<LaunchPlan>
}

async function readAgentEnv(settingsPath: string): Promise<Record<string, string>> {
  try {
    const text = await readFile(settingsPath, 'utf8')
    const parsed = parseJsonc<{ env?: Record<string, string> }>(text)
    return parsed?.env && typeof parsed.env === 'object' ? { ...parsed.env } : {}
  } catch {
    return {}
  }
}

const CLAUDE_CODE: LaunchWiring = {
  agent: 'claude-code',
  bins: ['claude', 'claude-code'],
  // Claude Code merges the inline `--settings` JSON's `env` over every settings
  // file, so it's the only seam global settings.json can't clobber. Preserve
  // the user's other env keys; override only ANTHROPIC_BASE_URL.
  async build(baseUrl, extraEnv) {
    const env = await readAgentEnv(paths.agent.claudeCode.settings)
    env.ANTHROPIC_BASE_URL = baseUrl
    // Inject agentfw-derived vars only when the user hasn't set them in their
    // settings file or shell — never override an explicit choice.
    for (const [k, v] of Object.entries(extraEnv ?? {})) {
      if (env[k] === undefined && process.env[k] === undefined) env[k] = v
    }
    return { argvPrefix: ['--settings', JSON.stringify({ env })], env: {} }
  },
}

const CODEX: LaunchWiring = {
  agent: 'codex',
  bins: ['codex'],
  // Codex has no base-URL env var; its `-c key=value` flags override
  // config.toml per-invocation. Register an `agentfw` provider inline and
  // select it. Mirrors codex.ts's AGENTFW_PROVIDER_DEFAULTS.
  async build(baseUrl) {
    const argvPrefix = [
      '-c',
      'model_provider=agentfw',
      '-c',
      `model_providers.agentfw.base_url="${baseUrl}"`,
      '-c',
      'model_providers.agentfw.name="agentfw (OpenAI)"',
      '-c',
      'model_providers.agentfw.wire_api="responses"',
      '-c',
      'model_providers.agentfw.requires_openai_auth=true',
    ]
    return { argvPrefix, env: {} }
  },
}

const WIRINGS: readonly LaunchWiring[] = [CLAUDE_CODE, CODEX]

/** Wiring for an agent id (the registry key). */
export function wiringForAgent(agent: AgentId): LaunchWiring | undefined {
  return WIRINGS.find((w) => w.agent === agent)
}

/** Wiring for a launched binary — its basename is the signal
 *  (`claude` → claude-code). `override` forces the agent id. */
export function wiringForBin(bin: string, override?: string): LaunchWiring | undefined {
  if (override) return wiringForAgent(override)
  const name = basename(bin)
  return WIRINGS.find((w) => w.bins.includes(name))
}
