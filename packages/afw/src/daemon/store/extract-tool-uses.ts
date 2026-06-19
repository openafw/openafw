// Extract one `tool_uses` row per tool the model invoked, at ingest, from the
// already-decoded in-memory packet (never the gzipped payload blob). Powers the
// dashboard's See → Agents / MCP / Skills tabs: every model-call response block
// of type `tool_use` becomes a row, classified into a category so the tabs are
// plain GROUP BYs:
//   - `skill`   — Claude Code's `Skill` tool; `detail` = the skill name
//   - `mcp`     — an `mcp__<server>__<tool>` call; `detail` = the server
//   - `builtin` — everything else (Read/Edit/Bash/…); `detail` = null
// An `mcp_call` packet (a JSON-RPC frame to an MCP server) also becomes one
// `mcp` row, counted once on the response frame.

import type { AgentPacket, NormalizedBlock } from '../../core/packet.ts'
import type { toolUses } from './schema.ts'

export type ToolUseRow = typeof toolUses.$inferInsert

type ToolUseBlock = Extract<NormalizedBlock, { type: 'tool_use' }>

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The skill name from a `Skill` tool_use input — defensive about the field
 *  name (Claude Code's shape isn't guaranteed), never drops the row. */
function skillName(input: unknown): string {
  if (isObj(input)) {
    for (const k of ['skill', 'command', 'name']) {
      const v = input[k]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
    }
  }
  return 'unknown'
}

function classify(name: string, input: unknown): { category: string; detail: string | null } {
  if (name === 'Skill') return { category: 'skill', detail: skillName(input) }
  if (name.startsWith('mcp__')) {
    const server = name.split('__')[1] || null
    return { category: 'mcp', detail: server }
  }
  return { category: 'builtin', detail: null }
}

export function extractToolUses(packet: AgentPacket): ToolUseRow[] {
  const dims = {
    actionId: packet.id,
    agent: packet.sourceAgent,
    ts: packet.ts,
    instanceId: packet.instanceId ?? null,
    threadId: packet.threadId,
    runId: packet.runId,
  }
  const p = packet.payload

  if (p.kind === 'mcp_call') {
    // Count a completed call once — on the response frame (carries error state).
    if (p.direction !== 'response') return []
    return [
      {
        ...dims,
        name: typeof p.method === 'string' && p.method !== '' ? p.method : 'mcp_call',
        toolUseId: p.jsonrpcId != null ? String(p.jsonrpcId) : null,
        category: 'mcp',
        detail: typeof p.server === 'string' && p.server !== '' ? p.server : null,
        costMicroShare: 0,
        isError: p.error != null ? 1 : 0,
      },
    ]
  }

  if (p.kind !== 'model_call') return []
  const blocks: NormalizedBlock[] = Array.isArray(p.response) ? p.response : []
  const uses = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')
  if (uses.length === 0) return []

  // The enclosing model_call's cost split evenly across its tool calls — a
  // rough per-tool spend attribution (the response is one assistant turn).
  const costMicro = packet.cost?.usd != null ? Math.round(packet.cost.usd * 1_000_000) : 0
  const share = Math.floor(costMicro / uses.length)

  return uses.map((b) => {
    const name = typeof b.name === 'string' && b.name !== '' ? b.name : 'unknown'
    const { category, detail } = classify(name, b.input)
    return {
      ...dims,
      name,
      toolUseId: typeof b.id === 'string' ? b.id : null,
      category,
      detail,
      costMicroShare: share,
      isError: 0,
    }
  })
}
