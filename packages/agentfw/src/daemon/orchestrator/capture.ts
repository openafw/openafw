// Capture for the buffered orchestrator paths. One client request fans out to
// N upstream calls; this builds the AgentPackets that record it.
//
//   single cross-protocol swap → one packet (role 'primary')
//   chain                      → one parent (model = entry-point id, cost $0)
//                                plus one child per upstream call — failover
//                                attempts and vision-loop turns alike —
//                                carrying the real model, status, tokens, cost
//
// Children carry the money so run/thread rollups (which SUM over `actions`)
// stay correct with no aggregate-query changes. The client-facing request
// fields (system / messages / tools) are recorded in the client's own wire
// format so run-detail renders them unchanged.

import type { AgentId } from '../../core/agent.ts'
import { type ActionId, type RunId, type ThreadId, newActionId, newRunId } from '../../core/ids.ts'
import type { ModelApi } from '../../core/model-registry.ts'
import type {
  AgentPacket,
  ModelCallPayload,
  NormalizedBlock,
  Orchestration,
  RiskTag,
  ToolCallPayload,
} from '../../core/packet.ts'
import type { DecoderKind } from '../../core/routes.ts'
import { computeCost } from '../cost/compute.ts'
import { correlatedThreadId, deriveThreadTitle, effectiveInstanceId } from '../decoders/correlate.ts'
import { inputToMessages } from '../decoders/openai/responses.ts'
import { appendPacket, appendPacketTree } from '../store/writer.ts'
import type { IRResponse, IRUsage } from '../translate/ir.ts'
import { type AttemptResult, apiToDecoder } from './exec.ts'
import type { ResolvedMember } from './resolve.ts'

export type CaptureCtx = {
  agent: AgentId
  /** The client's decoder — the parent packet's protocol. */
  decoder: DecoderKind
  /** Wire-derived agent instance (the `@<instance>` path segment). When
   *  set it is authoritative; otherwise capture falls back to the
   *  wrapper-model suffix. */
  instanceId?: string
}

/** A tool agentfw executed locally as part of an emulation loop —
 *  today web_search, future web_fetch / browser / etc. captureChain
 *  wraps each one as a tool_call child packet under the same parent
 *  as the model_call attempts, so the dashboard surfaces it as a
 *  sibling row with the provider + backend visible at a glance. */
export type CapturedToolExecution = {
  /** Where in the wall-clock timeline this execution sat — sort key
   *  for the dashboard's per-run action list. */
  ts: number
  durMs: number
  /** USD attributed to this single tool call. Comes from the tool
   *  provider's costPerCall when set; otherwise zero. Rolls up into
   *  the parent run's total cost via the existing actions-sum
   *  aggregation. */
  costUsd?: number
} & Omit<ToolCallPayload, 'kind'>

/** One member's place in a fan-out: which model, the call's outcome, and the
 *  role/step the captured child packet records. */
export type RoutedAttempt = {
  member: ResolvedMember
  result: AttemptResult
  role: Orchestration['role']
  step: number
  /** The request this attempt actually sent, when it differs from the client's
   *  original — set by the vision loop so each child packet records its real
   *  per-turn conversation rather than the untouched client request. */
  request?: { api: ModelApi; body: Record<string, unknown> }
}

// ── client-side request fields ────────────────────────────────────

type ClientFields = {
  systemPrompt: string | undefined
  messages: unknown[]
  tools: unknown[] | undefined
}

/** Pull the system prompt out of an OpenAI-Chat message list — `system` and
 *  `developer` turns with string content. */
