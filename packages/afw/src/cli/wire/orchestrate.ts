// Shared wire/unwire orchestration. Pure functions — no console output, no
// process.exit, no commander coupling. Both the CLI (`afw wire` /
// `afw unwire`) and the daemon HTTP API (/api/wire/*) call these so the
// two surfaces stay in lockstep. See the CLI ↔ dashboard parity rule.

import type { AgentId } from '../../core/agent.ts'
import type { BackupEntry } from '../../core/manifest.ts'
import { type RouteEntry, exactRouteKey } from '../../core/routes.ts'
import { setSecret } from '../../core/secrets.ts'
import { appendEntries, readManifest, removeEntries } from '../backup/manifest.ts'
import { detectAll, detectorFor } from '../detect/index.ts'
import type { ApplyResult, Detection } from '../detect/types.ts'
import { cleanupAgentWireState, tombstoneAgentWireState } from './cleanup.ts'
import { readRoutes, removeRoutes, staleRouteKeys, upsertRoutes } from './routes.ts'
import { routeKeyForModel } from './url.ts'

export type DetectionPlan = {
  detections: Detection[]
}

export type WireAgentResult = {
  agent: AgentId
  ok: boolean
  error?: string
  routeKeys: string[]
  staleRouteKeys: string[]
  secretsCount: number
  manualInstructions?: string
  apply?: ApplyResult
}

export type WireRunResult = {
  results: WireAgentResult[]
}

export type UnwireSkipped = { pointer: string; reason: string }

export type UnwireAgentResult = {
  agent: AgentId
  ok: boolean
  error?: string
  filesRestored: number
  skipped: UnwireSkipped[]
  cleanupNote?: string
}

export type UnwireRunResult = {
  results: UnwireAgentResult[]
  /** Manifest entries still wired across ALL agents (not just the ones in this batch). */
  remainingEntries: number
}

// ── detect ────────────────────────────────────────────────────────

export async function detectPlan(only?: AgentId[]): Promise<DetectionPlan> {
  const detections = await detectAll(only ? { only } : {})
  // Enrich manual-mode detections with their setup instructions so the
  // dashboard can render them inline without re-running wire(). The hook
  // is a pure function; computing it here costs nothing.
  for (const d of detections) {
    const det = detectorFor(d.agent)
    if (det?.mode === 'manual' && det.manualInstructions) {
      ;(d as Detection & { manualInstructions?: string }).manualInstructions =
        det.manualInstructions(d)
    }
  }
  return { detections }
}

// ── wire ──────────────────────────────────────────────────────────

export type RunWireOpts = {
  only?: AgentId[]
  noApply?: boolean
}

export async function runWire(opts: RunWireOpts = {}): Promise<WireRunResult> {
  const detections = await detectAll(opts.only ? { only: opts.only } : {})
  const results: WireAgentResult[] = []

  for (const detection of detections) {
    results.push(await wireOne(detection, opts.noApply ?? false))
  }
  return { results }
}

async function wireOne(detection: Detection, noApply: boolean): Promise<WireAgentResult> {
  const det = detectorFor(detection.agent)
  if (!det) {
    return {
      agent: detection.agent,
      ok: false,
      error: 'no detector registered',
      routeKeys: [],
      staleRouteKeys: [],
      secretsCount: 0,
    }
  }

  try {
    const outcome = await det.wire(detection)
    await appendEntries(outcome.backupEntries)

    const routeUpdates: Record<string, RouteEntry> = {}
    for (const ep of detection.endpoints) {
      if (!ep.active) continue
      routeUpdates[routeKeyForModel(detection.agent, ep.modelId)] = {
        upstream: ep.upstream,
        decoder: ep.decoder,
        ...(ep.sourceModelId ? { sourceModelId: ep.sourceModelId } : {}),
        ...(ep.harvest ? { harvest: ep.harvest } : {}),
        ...(ep.auth ? { auth: ep.auth } : {}),
      }
    }
    // http/sse MCP servers: the relay forwards `<agent>/mcp/<name>` to the
    // real upstream the detector captured. Keyed the same way relay.ts reads it.
    for (const mcp of detection.mcpServers) {
      if ((mcp.transport === 'http' || mcp.transport === 'sse') && mcp.originalUrl) {
        routeUpdates[exactRouteKey(detection.agent, `mcp/${mcp.name}`)] = {
          upstream: mcp.originalUrl,
          decoder: 'mcp',
        }
      }
    }

    const stale: string[] = []
    if (Object.keys(routeUpdates).length > 0) {
      const desired = new Set(Object.keys(routeUpdates))
      const existing = await readRoutes()
      const staleKeys = staleRouteKeys(Object.keys(existing.routes), detection.agent, desired)
      if (staleKeys.length > 0) {
        await removeRoutes(staleKeys)
        stale.push(...staleKeys)
      }
      await upsertRoutes(routeUpdates)
    }

    for (const s of outcome.secrets ?? []) {
      await setSecret(s.ref, s.value)
    }

    const manualInstructions =
      det.manualInstructions && det.mode === 'manual'
        ? det.manualInstructions(detection)
        : undefined

    let apply: ApplyResult | undefined
    if (det.mode !== 'launch-per-task' && det.mode !== 'manual' && !noApply) {
      apply = await maybeApply(det, detection)
    }

    return {
      agent: detection.agent,
      ok: true,
      routeKeys: Object.keys(routeUpdates),
      staleRouteKeys: stale,
      secretsCount: outcome.secrets?.length ?? 0,
      ...(manualInstructions ? { manualInstructions } : {}),
      ...(apply ? { apply } : {}),
    }
  } catch (err) {
    return {
      agent: detection.agent,
      ok: false,
      error: (err as Error).message,
      routeKeys: [],
      staleRouteKeys: [],
      secretsCount: 0,
    }
  }
}

