// Shared MCP frame ingest — turns one JSON-RPC frame (from stdio tap or the
// HTTP/SSE relay) into a stored mcp_call action. Both transports land here so
// they capture identically.
//
// runId/threadId follow the stdio tap's existing behavior: a fresh run per
// frame, bucketed into a per-agent-per-day thread. MCP↔conversation thread
// correlation is out of scope (the wire carries no shared id between the
// model call and the tool server it triggers).

import type { AgentId } from '../../core/agent.ts'
import { type ThreadId, newActionId, newRunId } from '../../core/ids.ts'
import type { AgentPacket, McpCallPayload } from '../../core/packet.ts'
import { appendPacket } from '../store/writer.ts'

export type McpTransport = 'stdio' | 'http' | 'sse'
export type McpDirection = 'request' | 'response' | 'notification'

export type McpFrameInput = {
  agent: string
  server: string
  transport: McpTransport
  direction: McpDirection
  // biome-ignore lint/suspicious/noExplicitAny: third-party JSON-RPC payload
  frame: any
  ts: number
}

/** Store a single JSON-RPC frame as an mcp_call action. No-op when the frame
 *  isn't a JSON-RPC object (server prelude logs, blank SSE keep-alives). */
export async function ingestMcpFrame(input: McpFrameInput): Promise<void> {
  const f = input.frame
  if (!f || typeof f !== 'object') return

  // JSON-RPC notifications have a method but no id.
  const direction: McpDirection = 'method' in f && !('id' in f) ? 'notification' : input.direction

  const day = new Date(input.ts).toISOString().slice(0, 10)
  const payload: McpCallPayload = {
    kind: 'mcp_call',
    protocol: 'mcp',
    server: input.server,
    transport: input.transport,
    direction,
    jsonrpcId: f.id,
    method: f.method,
    params: f.params,
    result: f.result,
    error: f.error,
  }

  const packet: AgentPacket = {
    id: newActionId(),
    runId: newRunId(),
    threadId: `th_${input.agent}_${day}` as ThreadId,
    ts: input.ts,
    durMs: 0,
    sourceAgent: input.agent as AgentId,
    payload,
  }

  await appendPacket(packet)
}