function extractChatSystem(messages: unknown[]): string | undefined {
  const parts: string[] = []
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const msg = m as Record<string, unknown>
    if (msg.role !== 'system' && msg.role !== 'developer') continue
    if (typeof msg.content === 'string') parts.push(msg.content)
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** The client-facing request fields, read in the client's own wire format so
 *  the captured packet renders as the agent actually sent it. */
function clientFields(clientApi: ModelApi, req: Record<string, unknown>): ClientFields {
  if (clientApi === 'anthropic-messages') {
    return {
      systemPrompt: typeof req.system === 'string' ? req.system : undefined,
      messages: Array.isArray(req.messages) ? req.messages : [],
      tools: Array.isArray(req.tools) ? req.tools : undefined,
    }
  }
  if (clientApi === 'openai-chat') {
    const messages = Array.isArray(req.messages) ? req.messages : []
    return {
      systemPrompt: extractChatSystem(messages),
      messages,
      tools: Array.isArray(req.tools) ? req.tools : undefined,
    }
  }
  // openai-responses
  return {
    systemPrompt: typeof req.instructions === 'string' ? req.instructions : undefined,
    messages: inputToMessages(req.input),
    tools: Array.isArray(req.tools) ? req.tools : undefined,
  }
}

// ── attempt-side response fields ──────────────────────────────────

type AttemptFields = {
  response: NormalizedBlock[]
  stopReason: string | undefined
  status: number
  error: string | undefined
  errorHeaders: Record<string, string> | undefined
  usage: IRUsage
  usd: number
}

/** The response fields for one attempt — blocks, status, usage, and the real
 *  cost computed against the member's actual model. */
function attemptFields(member: ResolvedMember, result: AttemptResult): AttemptFields {
  if (result.ok) {
    const usage = result.ir.usage
    return {
      response: result.ir.blocks,
      stopReason: result.ir.stopReason,
      status: result.status,
      error: undefined,
      errorHeaders: undefined,
      usage,
      usd: computeCost({
        decoder: apiToDecoder(member.api),
        model: member.model.id,
        inputTokens: usage.in,
        outputTokens: usage.out,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
      }),
    }
  }
  return {
    response: [],
    stopReason: undefined,
    status: result.status || 502,
    error: result.errorText,
    errorHeaders: result.errorHeaders,
    usage: { in: 0, out: 0 },
    usd: 0,
  }
}

/** The client's original `body.model`, as a string when it was a non-empty
 *  string and never the empty/undefined fallback. Used to populate
 *  `clientModel` on captured packets so the UI can show the swap. */
function readClientModel(req: Record<string, unknown>): string | undefined {
  return typeof req.model === 'string' && req.model !== '' ? req.model : undefined
}

/** Wrap a CapturedToolExecution as a tool_call AgentPacket sibling
 *  under the same parent as the model_call children. cost is $0
 *  (agentfw ran the tool locally — any spend is the backend's
 *  responsibility, not the model's). */
function buildToolCallPacket(
  ctx: CaptureCtx,
  parent: { runId: RunId; threadId: ThreadId; parentId: ActionId },
  exec: CapturedToolExecution,
): AgentPacket {
  const { ts, durMs, costUsd, ...payload } = exec
  return {
    id: newActionId(),
    runId: parent.runId,
    threadId: parent.threadId,
    parentActionId: parent.parentId,
    ts,
    durMs,
    sourceAgent: ctx.agent,
    // Provider's costPerCall × 1; absent or 0 for keyless backends.
    cost: { usd: costUsd ?? 0, tokensIn: 0, tokensOut: 0 },
    payload: { kind: 'tool_call', ...payload },
  }
}

/** Assemble one model_call payload from a client request and one attempt. */
function buildPayload(
  clientApi: ModelApi,
  protocol: DecoderKind,
  cf: ClientFields,
  member: ResolvedMember,
  result: AttemptResult,
  af: AttemptFields,
  orchestration: Orchestration,
  clientModel: string | undefined,
): ModelCallPayload {
  return {
    kind: 'model_call',
    protocol,
    endpoint: result.upstreamUrl,
    model: member.model.id,
    ...(clientModel && clientModel !== member.model.id ? { clientModel } : {}),
    providerId: member.provider.id,
    systemPrompt: cf.systemPrompt,
    messages: cf.messages,
    tools: cf.tools,
    stream: false,
    response: af.response,
    stopReason: af.stopReason,
    status: af.status,
    error: af.error,
    ...(af.errorHeaders ? { errorHeaders: af.errorHeaders } : {}),
    orchestration,
  }
}

// ── single swap ───────────────────────────────────────────────────

/** Capture a single (cross-protocol) model swap as one packet. */
export async function captureSingle(
  ctx: CaptureCtx,
  clientApi: ModelApi,
  req: Record<string, unknown>,
  attempt: RoutedAttempt,
  configuredTarget: { kind: 'model'; id: string },
): Promise<void> {
  const { member, result } = attempt
  const cf = clientFields(clientApi, req)
  const af = attemptFields(member, result)

  const orchestration: Orchestration = {
    role: attempt.role,
    configuredTarget,
    ...(member.api !== clientApi ? { translated: { from: clientApi, to: member.api } } : {}),
  }

  const threadTitle = deriveThreadTitle(cf.messages)
  const instanceId = effectiveInstanceId(ctx.instanceId, ctx.agent, readClientModel(req))
  const packet: AgentPacket = {
    id: newActionId(),
    runId: newRunId(),
    threadId: correlatedThreadId(ctx.agent, cf.messages, instanceId),
    ...(threadTitle ? { threadTitle } : {}),
    ...(instanceId ? { instanceId } : {}),
    ts: result.startedAtWall,
    durMs: result.durMs,
    sourceAgent: ctx.agent,
    cost: {
      usd: af.usd,
      tokensIn: af.usage.in,
      tokensOut: af.usage.out,
      tokensCacheRead: af.usage.cacheRead,
      tokensCacheWrite: af.usage.cacheWrite,
    },
    payload: buildPayload(
      clientApi,
      apiToDecoder(member.api),
      cf,
      member,
      result,
      af,
      orchestration,
      readClientModel(req),
    ),
  }

  await appendPacket(packet)
}

// ── chain ─────────────────────────────────────────────────────────

/** Build one child packet for a chain fan-out. An attempt that carries its
 *  own `request` (a vision-loop turn) is recorded in that request's wire
 *  format; a plain failover attempt falls back to the client request. */
function buildChildPacket(
  ctx: CaptureCtx,
  clientApi: ModelApi,
  req: Record<string, unknown>,
  ids: { runId: RunId; threadId: ThreadId; parentId: ActionId },
  attempt: RoutedAttempt,
): AgentPacket {
  const { member, result } = attempt
  const af = attemptFields(member, result)
  const reqApi = attempt.request?.api ?? clientApi
  const cf = clientFields(reqApi, attempt.request?.body ?? req)
  const orchestration: Orchestration = {
    role: attempt.role,
    step: attempt.step,
    ...(member.api !== reqApi ? { translated: { from: reqApi, to: member.api } } : {}),
  }
  return {
    id: newActionId(),
    runId: ids.runId,
    threadId: ids.threadId,
    parentActionId: ids.parentId,
    ts: result.startedAtWall,
    durMs: result.durMs,
    sourceAgent: ctx.agent,
    cost: {
      usd: af.usd,
      tokensIn: af.usage.in,
      tokensOut: af.usage.out,
      tokensCacheRead: af.usage.cacheRead,
      tokensCacheWrite: af.usage.cacheWrite,
    },
    payload: buildPayload(
      reqApi,
      apiToDecoder(member.api),
      cf,
      member,
      result,
      af,
      orchestration,
      // The child carries the model the agent originally asked for —
      // not the per-turn vision-loop request — so the swap line in
      // the UI matches what the user saw on their end.
      readClientModel(req),
    ),
  }
}

/** Capture a chain run as a parent (model = entry-point id, cost $0) plus one
 *  child per upstream call — failover attempts and vision-loop turns alike.
 *  `winner` is the answer the orchestrator returned to the client, or undefined
 *  when every member failed. Any risk tag the run raised rides on the parent. */
export async function captureChain(
  ctx: CaptureCtx,
  clientApi: ModelApi,
  req: Record<string, unknown>,
  attempts: RoutedAttempt[],
  winner: { ir: IRResponse; status: number } | undefined,
  // Widened to also accept a 'model' target: the multi-attempt capture
  // shape is reused by runBuffered when a single-model route fires the
  // vision loop. The capture path only reads `id` for the parent row;
  // the discriminator is recorded verbatim on the orchestration tag so
  // the UI can still distinguish.
  configuredTarget:
    | { kind: 'chain'; id: string }
    | { kind: 'model'; id: string }
    | { kind: 'combo'; id: string },
  parentTiming: { ts: number; durMs: number },
  risk: RiskTag[],
  /** Tool executions agentfw ran during this fan-out (web_search via
   *  DDG, web_fetch, …). Captured as additional tool_call children so
   *  the user can see what backend served each tool the model called. */
  toolExecutions: CapturedToolExecution[] = [],
): Promise<void> {
  if (attempts.length === 0 && toolExecutions.length === 0) return

  const cf = clientFields(clientApi, req)
  const runId = newRunId()
  const instanceId = effectiveInstanceId(ctx.instanceId, ctx.agent, readClientModel(req))
  const threadId = correlatedThreadId(ctx.agent, cf.messages, instanceId)
  const threadTitle = deriveThreadTitle(cf.messages)
  const parentId = newActionId()

  const children: AgentPacket[] = attempts.map((attempt) =>
    buildChildPacket(ctx, clientApi, req, { runId, threadId, parentId }, attempt),
  )
  for (const exec of toolExecutions) {
    children.push(buildToolCallPacket(ctx, { runId, threadId, parentId }, exec))
  }
  // Children carry the money, so they need the instance too (per-instance
  // cost rolls up over child actions). Same instance for the whole tree.
  if (instanceId) for (const c of children) c.instanceId = instanceId

  // The parent mirrors the client-facing answer: the winner if there is one,
  // else the last attempt's failure so a total failure still records it.
  const lastResult = attempts[attempts.length - 1]?.result
  const failedResult = !winner && lastResult && !lastResult.ok ? lastResult : undefined
  const status = winner
    ? winner.status
    : failedResult && failedResult.status >= 400
      ? failedResult.status
      : 502

  const parent: AgentPacket = {
    id: parentId,
    runId,
    threadId,
    ...(threadTitle ? { threadTitle } : {}),
    ...(instanceId ? { instanceId } : {}),
    ts: parentTiming.ts,
    durMs: parentTiming.durMs,
    sourceAgent: ctx.agent,
    cost: { usd: 0, tokensIn: 0, tokensOut: 0 },
    ...(risk.length > 0 ? { risk } : {}),
    payload: {
      kind: 'model_call',
      protocol: ctx.decoder,
      endpoint: lastResult?.upstreamUrl ?? '',
      model: configuredTarget.id,
      ...(() => {
        const cm = readClientModel(req)
        return cm && cm !== configuredTarget.id ? { clientModel: cm } : {}
      })(),
      systemPrompt: cf.systemPrompt,
      messages: cf.messages,
      tools: cf.tools,
      stream: false,
      response: winner ? winner.ir.blocks : [],
      stopReason: winner ? winner.ir.stopReason : undefined,
      status,
      error: winner ? undefined : (failedResult?.errorText ?? 'all chain members failed'),
      ...(failedResult?.errorHeaders ? { errorHeaders: failedResult.errorHeaders } : {}),
      orchestration: { role: 'parent', configuredTarget },
    },
  }

  await appendPacketTree(parent, children)
}