async function maybeApply(
  det: NonNullable<ReturnType<typeof detectorFor>>,
  detection: Detection,
): Promise<ApplyResult | undefined> {
  if (!det.probeRunning || !det.applyToRunning) return undefined
  const status = await det.probeRunning()
  if (!status.running) {
    return {
      kind: 'next-launch',
      note: `${detection.agent} not running; new config applies on next start`,
    }
  }
  return det.applyToRunning(detection, status)
}

// ── unwire ────────────────────────────────────────────────────────

export type RunUnwireOpts = {
  agents?: AgentId[]
  force?: boolean
}

export async function runUnwire(opts: RunUnwireOpts = {}): Promise<UnwireRunResult> {
  const manifest = await readManifest()
  const only = opts.agents && opts.agents.length > 0 ? opts.agents : undefined
  const targets = only ? manifest.entries.filter((e) => only.includes(e.agent)) : manifest.entries

  if (targets.length === 0) {
    return { results: [], remainingEntries: manifest.entries.length }
  }

  const byAgent = new Map<AgentId, BackupEntry[]>()
  for (const e of targets) {
    const list = byAgent.get(e.agent) ?? []
    list.push(e)
    byAgent.set(e.agent, list)
  }

  const restoredIds: string[] = []
  const restoredAgents: AgentId[] = []
  const results: UnwireAgentResult[] = []

  for (const [agent, entries] of byAgent) {
    const det = detectorFor(agent)
    if (!det) {
      results.push({
        agent,
        ok: false,
        error: 'no detector registered',
        filesRestored: 0,
        skipped: [],
      })
      continue
    }
    try {
      const report = await det.unwire(entries, { force: opts.force })
      restoredIds.push(...entries.map((e) => e.id))
      restoredAgents.push(agent)
      results.push({
        agent,
        ok: true,
        filesRestored: entries.length,
        skipped: report.skipped.map((s) => ({ pointer: s.pointer, reason: s.reason })),
      })
    } catch (err) {
      results.push({
        agent,
        ok: false,
        error: (err as Error).message,
        filesRestored: 0,
        skipped: [],
      })
    }
  }

  if (restoredIds.length > 0) {
    await removeEntries(restoredIds)
  }

  // Soft cleanup — tombstone wire-authored routes so the proxy keeps
  // already-running agents working until they restart. Mirrors what the
  // CLI does when not passing --stop-daemon.
  for (const agent of restoredAgents) {
    try {
      const cleaned = await tombstoneAgentWireState(agent)
      const r = results.find((x) => x.agent === agent)
      if (r) {
        r.cleanupNote = `${cleaned.routes.length} route(s), ${cleaned.providers.length} provider(s)`
      }
    } catch (err) {
      const r = results.find((x) => x.agent === agent)
      if (r) r.cleanupNote = `cleanup partial: ${(err as Error).message}`
    }
  }

  const after = await readManifest()
  return { results, remainingEntries: after.entries.length }
}

// ── hard cleanup (CLI-only, used by --stop-daemon path) ───────────

export async function hardCleanupAgents(
  agents: AgentId[],
): Promise<{ agent: AgentId; note?: string; error?: string }[]> {
  const out: { agent: AgentId; note?: string; error?: string }[] = []
  for (const agent of agents) {
    try {
      const cleaned = await cleanupAgentWireState(agent)
      out.push({
        agent,
        note: `${cleaned.routes.length} route(s), ${cleaned.providers.length} provider(s)`,
      })
    } catch (err) {
      out.push({ agent, error: (err as Error).message })
    }
  }
  return out
}
