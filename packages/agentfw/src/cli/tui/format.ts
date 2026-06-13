import type { Detection } from '../detect/types.ts'

const SLOGAN = 'Putting agentfw on the wire…'

export function formatDetectionSummary(
  detections: Detection[],
  opts: { dryRun: boolean },
): string {
  const lines: string[] = []
  lines.push(SLOGAN)
  lines.push('')

  if (detections.length === 0) {
    lines.push('No supported agents found.')
    lines.push('Supported: claude-code, claude-desktop, codex, openclaw, hermes.')
    return lines.join('\n')
  }

  const plural = detections.length === 1 ? '' : 's'
  lines.push(`Found ${detections.length} agent${plural}:`)
  lines.push('')

  for (const d of detections) {
    const version = d.version ? `  ${d.version}` : ''
    const glyph = d.mode === 'manual' ? 'ⓘ' : '✓'
    const tag = d.mode === 'manual' ? '  (manual setup)' : ''
    lines.push(`  ${glyph} ${d.agent}${version}${tag}`)
    if (d.configPaths[0]) lines.push(`      ${d.configPaths[0]}`)

    for (const ep of d.endpoints) {
      lines.push(`      • ${ep.configLocation} → ${ep.agentfwBaseUrl}`)
    }

    if (d.mcpServers.length > 0) {
      const names = d.mcpServers.map((m) => m.name).join(', ')
      const sPlural = d.mcpServers.length === 1 ? '' : 's'
      lines.push(
        `      • wrap ${d.mcpServers.length} MCP server${sPlural}: ${names}`,
      )
    }

    for (const c of d.caveats) {
      lines.push(`      ⚠ ${c}`)
    }
    lines.push('')
  }

  if (opts.dryRun) {
    lines.push('(dry-run; nothing written)')
  }

  return lines.join('\n')
}
