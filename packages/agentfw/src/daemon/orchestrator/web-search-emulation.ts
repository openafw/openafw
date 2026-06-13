// Web-search tool emulation for non-Anthropic upstreams.
//
// Anthropic ships `web_search_20250305` as a server tool: the model
// emits `server_tool_use(name="web_search")`, the API runs the search
// inline and splices `web_search_tool_result` blocks into the same
// response. When agentfw routes that request to a non-Anthropic
// upstream (DeepSeek's /anthropic, GLM, OpenAI-compatible providers),
// the destination has no executor for the magic `type` and the search
// either silently fails or returns nothing.
//
// This module makes agentfw the executor instead:
//
//   1. `rewriteAnthropicWebSearchTool` swaps `{type:'web_search_20250305',
//      name:'web_search', allowed_domains?, blocked_domains?, max_uses?}`
//      in the request's tools[] for a regular custom tool with the same
//      name and a proper JSON-schema input. The destination model now
//      sees a normal client tool it knows how to call.
//
//   2. `runWebSearchEmulationLoop` wraps the buffered model call. When
//      the response contains `tool_use(name="web_search", input)`, the
//      loop runs the user-configured backend (DDG / Brave / SearXNG via
//      core/web-search/backends.ts + tool-providers.json), feeds the
//      results back as a `tool_result`, and re-runs the model until it
//      stops calling the tool or hits the iteration cap.
//
// v1 scope:
//   - Anthropic-to-Anthropic-compat only (caller checks clientApi === 'anthropic-messages'
//     && member.api === 'anthropic-messages'). Cross-protocol uses agentfw's
//     translate layer to lift to IR; that's a v2 extension.
//   - Buffered only (streaming requests collapse to buffered + synthesized SSE
//     in the caller, same pattern vision-loop uses).
//   - Final response is the model's final assistant turn — no
//     server_tool_use / web_search_tool_result block synthesis on the way
//     back yet. Claude Desktop's renderer shows the answer text; Claude
//     Code's wrapper-tool parser needs the synthesis, deferred to v2.

import type { AgentId } from '../../core/agent.ts'
import { logger } from '../../core/logger.ts'
import type { ModelApi } from '../../core/model-registry.ts'
import type { NormalizedBlock } from '../../core/packet.ts'
import {
  searchBaidu,
  searchBrave,
  searchDuckDuckGo,
  type WebSearchOutcome,
  type WebSearchResult,
} from '../../core/web-search/backends.ts'
import { getSecret } from '../../core/secrets.ts'
import {
  activeProviderFor,
  readToolProviders,
  type ToolProvider,
} from '../../core/tool-providers.ts'
import { execAttempt, type AttemptResult } from './exec.ts'
import type { ResolvedMember } from './resolve.ts'
import type { CapturedToolExecution, RoutedAttempt } from './capture.ts'

export const WEB_SEARCH_SERVER_TOOL_TYPE = 'web_search_20250305'
export const WEB_SEARCH_TOOL_NAME = 'web_search'
/** Claude Code / Claude Desktop ship a built-in `WebSearch` function tool
 *  (PascalCase). When the agent's runtime injects it into the request,
 *  the routed model will call it instead of the server-tool variant.
 *  The input schema matches `web_search_20250305` (query + optional
 *  allowed/blocked domains) so the same intercept loop handles both. */
export const WEB_SEARCH_CLIENT_TOOL_NAME = 'WebSearch'
const DEFAULT_MAX_USES = 5

/** True when the request carries an interceptable web-search tool —
 *  Anthropic's server tool by type, OR Claude's built-in `WebSearch`
 *  function tool by name. Both trigger the orchestrator's emulation
 *  loop so agentfw serves the search instead of the agent's own runtime
 *  (which otherwise would either fail or call Anthropic directly). */
export function hasAnthropicWebSearchTool(body: Record<string, unknown>): boolean {
  const tools = body.tools
  if (!Array.isArray(tools)) return false
  return tools.some((t) => {
    if (typeof t !== 'object' || t === null) return false
    const obj = t as { type?: unknown; name?: unknown }
    if (obj.type === WEB_SEARCH_SERVER_TOOL_TYPE) return true
    if (obj.name === WEB_SEARCH_CLIENT_TOOL_NAME) return true
    return false
  })
}

/** Alias used by the orchestrator's runStreamingSwap delegate — same
 *  predicate, separate name so the call site reads as a "should I
 *  punt to buffered" probe rather than "do I need to emulate." */
export const requestHasWebSearchServerTool = hasAnthropicWebSearchTool

