import { useEffect, useState } from 'react'
import { fetchInstance } from '../../api'
import { Duration, Time, shortId } from '../../components/Format'
import { OutcomeBadge, outcomeRowClass } from '../../components/Outcome'
import type { AgentInstanceDetail, NameCount } from '../../types'

function UsagePanel({ title, rows, empty }: { title: string; rows: NameCount[]; empty: string }) {
  return (
    <section className="home-section instance-panel">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="hint">{empty}</p>
      ) : (
        <ul className="usage-list">
          {rows.map((r) => (
            <li key={r.name}>
              <code>{r.name}</code>
              {r.category && r.category !== 'builtin' ? (
                <span className="usage-cat">{r.category}</span>
              ) : null}
              <span className="usage-count">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function InstanceDetail({ instanceKey }: { instanceKey: string }) {
  const [detail, setDetail] = useState<AgentInstanceDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchInstance(instanceKey)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [instanceKey])

  if (error) return <div className="error">Error: {error}</div>
  if (!detail) return <div className="loading">Loading…</div>

  return (
    <div>
      <div className="detail-back">
        <a href="#/see/agents">← Agents</a>
      </div>
      <h2 className="task-detail-title">
        {detail.agent}
        {detail.instanceId ? (
          <>
            {' '}
            <code>{detail.instanceId}</code>
          </>
        ) : (
          <span className="muted"> (unknown instance)</span>
        )}
      </h2>

      <div className="instance-panels">
        <UsagePanel title="MCP servers" rows={detail.mcpServers} empty="No MCP calls." />
        <UsagePanel title="Skills" rows={detail.skills} empty="No skills used." />
        <UsagePanel title="Tools" rows={detail.tools} empty="No tool calls." />
      </div>

      <section className="home-section">
        <h3>Tasks</h3>
        {detail.tasks.length === 0 ? (
          <p className="hint">No tasks recorded for this instance.</p>
        ) : (
          <div className="run-list-wrap">
            <table className="runs">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Started</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th>Runs</th>
                  <th>Dur</th>
                </tr>
              </thead>
              <tbody>
                {detail.tasks.map((t) => (
                  <tr
                    key={t.id}
                    className={outcomeRowClass(t.outcome)}
                    onClick={() => {
                      window.location.hash = `#/task/${encodeURIComponent(t.id)}`
                    }}
                  >
                    <td>
                      {t.title ? (
                        <span className="task-title">{t.title}</span>
                      ) : (
                        <code>{shortId(t.id)}</code>
                      )}
                    </td>
                    <td>
                      <Time ms={t.startedAt} />
                    </td>
                    <td>{t.model ? <code>{t.model}</code> : <span className="muted">—</span>}</td>
                    <td>
                      {t.outcome !== 'ok' ? (
                        <OutcomeBadge outcome={t.outcome} />
                      ) : t.endedAt == null ? (
                        <span className="muted">running</span>
                      ) : (
                        'done'
                      )}
                    </td>
                    <td>{t.runCount}</td>
                    <td>
                      <Duration ms={t.durMs} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
