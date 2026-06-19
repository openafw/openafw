import type { AgentPacket, ModelCallPayload, RiskTag } from '../../core/packet.ts'

const PATTERNS: Array<{ tag: string; re: RegExp; severity: 'warn' | 'high' }> = [
  { tag: 'shell:rm-rf', re: /\brm\s+(?:-[rRfF]+\s+)+(?:\/|~|\$HOME|\.)/i, severity: 'high' },
  { tag: 'shell:curl-pipe-sh', re: /curl\s+[^|]+\|\s*(sudo\s+)?(sh|bash|zsh)/i, severity: 'high' },
  { tag: 'shell:wget-pipe-sh', re: /wget\s+[^|]+\|\s*(sudo\s+)?(sh|bash|zsh)/i, severity: 'high' },
  { tag: 'shell:sudo-rm', re: /\bsudo\s+rm\b/i, severity: 'high' },
  { tag: 'shell:chmod-777', re: /\bchmod\s+-?R?\s*7{3}\b/i, severity: 'warn' },
  { tag: 'shell:dd-to-dev', re: /\bdd\s+[^|]*of=\/dev\//i, severity: 'high' },
  { tag: 'shell:eval-pipe', re: /\beval\s+[`$]/i, severity: 'warn' },
]

const SHELL_TOOL_KEYS = new Set(['command', 'cmd', 'script', 'bash', 'shell'])

export function shellPatternTagger(packet: AgentPacket): RiskTag[] {
  if (packet.payload.kind !== 'model_call') return []
  const p = packet.payload as ModelCallPayload

  const tags: RiskTag[] = []
  const seen = new Set<string>()

  for (const block of p.response) {
    if (block.type !== 'tool_use') continue
    if (!isShellTool(block.name)) continue
    const cmd = extractCommand(block.input)
    if (!cmd) continue

    for (const pat of PATTERNS) {
      if (pat.re.test(cmd) && !seen.has(pat.tag)) {
        seen.add(pat.tag)
        tags.push({
          tag: pat.tag,
          severity: pat.severity,
          detail: { tool: block.name, cmd: cmd.slice(0, 200) },
        })
      }
    }
  }
  return tags
}

function isShellTool(name: string): boolean {
  const n = name.toLowerCase()
  return (
    n === 'bash' ||
    n === 'shell' ||
    n === 'exec' ||
    n.includes('run_command') ||
    n.includes('shell_exec')
  )
}

function extractCommand(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const obj = input as Record<string, unknown>
  for (const key of SHELL_TOOL_KEYS) {
    const v = obj[key]
    if (typeof v === 'string') return v
  }
  return null
}
