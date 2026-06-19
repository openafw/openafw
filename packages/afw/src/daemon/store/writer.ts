import { gzipSync } from 'node:zlib'
import { logger } from '../../core/logger.ts'
import type { AgentPacket } from '../../core/packet.ts'
import { runRiskTaggers } from '../risk/pipeline.ts'
import { noteObservedModel } from '../routing/seed.ts'
import { getDb } from './db.ts'
import { extractToolUses } from './extract-tool-uses.ts'
import { actionPayloads, actions, runs, threads, toolUses } from './schema.ts'

/** Run the risk taggers inline so the stored row carries the tags. Decoders
 *  may pre-populate `packet.risk`; merge rather than overwrite. */
function tagRisks(packet: AgentPacket): void {
  const detected = runRiskTaggers(packet)
  if (detected.length > 0) {
    packet.risk = [...(packet.risk ?? []), ...detected]
  }
}

/** Gzip raw wire bytes for storage, or null when absent. Capped so a
 *  pathological multi-MB body can't bloat the store; over the cap we drop
 *  the raw blob (the normalized payload is still kept). */
const RAW_MAX_BYTES = 8 * 1024 * 1024
function gzipRaw(bytes: Uint8Array | undefined): Buffer | null {
  if (!bytes || bytes.length === 0 || bytes.length > RAW_MAX_BYTES) return null
  return gzipSync(bytes)
}

/** A packet's cost in micro-dollars (USD × 1e6), or null when uncosted. */
function costMicroOf(packet: AgentPacket): number | null {
  return packet.cost?.usd != null ? Math.round(packet.cost.usd * 1_000_000) : null
}

/** A packet's cost-saver savings in micro-dollars, or null when nothing was
 *  saved (no downgrade on this call). */
function savedMicroOf(packet: AgentPacket): number | null {
  const saved = packet.cost?.savedUsd
  return typeof saved === 'number' && saved > 0 ? Math.round(saved * 1_000_000) : null
}

/** The `actions` table row for a packet — mirrors `model` / `http_status` out
 *  of the payload so aggregate scans never touch the fat sidecar blob. */
function actionRow(packet: AgentPacket): typeof actions.$inferInsert {
  return {
    id: packet.id,
    runId: packet.runId,
    threadId: packet.threadId,
    parentActionId: packet.parentActionId ?? null,
    kind: packet.payload.kind,
    sourceAgent: packet.sourceAgent,
    ts: packet.ts,
    durMs: Math.round(packet.durMs),
    costUsd: costMicroOf(packet),
    savedMicro: savedMicroOf(packet),
    tokensIn: packet.cost?.tokensIn ?? null,
    tokensOut: packet.cost?.tokensOut ?? null,
    cacheReadTokens: packet.cost?.tokensCacheRead ?? null,
    cacheWriteTokens: packet.cost?.tokensCacheWrite ?? null,
    riskTags: packet.risk ? JSON.stringify(packet.risk) : null,
    model:
      packet.payload.kind === 'model_call' && typeof packet.payload.model === 'string'
        ? packet.payload.model
        : null,
    httpStatus:
      packet.payload.kind === 'model_call' &&
      typeof (packet.payload as { status?: unknown }).status === 'number'
        ? (packet.payload as { status: number }).status
        : null,
    instanceId: packet.instanceId ?? null,
    subAgentId: packet.subAgentId ?? null,
  }
}