/** Rewrite each `web_search_20250305` entry in tools[] to a regular
 *  custom tool with the same name. The schema below is a compatible
 *  superset of Anthropic's documented inputs (query + allowed_domains
 *  + blocked_domains) so the destination model emits tool_use blocks
 *  the loop can execute against any backend. allowed_domains and
 *  blocked_domains are preserved as hints in the schema description
 *  so the model passes them through, though our backend may ignore
 *  them depending on the provider. */
export function rewriteAnthropicWebSearchTool(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const tools = body.tools
  if (!Array.isArray(tools)) return body
  let changed = false
  const next = tools.map((t) => {
    if (typeof t !== 'object' || t === null) return t
    const obj = t as { type?: unknown; name?: unknown; max_uses?: unknown }
    if (obj.type !== WEB_SEARCH_SERVER_TOOL_TYPE) return t
    changed = true
    const name = typeof obj.name === 'string' ? obj.name : WEB_SEARCH_TOOL_NAME
    return {
      name,
      description:
        'Search the web. Returns title, URL, and a snippet for each result. ' +
        'Call this when you need current information beyond your training cutoff.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
          allowed_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional. Restrict results to these domains.',
          },
          blocked_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional. Exclude results from these domains.',
          },
        },
        required: ['query'],
      },
    }
  })
  if (!changed) return body
  return { ...body, tools: next }
}

/** Read the web_search backend for this route. A per-route override
 *  (`capabilities.web_search.providerId` on the routing policy) wins
 *  when present; otherwise the global active provider applies; if
 *  neither resolves, fall through to the seeded DDG default.
 *
 *  Per-route override lets one wired agent route through Baidu while
 *  another stays on DuckDuckGo — same idea as model providers being
 *  selected per agent route. */
async function resolveBackend(
  routeProviderId: string | undefined,
): Promise<ToolProvider | undefined> {
  try {
    const store = await readToolProviders()
    if (routeProviderId) {
      const explicit = store.providers.find(
        (p) => p.id === routeProviderId && p.kind === 'web_search',
      )
      if (explicit) return explicit
      logger.warn(
        `web_search emulation: route's provider override "${routeProviderId}" not ` +
          'found in tool-providers.json; falling back to active provider',
      )
    }
    return activeProviderFor(store, 'web_search')
  } catch {
    return undefined
  }
}

async function runSearch(
  provider: ToolProvider,
  query: string,
  count: number,
): Promise<WebSearchOutcome> {
  if (provider.backend === 'duckduckgo') return searchDuckDuckGo({ query, count })
  if (provider.backend === 'brave') {
    const key = provider.authRef ? await readBackendSecret(provider.authRef) : undefined
    if (!key) return { ok: false, error: `provider "${provider.id}" is missing its API key` }
    return searchBrave({ query, count, apiKey: key })
  }
  if (provider.backend === 'baidu') {
    const key = provider.authRef ? await readBackendSecret(provider.authRef) : undefined
    if (!key) return { ok: false, error: `provider "${provider.id}" is missing its API key` }
    return searchBaidu({ query, count, apiKey: key })
  }
  return { ok: false, error: `backend "${provider.backend}" is not implemented yet` }
}

async function readBackendSecret(ref: string): Promise<string | undefined> {
  try {
    const { readSecrets } = await import('../../core/secrets.ts')
    const secrets = await readSecrets()
    return getSecret(secrets, ref) ?? undefined
  } catch {
    return undefined
  }
}

/** Walk the IR blocks of an assistant response for any tool_use blocks
 *  named "web_search". Reading from IR (not the raw upstream JSON)
 *  keeps the emulation wire-agnostic — works for Anthropic-format
 *  upstreams AND OpenAI-chat upstreams alike. */
type ToolUseCall = { id: string; query: string; allowed_domains?: string[]; blocked_domains?: string[] }

function findSearchCallsInIR(blocks: readonly NormalizedBlock[]): ToolUseCall[] {
  const out: ToolUseCall[] = []
  for (const b of blocks) {
    if (b.type !== 'tool_use') continue
    if (b.name !== WEB_SEARCH_TOOL_NAME && b.name !== WEB_SEARCH_CLIENT_TOOL_NAME) continue
    if (!b.id) continue
    const input = (b.input ?? {}) as {
      query?: unknown
      allowed_domains?: unknown
      blocked_domains?: unknown
    }
    const query = typeof input.query === 'string' ? input.query : ''
    if (!query) continue
    out.push({
      id: b.id,
      query,
      ...(Array.isArray(input.allowed_domains)
        ? { allowed_domains: input.allowed_domains.filter((s): s is string => typeof s === 'string') }
        : {}),
      ...(Array.isArray(input.blocked_domains)
        ? { blocked_domains: input.blocked_domains.filter((s): s is string => typeof s === 'string') }
        : {}),
    })
  }
  return out
}

