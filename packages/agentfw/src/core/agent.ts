/** A source-agent identifier. Built-in agents agentfw ships detectors for
 *  are in `KNOWN_AGENTS`; the type is widened to `string` so user-defined
 *  (BYOA) agents can flow through the proxy by picking any URL label —
 *  no agentfw code change needed for a new agent type. The detector
 *  registry still only handles built-ins. */
export type AgentId = string

export const KNOWN_AGENTS = [
  'claude-code',
  'claude-desktop',
  'openclaw',
  'opencode',
  'hermes',
  'codex',
  'cursor',
  'gemini',
] as const satisfies readonly string[]

export type KnownAgentId = (typeof KNOWN_AGENTS)[number]

export function isKnownAgent(id: string): id is KnownAgentId {
  return (KNOWN_AGENTS as readonly string[]).includes(id)
}

export type RuntimeMode =
  | 'launch-per-task'
  | 'daemon-restartable'
  | 'repl-hotswappable'
  | 'manual'
