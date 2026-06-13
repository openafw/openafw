import { useEffect, useState } from 'react'
import { fetchMcp } from '../../api'
import { Time } from '../../components/Format'
import type { McpServerItem } from '../../types'

export function McpTab() {
  const [rows, setRows] = useState<McpServerItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchMcp()
      .then((r) => !cancelled && setRows(r))
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [])

  if (error && !rows) return <div className="error">Error: {error}</div>
  if (!rows) return <div className="loading">Loading…</div>
  if (rows.length === 0) {
    return (
      <div className="empty">
        <p>No MCP activity yet.</p>
        <p className="hint">
          Populated from new traffic. When an agent calls an MCP server (or an <code>mcp__*</code>{' '}
          tool), it shows up here aggregated across instances.
        </p>
      </div>
    )
  }

  return (
    <div className="run-list-wrap">
      <table className="runs">
        <thead>
          <tr>
            <th>MCP server</th>
            <th>Calls</th>
            <th>Methods</th>
            <th>Instances</th>
            <th>Tasks</th>
            <th>Errors</th>
            <th>Last active</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.server}>
              <td>
                <code>{s.server}</code>
              </td>
              <td>{s.callCount}</td>
              <td>{s.methodCount}</td>
              <td>{s.instanceCount}</td>
              <td>{s.taskCount}</td>
              <td>{s.errorCount || <span className="muted">—</span>}</td>
              <td>
                <Time ms={s.lastActive} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
