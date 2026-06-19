// The subagent cost-saver — afw's headline feature.
//
// Claude Code's dynamic workflows spawn "tens to hundreds of parallel
// subagents in a single session" (Anthropic's words), and they inherit the
// session model — Opus 4.8 by default. Anthropic itself warns the feature
// "can consume substantially more tokens than a typical Claude Code session"
// and offers no knob to make the swarm cheaper. afw does: it reroutes
// the subagent calls to a cheaper model (Sonnet by default) while leaving the
// planner/orchestrator on its requested model — "plan on Opus, swarm on
// Sonnet."
//
// The classification is wire-derivable and exact. Verified against 672 real
// ground-truth calls (isSidechain joined from ~/.claude transcripts): the
// orchestrator-only tools `Agent` / `AskUserQuestion` / `ExitPlanMode` are
// present in 100% of planner calls and absent from 100% of subagent calls —
// subagents can't nest, ask the user, or plan. The system-prompt preamble is
// identical ("You are Claude Code…") and is NOT a discriminator.

import type { AgentId } from '../../core/agent.ts'
import { logger } from '../../core/logger.ts'
import {
  type ModelApi,
  type ModelEntry,
  type ProviderEntry,
  findProvider,
} from '../../core/model-registry.ts'
import type { DecoderKind } from '../../core/routes.ts'
import { effectiveSubagentDowngrade } from '../../core/routing-policy.ts'
import { getModelRegistry, getRoutingPolicy } from '../routing/load.ts'
import { isGenerationPath } from './exec.ts'
import { type ModelRef, type ResolvedRoute, decoderToApi, resolveModelRef } from './resolve.ts'

/** Orchestrator-only tools. Any one present ⇒ the planner/main loop. */
const PLANNER_TOOL_NEEDLES = ['"name":"Agent"', '"name":"AskUserQuestion"', '"name":"ExitPlanMode"']

/** Cron markers each agent prepends to a scheduled-task prompt, observable in
 *  the request body. Hermes: a fixed system-prompt preamble (cron/scheduler.py).
 *  Openclaw: the cron-event prompt builder's lead-in (heartbeat-events-filter.ts
 *  buildCronEventPrompt). These are stable product strings, not user content. */
const CRON_NEEDLES: Record<string, string[]> = {
  hermes: ['[IMPORTANT: You are running as a scheduled cron job.'],
  openclaw: ['A scheduled reminder has been triggered', 'A scheduled cron event was triggered'],
}

/** Floor below which a Claude Code call is a utility call (title-gen, monitor),
 *  not a real subagent worth diverting. Mirrors DEFAULT_SUBAGENT_DOWNGRADE. */
const CHEAP_TASK_UTILITY_FLOOR = 8000

export type ClaudeCodeRole = 'planner' | 'utility' | 'subagent'

/** Why a request qualifies for a combo's cheap model. */
export type CheapTaskRole = 'subagent' | 'cron'

/** Classify a request routed to a fusion combo as a cheap task (or not), by the
 *  agent-specific wire signal: Claude Code subagents by the absence of the
 *  orchestrator-only tools; hermes/openclaw cron jobs by their prompt marker.
 *  Returns undefined for everything else, so a normal request runs the full
 *  fusion. */
export function classifyCheapTask(agent: AgentId, reqBody: ArrayBuffer): CheapTaskRole | undefined {
  const bytes = new Uint8Array(reqBody)
  const cronNeedles = CRON_NEEDLES[agent]
  if (cronNeedles && cronNeedles.some((n) => bytesInclude(bytes, n))) return 'cron'
  if (
    agent === 'claude-code' &&
    classifyClaudeCodeRole(reqBody, CHEAP_TASK_UTILITY_FLOOR) === 'subagent'
  ) {
    return 'subagent'
  }
  return undefined
}

/** Classify a Claude Code Anthropic request body by what it carries on the
 *  wire. Planner detection is a cheap byte scan (no decode) so the hot path —
 *  the planner, which we never touch — pays almost nothing. Only subagent
 *  candidates pay the JSON parse needed for the utility-call floor. */
export function classifyClaudeCodeRole(reqBody: ArrayBuffer, minMaxTokens: number): ClaudeCodeRole {
  const bytes = new Uint8Array(reqBody)
  if (PLANNER_TOOL_NEEDLES.some((n) => bytesInclude(bytes, n))) return 'planner'
  const mt = maxTokensOf(reqBody)
  if (mt !== undefined && mt < minMaxTokens) return 'utility'
  return 'subagent'
}

/** Context the resolver needs — a subset of the orchestrator's WireContext. */
export type SubagentResolveCtx = {
  agent: AgentId
  policyKey: string
  decoder: DecoderKind
  reqMethod: string
  restPath: string
  reqBody: ArrayBuffer | undefined
}

