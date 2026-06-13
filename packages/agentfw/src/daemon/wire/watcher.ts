// Wire drift watcher.
//
// Monitors every file the user has wired (from
// ~/.agentfw/backups/manifest.json) and flags semantic drift — i.e. when
// the specific keys WE rewrote no longer hold OUR values. We deliberately
// don't compare whole-file sha because some agent configs (notably
// ~/.claude.json) are heavily mutated by the agent itself with session
// state / history / caches that have nothing to do with wiring.
//
// Drift cases we care about:
//   * 'set' change: the value at jsonPointer no longer matches what we wrote.
//   * 'wrap-mcp' change: the server's command/args no longer match our wrap.
//
// We only DETECT drift here. Re-wiring is a user action (`agentfw wire`).

import { type FSWatcher, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { AgentId } from '../../core/agent.ts'
import { logger } from '../../core/logger.ts'
import type { BackupEntry, ChangeRecord, Manifest } from '../../core/manifest.ts'
import { paths } from '../../core/paths.ts'
import { parseJsonc } from '../../cli/rewrite/jsonc.ts'
import { getTomlString, getTomlTopLevelString } from '../../cli/rewrite/toml.ts'

export type DriftEntry = {
  path: string
  agent: AgentId
  drifted: boolean
  reason?: string
  lastChecked: number
}

type Tracked = DriftEntry & {
  changes: ChangeRecord[]
}

const state = new Map<string, Tracked>()
const dirWatchers = new Map<string, FSWatcher>()
const debouncers = new Map<string, ReturnType<typeof setTimeout>>()

let manifestWatcher: FSWatcher | undefined
let manifestDebounce: ReturnType<typeof setTimeout> | undefined

export async function initWireWatcher(): Promise<void> {
  await syncFromManifest()
  startManifestWatcher()
}

export function getDriftReport(): DriftEntry[] {
  return Array.from(state.values()).map((s) => ({
    path: s.path,
    agent: s.agent,
    drifted: s.drifted,
    reason: s.reason,
    lastChecked: s.lastChecked,
  }))
}

export function stopWireWatcher(): void {
  for (const w of dirWatchers.values()) w.close()
  dirWatchers.clear()
  manifestWatcher?.close()
  manifestWatcher = undefined
  for (const t of debouncers.values()) clearTimeout(t)
  debouncers.clear()
  if (manifestDebounce) clearTimeout(manifestDebounce)
}

async function syncFromManifest(): Promise<void> {
  const manifest = await readManifest()
  const latest = new Map<string, BackupEntry>()
  for (const entry of manifest.entries) {
    const prev = latest.get(entry.originalPath)
    if (!prev || entry.wiredAt > prev.wiredAt) latest.set(entry.originalPath, entry)
  }

  for (const p of [...state.keys()]) {
    if (!latest.has(p)) {
      state.delete(p)
      const t = debouncers.get(p)
      if (t) {
        clearTimeout(t)
        debouncers.delete(p)
      }
    }
  }

  for (const [path, entry] of latest) {
    const existing = state.get(path)
    if (existing) {
      existing.agent = entry.agent
      existing.changes = entry.changes
    } else {
      state.set(path, {
        path,
        agent: entry.agent,
        changes: entry.changes,
        drifted: false,
        lastChecked: 0,
      })
    }
  }

  const dirs = new Set<string>()
  for (const path of state.keys()) dirs.add(dirname(path))
  for (const dir of dirs) {
    if (dirWatchers.has(dir)) continue
    try {
      const w = watch(dir, (_event, filename) => {
        if (!filename) return
        for (const path of state.keys()) {
          if (dirname(path) === dir && basename(path) === filename) {
            scheduleCheck(path)
            break
          }
        }
      })
      dirWatchers.set(dir, w)
    } catch (err) {
      logger.warn(`wire-watcher: watch failed for ${dir}: ${(err as Error).message}`)
    }
  }
  for (const [dir, w] of dirWatchers) {
    if (!dirs.has(dir)) {
      w.close()
      dirWatchers.delete(dir)
    }
  }

  await Promise.all([...state.keys()].map((p) => checkDrift(p)))
  logger.debug(`wire-watcher: ${state.size} file(s) under watch`)
}

async function readManifest(): Promise<Manifest> {
  try {
    const text = await readFile(paths.backups.manifest, 'utf8')
    return JSON.parse(text) as Manifest
  } catch {
    return { version: 1, entries: [] }
  }
}

async function checkDrift(path: string): Promise<void> {
  const entry = state.get(path)
  if (!entry) return
  const wasDrifted = entry.drifted
  entry.lastChecked = Date.now()

  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    entry.drifted = true
    entry.reason = `file unreadable: ${(err as Error).message}`
    if (!wasDrifted) {
      logger.warn(`wire-watcher: ${path} unreadable; flagging as drift`)
    }
    return
  }

  // TOML files (Codex) need their own drift check — the JSON pointer
  // semantic check below doesn't apply to a non-JSON parser. We probe
  // the exact key/value pairs we wrote.
  let reason: string | null = null
  if (path.endsWith('.toml')) {
    reason = checkTomlDrift(text, entry.changes)
  } else {
    let data: unknown
    try {
      data = parseConfig(path, text)
    } catch (err) {
      entry.drifted = true
      entry.reason = `parse failed: ${(err as Error).message}`
      return
    }
    if (data === undefined) {
      entry.drifted = true
      entry.reason = 'config parse failed'
      return
    }
    reason = checkSemanticDrift(data, entry.changes)
  }

  entry.drifted = reason !== null
  entry.reason = reason ?? undefined

  if (entry.drifted && !wasDrifted) {
    logger.warn(`wire-watcher: drift — ${entry.agent} at ${path}: ${reason}`)
  } else if (!entry.drifted && wasDrifted) {
    logger.info(`wire-watcher: ${entry.agent} at ${path} back in sync`)
  }
}

