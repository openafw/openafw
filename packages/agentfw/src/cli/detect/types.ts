import type { AgentId, RuntimeMode } from '../../core/agent.ts'
import type { BackupEntry, ChangeRecord } from '../../core/manifest.ts'
import type { DecoderKind, HarvestedModel, RouteAuth } from '../../core/routes.ts'
import type { UnwireReport } from '../backup/restore.ts'

export type Detection = {
  agent: AgentId
  mode: RuntimeMode
  version?: string
  configPaths: string[]
  endpoints: PlannedEndpoint[]
  mcpServers: PlannedMcpServer[]
  caveats: string[]
}

export type PlannedEndpoint = {
  /** The body-model value this route matches. Forms the second segment
   *  of the route key (`<agent>/<modelId>`). Use `'*'` to declare a
   *  wildcard route — typical for OAuth agents whose model list grows
   *  from observed traffic. */
  modelId: string
  /** What's currently in the agent's config. */
  originalBaseUrl: string
  /** What we'd point the agent to. */
  agentfwBaseUrl: string
  /** Where the proxy forwards to. Often equals originalBaseUrl. */
  upstream: string
  decoder: DecoderKind
  /** JSON Pointer (or yaml-path) for the change. */
  configLocation: string
  /** Which file holds it. */
  filePath: string
  /** When set, the proxy rewrites `body.model` to this id before
   *  forwarding upstream. Wrap-style only. */
  sourceModelId?: string
  /** Per-model metadata harvested at wire time. */
  harvest?: HarvestedModel
  /** Credential captured at wire time. */
  auth?: RouteAuth
  /** Detectors still rewrite every endpoint's config; `active` only
   *  governs route writes. */
  active?: boolean
}

export type PlannedMcpServer = {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  filePath: string
  configLocation: string
  originalCommand?: string
  originalArgs?: string[]
  originalUrl?: string
  env?: Record<string, string>
}

export type WireOutcome = {
  backupEntries: BackupEntry[]
  changes: ChangeRecord[]
  /** Credentials captured from the agent's config — persisted to
   *  secrets.json by the wire command, keyed `provider:<routeKey>`. */
  secrets?: { ref: string; value: string }[]
}

export type RunningStatus =
  | { running: false }
  | {
      running: true
      pid?: number
      mechanism: 'launchd' | 'systemd' | 'foreground' | 'unknown'
      service?: string
      idle?: boolean
    }

export type ApplyResult =
  | { kind: 'applied'; detail?: string }
  | { kind: 'restart'; cmd: string[]; willDrop: string[]; risk: 'low' | 'medium' | 'high' }
  | { kind: 'user-action'; instruction: string; lang?: string }
  | { kind: 'next-launch'; note?: string }

export type UnwireOptions = {
  force?: boolean
}

export interface Detector {
  agent: AgentId
  mode: RuntimeMode

  detect(): Promise<Detection | null>
  wire(detection: Detection): Promise<WireOutcome>
  unwire(entries: BackupEntry[], opts?: UnwireOptions): Promise<UnwireReport>

  probeRunning?(): Promise<RunningStatus>
  applyToRunning?(detection: Detection, status: RunningStatus): Promise<ApplyResult>
  manualInstructions?(detection: Detection): string
}
