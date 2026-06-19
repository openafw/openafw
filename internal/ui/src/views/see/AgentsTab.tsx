import { useEffect, useState } from 'react'
import { fetchInstances } from '../../api'
import { Time } from '../../components/Format'
import type { AgentInstanceItem } from '../../types'

export function AgentsTab() {
  const [rows, setRows] = useState<AgentInstanceItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetchInstances()
        .then((r) => {
          if (!cancelled) {
            setRows(r)
            setError(null)
          }
        })
        .catch((e) => !cancelled && setError((e as Error).message))
    void load()
    const poll = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(poll)
    }
  }, [])

  if (error && !rows) return <div className="error">Error: {error}</div>
  if (!rows) return <div className="loading">Loading…</div>
  if (rows.length === 0) {
    return (
      <div className="empty">
        <p>No agent instances yet.</p>
        <p className="hint">
          Populated from new traffic. Launch a wired agent (e.g. <code>afw claude</code>) — each
          running instance shows up here with the MCP servers, skills, and tools it used.
        </p>
      </div>
    )
  }

  return (
    <div className="run-list-wrap">
      <table className="runs">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Instance</th>
            <th>Tasks</th>
            <th>MCP</th>
            <th>Skills</th>
            <th>Tools</th>
            <th>Actions</th>
            <th>Last active</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr
              key={i.key}
              onClick={() => {
                window.location.hash = `#/instance/${i.key}`
              }}
            >
              <td>{i.agent}</td>
              <td>
                {i.instanceId ? (
                  <code>{i.instanceId}</code>
                ) : (
                  <span className="muted">(unknown)</span>
                )}
              </td>
              <td>{i.taskCount}</td>
              <td>{i.mcpCount || <span className="muted">—</span>}</td>
              <td>{i.skillCount || <span className="muted">—</span>}</td>
              <td>{i.toolCount || <span className="muted">—</span>}</td>
              <td>{i.actionCount}</td>
              <td>
                <Time ms={i.lastActive} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