/** Convert IR assistant blocks back into the Anthropic message-content
 *  shape we append to the running conversation. Used regardless of
 *  upstream wire format because clientApi is anthropic-messages by
 *  construction (the emulation only fires for Anthropic clients).
 *  buildUpstreamRequest re-translates to the upstream's format on the
 *  next iteration's execAttempt, so the round-trip lands cleanly. */
function irBlocksToAnthropicContent(blocks: readonly NormalizedBlock[]): unknown[] {
  const out: unknown[] = []
  for (const b of blocks) {
    if (b.type === 'text') {
      out.push({ type: 'text', text: b.text })
    } else if (b.type === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: b.id,
        name: b.name,
        input: b.input ?? {},
      })
    }
    // thinking / other block types are intentionally dropped from the
    // emulation's conversation tail — they don't round-trip cleanly
    // and the model doesn't need them to continue the turn.
  }
  return out
}

/** When the upstream natively speaks Anthropic-messages, hand back its
 *  raw `content[]` from the response verbatim so thinking blocks (which
 *  carry an opaque `signature` the upstream validates on the next turn)
 *  survive the round-trip. Returns undefined when the upstream isn't
 *  Anthropic or the shape isn't recognisable, signalling the caller to
 *  fall back to the IR-derived (lossy-but-portable) mirror. */
