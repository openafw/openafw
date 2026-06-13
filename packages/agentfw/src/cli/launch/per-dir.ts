// Per-directory launch memory. `agentfw claude` in a project remembers the
// routing choice (model / monitor / raw / label) used there, so the next
// launch in the same directory reuses it without re-passing flags. Stored
// centrally under ~/.agentfw/launch/ keyed by the absolute cwd — nothing is
// written into the user's project tree.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentId } from '../../core/agent.ts'
import { atomicWrite, fileExists } from '../../core/atomic-file.ts'
import { AGENTFW_HOME } from '../../core/paths.ts'

export type LaunchConfig = {
  /** Route this instance to a single model. */
  model?: string
  /** 'monitor' = capture but never reroute; 'raw' = bypass agentfw entirely. */
  mode?: 'monitor' | 'raw'
  /** Instance label override (defaults to a cwd-derived slug). */
  as?: string
}

type DirMemory = {
  cwd: string
  agents: Record<string, LaunchConfig & { updatedAt: number }>
}

const launchDir = (): string => join(AGENTFW_HOME, 'launch')

function memoryPath(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
  return join(launchDir(), `${hash}.json`)
}

async function readDirMemory(cwd: string): Promise<DirMemory> {
  const path = memoryPath(cwd)
  if (!(await fileExists(path))) return { cwd, agents: {} }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as DirMemory
    if (parsed && typeof parsed === 'object' && parsed.agents) return parsed
  } catch {
    // corrupt file — start fresh
  }
  return { cwd, agents: {} }
}

/** The remembered launch config for `agent` in `cwd`, or undefined. */
export async function readLaunchConfig(
  cwd: string,
  agent: AgentId,
): Promise<LaunchConfig | undefined> {
  const mem = await readDirMemory(cwd)
  const entry = mem.agents[agent]
  if (!entry) return undefined
  const { updatedAt: _updatedAt, ...cfg } = entry
  return cfg
}

/** Persist the launch config for `agent` in `cwd`, merging into any sibling
 *  agents' entries for the same directory. Pass a timestamp from the caller
 *  (scripts can't call Date.now in some contexts; here it's fine). */
export async function writeLaunchConfig(
  cwd: string,
  agent: AgentId,
  cfg: LaunchConfig,
  now: number = Date.now(),
): Promise<void> {
  const mem = await readDirMemory(cwd)
  mem.cwd = cwd
  mem.agents[agent] = { ...cfg, updatedAt: now }
  await atomicWrite(memoryPath(cwd), `${JSON.stringify(mem, null, 2)}\n`)
}