/** If this request is a downgradable Claude Code subagent call, resolve it to
 *  a single-model swap targeting the cheaper model. Otherwise undefined, and
 *  the orchestrator falls back to the normal routing policy (so the planner is
 *  byte-identical passthrough as before). */
export function resolveSubagentDowngrade(ctx: SubagentResolveCtx): ResolvedRoute | undefined {
  // The Agent-tool signal is Claude-Code-specific; gate tightly.
  if (ctx.agent !== 'claude-code') return undefined
  if (ctx.decoder !== 'anthropic') return undefined
  if (ctx.reqMethod !== 'POST' || !ctx.reqBody) return undefined
  const clientApi = decoderToApi(ctx.decoder)
  if (!clientApi) return undefined
  if (!isGenerationPath(clientApi, ctx.restPath)) return undefined

  const cfg = effectiveSubagentDowngrade(getRoutingPolicy())
  if (!cfg.enabled) return undefined

  // Only downgrade the premium tier. The requested model is the policyKey's
  // model component (`claude-code/<model>`); a wildcard (`*`) means the client
  // sent no model, so we can't confirm it's premium and leave it alone. This
  // also stops us from "upgrading" a subagent already on Sonnet/Haiku.
  const requested = stripDisplaySuffix(policyKeyModel(ctx.policyKey))
  if (!requested || !/opus/i.test(requested)) return undefined
  if (requested === cfg.modelId) return undefined

  if (classifyClaudeCodeRole(ctx.reqBody, cfg.minMaxTokens) !== 'subagent') return undefined

  const target = resolveDowngradeTarget(ctx.agent, cfg.modelId, cfg.providerId)
  if (!target) {
    logger.warn(
      `subagent-downgrade: target model "${cfg.modelId}" unresolvable for ${ctx.agent}; ` +
        'leaving the call on its requested model',
    )
    return undefined
  }

  return {
    kind: 'model',
    clientApi,
    model: target.model,
    provider: target.provider,
    api: target.api,
    capabilities: {},
    configuredTarget: { kind: 'model', id: target.model.id },
    downgradedFrom: requested,
  }
}

/** Resolve the downgrade target under the agent's OWN provider — never a
 *  first-match that could borrow another agent's OAuth (e.g. claude-desktop's
 *  token for a claude-code call). Falls back to a synthesized model entry so a
 *  fresh registry that has only ever seen Opus still works: the provider is an
 *  agent-OAuth subscription that bills any Claude model id we forward. */
function resolveDowngradeTarget(
  agent: AgentId,
  modelId: string,
  providerId: string | undefined,
): ModelRef | undefined {
  const reg = getModelRegistry()
  const provider: ProviderEntry | undefined = providerId
    ? findProvider(reg, providerId)
    : reg.providers.find(
        (p) =>
          p.api === 'anthropic-messages' && p.auth.kind === 'agent-oauth' && p.auth.agent === agent,
      )

  if (provider) {
    const scoped = resolveModelRef(modelId, provider.id)
    if (scoped) return scoped
    // Not seen in traffic yet — synthesize. agent-oauth needs no secret, so
    // the provider is usable as-is.
    const model: ModelEntry = {
      id: modelId,
      providerId: provider.id,
      label: modelId,
      input: ['text', 'image'],
      origin: 'manual',
    }
    const api: ModelApi = provider.api
    return { model, provider, api }
  }

  // No agent-OAuth provider in the registry — last resort, first-match by id.
  return resolveModelRef(modelId, providerId)
}

// ── helpers ───────────────────────────────────────────────────────

/** The model component of a policyKey `<agent>/<model>` (or `*`). */
function policyKeyModel(policyKey: string): string {
  const slash = policyKey.indexOf('/')
  return slash >= 0 ? policyKey.slice(slash + 1) : ''
}

/** Drop a trailing display suffix like `[1m]` (Claude Code's 1M-context UI
 *  marker) so `claude-opus-4-8[1m]` reads as `claude-opus-4-8`. */
function stripDisplaySuffix(model: string): string {
  return model.replace(/\s*\[[^\]]*\]\s*$/, '').trim()
}

/** Read top-level `max_tokens` from a JSON request body, or undefined. */
function maxTokensOf(body: ArrayBuffer): number | undefined {
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(body))
    if (json && typeof json === 'object') {
      const mt = (json as Record<string, unknown>).max_tokens
      if (typeof mt === 'number') return mt
    }
  } catch {
    // non-JSON — treat as unknown
  }
  return undefined
}

/** Substring search over UTF-8 bytes — avoids decoding a ~1.6 MB planner body
 *  just to look for a tool name. */
function bytesInclude(haystack: Uint8Array, needle: string): boolean {
  const n = new TextEncoder().encode(needle)
  if (n.length === 0 || n.length > haystack.length) return false
  outer: for (let i = 0; i <= haystack.length - n.length; i++) {
    for (let j = 0; j < n.length; j++) {
      if (haystack[i + j] !== n[j]) continue outer
    }
    return true
  }
  return false
}