function anthropicAssistantContent(
  memberApi: ModelApi,
  json: unknown,
): unknown[] | undefined {
  if (memberApi !== 'anthropic-messages') return undefined
  if (typeof json !== 'object' || json === null) return undefined
  const content = (json as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  return content
}

/** Format a backend result list as the text content of a
 *  tool_result block. Mirrors Anthropic's own server-tool-result
 *  shape closely enough that the model knows what to do with it. */
function formatResultsAsToolResult(results: WebSearchResult[]): string {
  if (results.length === 0) return 'No results.'
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title}`, `   ${r.url}`]
      if (r.snippet) lines.push(`   ${r.snippet}`)
      return lines.join('\n')
    })
    .join('\n\n')
}

export type WebSearchEmulationOutcome = {
  /** Final assistant message content (Anthropic message blocks). When the
   *  loop is healthy this is the model's last turn, after all search
   *  results have been folded back in. */
  finalAssistantContent: unknown
  /** Every upstream call the emulation issued — initial + one per loop
   *  iteration. Surfaced for capture so the dashboard records the fan-out. */
  attempts: RoutedAttempt[]
  /** Per-tool_use_id, the executed search outcome. Lets the response
   *  rewriter (v2) synthesize web_search_tool_result blocks; v1 just
   *  inlines the text in the user-turn tool_result we fed back. */
  searches: Map<string, WebSearchOutcome>
  /** Captured tool_call payloads — one per search — surfaced under the
   *  parent run so the dashboard shows which backend served each call. */
  toolExecutions: CapturedToolExecution[]
  /** True when the loop converged (model produced an assistant message
   *  without any web_search tool_use). False on attempt failure or
   *  hitting the iteration cap with a tool_use still pending. */
  ok: boolean
  /** Last upstream HTTP status — surfaced to the response so the
   *  client sees the right status code for a healthy / failed run. */
  status: number
}

export type WebSearchEmulationParams = {
  member: ResolvedMember
  /** The client request as the agent sent it (after rewriteAnthropicWebSearchTool
   *  has already swapped the server-tool entry for a custom one). */
  clientRequest: Record<string, unknown>
  clientApi: ModelApi
  ctx: { agent: AgentId; reqHeaders: Headers }
  /** Cap iterations of the loop — mirrors Anthropic's `max_uses`. */
  maxUses?: number
  /** Optional per-route provider override — see resolveBackend. */
  providerIdOverride?: string
}

/** Wrap a buffered upstream call with the web_search executor loop.
 *  Each round: run the model, see if it called web_search, execute if
 *  so, append (assistant turn + tool_result user turn) to the
 *  conversation, run again. Stops when the model stops calling
 *  web_search or maxUses is hit. */
export async function runWebSearchEmulationLoop(
  params: WebSearchEmulationParams,
): Promise<WebSearchEmulationOutcome> {
  const { member, clientApi, ctx } = params
  const maxUses = Math.max(1, params.maxUses ?? DEFAULT_MAX_USES)
  const backend = await resolveBackend(params.providerIdOverride)

  // Mutable conversation tail — we keep appending the model's assistant
  // message + a synthetic user-turn tool_result for each search call.
  let messages = ((params.clientRequest.messages as unknown[]) ?? []).slice()
  const attempts: RoutedAttempt[] = []
  const searches = new Map<string, WebSearchOutcome>()
  const toolExecutions: CapturedToolExecution[] = []
  let lastStatus = 200
  let finalAssistantContent: unknown = null

  for (let iter = 0; iter < maxUses; iter++) {
    const round = { ...params.clientRequest, messages }
    const result: AttemptResult = await execAttempt(member, clientApi, round, ctx)
    const step = attempts.length
    attempts.push({
      member,
      result,
      role: iter === 0 ? 'primary' : 'failover',
      step,
    })
    if (!result.ok) {
      return {
        finalAssistantContent,
        attempts,
        searches,
        toolExecutions,
        ok: false,
        status: result.status,
      }
    }
    lastStatus = result.status
    // The conversation tail mirrors the upstream's assistant turn. When the
    // upstream speaks Anthropic-messages natively (e.g. DeepSeek's
    // /anthropic endpoint) we MUST echo its raw content[] back verbatim —
    // thinking blocks carry an opaque signature the upstream validates,
    // and IR doesn't preserve that signature. For non-Anthropic upstreams
    // there are no thinking blocks anyway, so fall back to the IR-derived
    // shape (handles OpenAI choices[].tool_calls etc.).
    const rawContent = anthropicAssistantContent(member.api, result.json)
    const assistantContent =
      rawContent !== undefined ? rawContent : irBlocksToAnthropicContent(result.ir.blocks)
    finalAssistantContent = assistantContent

    const calls = findSearchCallsInIR(result.ir.blocks)
    if (calls.length === 0) {
      return {
        finalAssistantContent,
        attempts,
        searches,
        toolExecutions,
        ok: true,
        status: lastStatus,
      }
    }

    if (!backend) {
      logger.warn(
        'web_search emulation: no backend configured in tool-providers.json; ' +
          'returning an error tool_result. Add one in Control · Tool Providers.',
      )
    }

    // Append the assistant turn + synthetic user turn carrying one
    // tool_result per search call. The model's next round sees the
    // results and writes its final answer (or another tool_use).
    messages.push({ role: 'assistant', content: assistantContent })
    const toolResults = await Promise.all(
      calls.map(async (call) => {
        const ts = Date.now()
        const t0 = performance.now()
        const outcome = backend
          ? await runSearch(backend, call.query, 10)
          : ({
              ok: false,
              error: 'no web_search backend configured',
            } as WebSearchOutcome)
        const durMs = performance.now() - t0
        searches.set(call.id, outcome)
        toolExecutions.push(
          buildToolExecutionRecord(
            backend,
            call,
            outcome,
            ts,
            durMs,
          ),
        )
        const text = outcome.ok
          ? formatResultsAsToolResult(outcome.results)
          : `web_search failed: ${outcome.error}`
        return {
          type: 'tool_result',
          tool_use_id: call.id,
          content: text,
          ...(outcome.ok ? {} : { is_error: true }),
        }
      }),
    )
    messages.push({ role: 'user', content: toolResults })
  }

  logger.warn(
    `web_search emulation: hit max_uses=${maxUses} without convergence on ${member.model.id}`,
  )
  return {
    finalAssistantContent,
    attempts,
    searches,
    toolExecutions,
    ok: false,
    status: lastStatus,
  }
}

/** Synthesise one CapturedToolExecution from a search call + its
 *  outcome. The captured record is what the dashboard reads — so the
 *  preview text should be informative at a glance (top 3 hit titles
 *  for a healthy call, the error message for a failed one). Cost
 *  comes from the provider's costPerCall and is what makes Baidu
 *  per-search charges show up on the run's roll-up. Errors are still
 *  billable on most APIs (the backend has to evaluate the query
 *  before deciding to reject) so cost is attached regardless. */
function buildToolExecutionRecord(
  backend: ToolProvider | undefined,
  call: ToolUseCall,
  outcome: WebSearchOutcome,
  ts: number,
  durMs: number,
): CapturedToolExecution {
  const providerId = backend?.id ?? '(none)'
  const backendName = backend?.backend ?? 'unconfigured'
  const costUsd = backend?.costPerCall && backend.costPerCall > 0
    ? backend.costPerCall
    : undefined
  if (!outcome.ok) {
    return {
      ts,
      durMs,
      ...(costUsd ? { costUsd } : {}),
      toolName: WEB_SEARCH_TOOL_NAME,
      providerId,
      backend: backendName,
      input: { query: call.query },
      status: 'error',
      error: outcome.error,
    }
  }
  const preview = outcome.results
    .slice(0, 3)
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`)
    .join('\n')
  return {
    ts,
    durMs,
    ...(costUsd ? { costUsd } : {}),
    toolName: WEB_SEARCH_TOOL_NAME,
    providerId,
    backend: backendName,
    input: { query: call.query },
    resultCount: outcome.results.length,
    outputPreview: preview,
    status: 'ok',
  }
}

