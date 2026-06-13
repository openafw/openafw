import { createHash } from 'node:crypto'
import type { AgentId } from '../../core/agent.ts'
import type { ThreadId } from '../../core/ids.ts'

// biome-ignore lint/suspicious/noExplicitAny: third-party JSON message shapes.
type Any = any

const TITLE_MAX = 120

/** Pull plain text out of a message `content` field. `content` is either a
 *  string (most turns) or a block array. We only keep `text`-style blocks
 *  (`text` / `input_text` / `output_text`); `tool_result`, `image` and
 *  `tool_use` blocks are deliberately ignored — a turn that opens with a
 *  tool_result is a continuation, not a genuine first prompt. */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Any
    if (
      (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') &&
      typeof b.text === 'string'
    ) {
      parts.push(b.text)
    }
  }
  return parts.join(' ')
}

/** The first user message's text, whitespace-normalized. Invariant across
 *  every request in a conversation because agents re-send the full history
 *  as a prefix — which is what makes it a stable correlation key. Returns
 *  `undefined` when there's no usable user text (passthrough, models-list,
 *  tool-only openers). */
export function firstUserText(messages: unknown[]): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const m = msg as Any
    if (m.role !== 'user') continue
    const text = textFromContent(m.content).replace(/\s+/g, ' ').trim()
    if (text) return text
    // First user turn carried no text (e.g. image- or tool_result-only) —
    // keep scanning; the next user turn is a better anchor than nothing.
  }
  return undefined
}

/** Per-agent per-local-day bucket. The pre-correlation fallback, kept for
 *  requests with no usable first prompt so they still group somewhere. */
export function dayBucketThreadId(agent: string): ThreadId {
  const day = new Date().toISOString().slice(0, 10)
  return `th_${agent}_${day}` as ThreadId
}

/** Extract the agent-instance id from a wrapper-style model id. Wiring
 *  rewrites a wrapped agent's model to `agentfw-<agent>-<instance>` (e.g.
 *  `agentfw-openclaw-main`); the suffix is the instance. Returns undefined for
 *  wildcard/real model ids (claude-code et al. — instance is not on the wire,
 *  the session correlator fills it later). */
export function instanceFromModel(agent: AgentId, model: string | undefined): string | undefined {
  if (!model) return undefined
  const prefix = `agentfw-${agent}-`
  if (model.startsWith(prefix)) {
    const rest = model.slice(prefix.length).trim()
    return rest || undefined
  }
  return undefined
}

/** The instance id to attribute a capture to. A wire-derived id (the
 *  `@<instance>` path segment minted by `agentfw run`) is authoritative
 *  and wins; otherwise fall back to the wrapper-model suffix
 *  ({@link instanceFromModel}, OpenClaw/Hermes). Returns undefined when
 *  neither source knows — bare `claude` left for the session correlator. */
export function effectiveInstanceId(
  wireInstanceId: string | undefined,
  agent: AgentId,
  model: string | undefined,
): string | undefined {
  return wireInstanceId || instanceFromModel(agent, model)
}

/** Deterministic conversation (= task) id derived from the agent and the
 *  first user prompt. Deterministic so it survives daemon restarts with no
 *  in-memory state. Falls back to {@link dayBucketThreadId} when there's no
 *  usable first prompt. When `instanceId` is known at decode time (wire-
 *  derivable instances), it is folded into the salt so the same prompt in
 *  two instances becomes two tasks.
 *
 *  Known limitations (header-based correlation is the future fix):
 *   • context compaction that drops the first message re-roots the task;
 *   • two genuinely different tasks opened with the identical prompt merge
 *     (salted by agent + instance, so blast radius is one instance). */
export function correlatedThreadId(
  agent: AgentId,
  messages: unknown[],
  instanceId?: string,
): ThreadId {
  const text = firstUserText(messages)
  if (!text) return dayBucketThreadId(agent)
  const salt = instanceId ? `${agent}\x00${instanceId}` : agent
  const hash = createHash('sha256').update(`${salt}\x00${text}`).digest('hex').slice(0, 24)
  return `th_${hash}` as ThreadId
}

/** Truncated first prompt, stored once as `threads.title` (first-writer-wins).
 *  `undefined` when there's no usable first prompt — title stays null. */
export function deriveThreadTitle(messages: unknown[]): string | undefined {
  const text = firstUserText(messages)
  return text ? text.slice(0, TITLE_MAX) : undefined
}