function parseConfig(path: string, text: string): unknown {
  if (path.endsWith('.yaml') || path.endsWith('.yml')) {
    return parseYaml(text)
  }
  return parseJsonc<unknown>(text)
}

/**
 * Drift check for TOML files. The agent detector writes ChangeRecords
 * with `jsonPointer` like '/model_providers/agentfw/base_url' or
 * '/model_provider'. We translate those into TOML section + key lookups
 * via the same toml.ts helpers the rewriter uses.
 */
function checkTomlDrift(text: string, changes: ChangeRecord[]): string | null {
  for (const change of changes) {
    if (change.type !== 'set') continue
    const segs = change.jsonPointer
      .split('/')
      .slice(1)
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    let cur: string | undefined
    if (segs.length === 1) {
      cur = getTomlTopLevelString(text, segs[0]!)
    } else if (segs.length >= 2) {
      const key = segs[segs.length - 1]!
      const section = segs.slice(0, -1).join('.')
      cur = getTomlString(text, section, key)
    }
    if (typeof change.to !== 'string') continue
    if (cur !== change.to) {
      return `${change.jsonPointer} ≠ recorded value`
    }
  }
  return null
}

function checkSemanticDrift(data: unknown, changes: ChangeRecord[]): string | null {
  for (const change of changes) {
    if (change.type === 'set') {
      const cur = getAtJsonPointer(data, change.jsonPointer)
      if (!shallowEqual(cur, change.to)) {
        return `${change.jsonPointer} ≠ recorded value`
      }
    } else if (change.type === 'wrap-mcp') {
      // Wrap location depends on agent: claude-code uses /mcpServers/<name>,
      // hermes uses /mcp_servers/<name>.
      const server =
        getAtJsonPointer(data, `/mcpServers/${change.name}`) ??
        getAtJsonPointer(data, `/mcp_servers/${change.name}`)
      if (server == null || typeof server !== 'object') {
        return `mcp server '${change.name}' not found`
      }
      const s = server as { command?: unknown; args?: unknown }
      if (!shallowEqual(s.command, change.to.command)) {
        return `mcp '${change.name}'.command ≠ recorded value`
      }
      if (!shallowEqual(s.args, change.to.args)) {
        return `mcp '${change.name}'.args ≠ recorded value`
      }
    }
    // env-inject not used yet; treat as no-op for v0.1.
  }
  return null
}

function getAtJsonPointer(data: unknown, pointer: string): unknown {
  if (!pointer || pointer === '/') return data
  const segments = pointer.split('/').slice(1).map((s) =>
    s.replace(/~1/g, '/').replace(/~0/g, '~'),
  )
  let current: unknown = data
  for (const seg of segments) {
    if (current == null) return undefined
    if (Array.isArray(current)) {
      const idx = Number.parseInt(seg, 10)
      if (Number.isFinite(idx) && String(idx) === seg) {
        current = current[idx]
      } else {
        // Name-keyed array lookup (e.g. hermes custom_providers): find the
        // item with `.name === seg`.
        current = current.find(
          (x) =>
            x != null &&
            typeof x === 'object' &&
            (x as { name?: unknown }).name === seg,
        )
      }
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
  }
  return current
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!shallowEqual(a[i], b[i])) return false
    }
    return true
  }
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

function scheduleCheck(path: string): void {
  const prev = debouncers.get(path)
  if (prev) clearTimeout(prev)
  debouncers.set(
    path,
    setTimeout(() => {
      debouncers.delete(path)
      void checkDrift(path)
    }, 150),
  )
}

function startManifestWatcher(): void {
  if (manifestWatcher) return
  try {
    manifestWatcher = watch(dirname(paths.backups.manifest), (_event, filename) => {
      if (filename !== basename(paths.backups.manifest)) return
      if (manifestDebounce) clearTimeout(manifestDebounce)
      manifestDebounce = setTimeout(() => {
        void syncFromManifest()
      }, 100)
    })
  } catch (err) {
    logger.warn(`wire-watcher: manifest watch failed: ${(err as Error).message}`)
  }
}
