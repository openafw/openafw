import type { AgentId } from './agent.ts'
import type { BackupId } from './ids.ts'

export const MANIFEST_VERSION = 2 as const

// Manifest files written by older afw versions. v1 entries lack the
// `fromAbsent` / `create-path` records needed for surgical reverse-replay,
// so `revertEntry` falls back to a whole-file restore for them.
export const SUPPORTED_MANIFEST_VERSIONS: readonly number[] = [1, 2]

export type Manifest = {
  version: number
  entries: BackupEntry[]
}

export type BackupEntry = {
  id: BackupId
  agent: AgentId
  originalPath: string
  backupPath: string
  originalSha256: string
  rewrittenSha256: string
  wiredAt: number
  changes: ChangeRecord[]
  /**
   * Schema version of this entry's `changes`. Entries written by afw
   * ≥ v0.5 carry `2` and support surgical reverse-replay on unwire; older
   * entries lack it and are restored whole-file.
   */
  manifestVersion?: typeof MANIFEST_VERSION
}

export type ChangeRecord =
  | {
      type: 'set'
      jsonPointer: string
      /** Value the pointer held before wire. Ignored when `fromAbsent`. */
      from?: unknown
      /** The pointer did not exist before wire — revert deletes it. */
      fromAbsent?: boolean
      to: unknown
    }
  | { type: 'wrap-mcp'; name: string; from: McpServerSnapshot; to: McpServerSnapshot }
  | { type: 'env-inject'; key: string; from?: string; to: string }
  /**
   * A parent object / section that wire had to create. Revert deletes it
   * again — the whole section for TOML (afw owns its provider id), or
   * the node if it is empty for JSON / YAML (shared namespaces).
   */
  | { type: 'create-path'; jsonPointer: string }

export type McpServerSnapshot = {
  command?: string
  args?: string[]
  url?: string
  type?: 'stdio' | 'http' | 'sse'
  env?: Record<string, string>
}