export async function appendPacket(packet: AgentPacket): Promise<void> {
  try {
    tagRisks(packet)

    const db = await getDb()
    const costMicro = costMicroOf(packet)

    db.transaction(() => {
      db.insert(threads)
        .values({
          id: packet.threadId,
          agentId: packet.sourceAgent,
          title: packet.threadTitle ?? null,
          instanceId: packet.instanceId ?? null,
          createdAt: packet.ts,
        })
        .onConflictDoNothing()
        .run()

      db.insert(runs)
        .values({
          id: packet.runId,
          threadId: packet.threadId,
          goal: null,
          status: 'done',
          startedAt: packet.ts,
          endedAt: packet.ts + Math.round(packet.durMs),
          costUsd: costMicro,
          savedMicro: savedMicroOf(packet),
          tokensIn: packet.cost?.tokensIn ?? null,
          tokensOut: packet.cost?.tokensOut ?? null,
          cacheReadTokens: packet.cost?.tokensCacheRead ?? null,
          cacheWriteTokens: packet.cost?.tokensCacheWrite ?? null,
        })
        .onConflictDoNothing()
        .run()

      db.insert(actions).values(actionRow(packet)).run()

      // The fat payload goes to the sidecar, keyed by action id, so the
      // actions table stays small and aggregate scans never touch it.
      db.insert(actionPayloads)
        .values({
          actionId: packet.id,
          payload: JSON.stringify(packet.payload),
          rawReq: gzipRaw(packet.rawReq),
          rawRes: gzipRaw(packet.rawRes),
        })
        .run()

      // One tool_uses row per tool the model invoked (+ mcp_call frames),
      // for the See → Agents/MCP/Skills tabs.
      const tuRows = extractToolUses(packet)
      if (tuRows.length > 0) db.insert(toolUses).values(tuRows).run()
    })

    // why: surface every model id seen on the wire in the model registry, so
    // the routing UI lists models the user actually uses without an outbound
    // catalog call. Cheap (one Set lookup) and fire-and-forget.
    if (packet.payload.kind === 'model_call' && typeof packet.payload.model === 'string') {
      noteObservedModel(packet.sourceAgent, packet.payload.protocol, packet.payload.model)
    }
  } catch (err) {
    logger.error(`store: append failed — ${(err as Error).message}`)
  }
}

/**
 * Append a routing fan-out: one parent action plus its children, in a single
 * transaction. The parent carries $0 (model = combo id); the children carry
 * the real per-attempt cost, so run/thread rollups that SUM over `actions`
 * stay correct without any aggregate-query change. The run row's rollup sums
 * the children. Outcome/tool extraction runs on the parent only — its
 * `response` is the final client-facing answer.
 */
export async function appendPacketTree(
  parent: AgentPacket,
  children: AgentPacket[],
): Promise<void> {
  try {
    tagRisks(parent)
    for (const child of children) tagRisks(child)

    const db = await getDb()
    const all = [parent, ...children]

    const runCostMicro = children.reduce((sum, c) => sum + (costMicroOf(c) ?? 0), 0)
    const runSavedMicro = children.reduce((sum, c) => sum + (savedMicroOf(c) ?? 0), 0)
    const sumChild = (
      key: 'tokensIn' | 'tokensOut' | 'tokensCacheRead' | 'tokensCacheWrite',
    ): number | null => {
      let total = 0
      let seen = false
      for (const c of children) {
        const v = c.cost?.[key]
        if (typeof v === 'number') {
          total += v
          seen = true
        }
      }
      return seen ? total : null
    }

    db.transaction(() => {
      db.insert(threads)
        .values({
          id: parent.threadId,
          agentId: parent.sourceAgent,
          title: parent.threadTitle ?? null,
          instanceId: parent.instanceId ?? null,
          createdAt: parent.ts,
        })
        .onConflictDoNothing()
        .run()

      db.insert(runs)
        .values({
          id: parent.runId,
          threadId: parent.threadId,
          goal: null,
          status: 'done',
          startedAt: parent.ts,
          endedAt: parent.ts + Math.round(parent.durMs),
          costUsd: runCostMicro,
          savedMicro: runSavedMicro || null,
          tokensIn: sumChild('tokensIn'),
          tokensOut: sumChild('tokensOut'),
          cacheReadTokens: sumChild('tokensCacheRead'),
          cacheWriteTokens: sumChild('tokensCacheWrite'),
        })
        .onConflictDoNothing()
        .run()

      for (const p of all) {
        db.insert(actions).values(actionRow(p)).run()
        db.insert(actionPayloads)
          .values({
            actionId: p.id,
            payload: JSON.stringify(p.payload),
            rawReq: gzipRaw(p.rawReq),
            rawRes: gzipRaw(p.rawRes),
          })
          .run()
      }

      // Tool extraction runs on the parent only — its `response` is the final
      // client-facing answer (children are failover attempts → double-count).
      const tuRows = extractToolUses(parent)
      if (tuRows.length > 0) db.insert(toolUses).values(tuRows).run()
    })
  } catch (err) {
    logger.error(`store: append tree failed — ${(err as Error).message}`)
  }
}
