import { useEffect, useState } from 'react'
import { fetchTask } from '../api'
import { Cache, Duration, Time, Tokens, shortId } from '../components/Format'
import { OutcomeBadge, outcomeRowClass } from '../components/Outcome'
import type { TaskDetail as TaskDetailT } from '../types'

export function TaskDetail({ taskId }: { taskId: string }) {
  const [detail, setDetail] = useState<TaskDetailT | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchTask(taskId)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
  }, [taskId])

  if (error) return <div className="error">Error: {error}</div>
  if (!detail) return <div className="loading">Loading…</div>

  const { thread, runs } = detail

  return (
    <div className="task-detail">
      <div className="detail-back">
        <a href="#/tasks">← Tasks</a>
      </div>

      <h1 className="task-detail-title">{thread.title ?? <code>{shortId(thread.id)}</code>}</h1>
      <div className="task-meta">
        <span>{thread.agent}</span>
        <span>
          <Time ms={thread.startedAt} />
        </span>
        <span>
          <Duration ms={thread.durMs} />
        </span>
        <span>
          {thread.runCount} run{thread.runCount === 1 ? '' : 's'} · {thread.actionCount} actions
        </span>
        <span>
          model: {thread.model ? <code>{thread.model}</code> : <span className="muted">—</span>}
        </span>
        <OutcomeBadge outcome={thread.outcome} />
      </div>

      <section className="home-section">
        <h2>Runs in this task</h2>
        {runs.length === 0 ? (
          <div className="empty">
            <p>No runs captured for this task.</p>
          </div>
        ) : (
          <table className="runs">
            <thead>
              <tr>
                <th>Run</th>
                <th>Started</th>
                <th>Model</th>
                <th>Status</th>
                <th>Actions</th>
                <th>Dur</th>
                <th>In/Out</th>
                <th>Cache R/W</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.id}
                  className={outcomeRowClass(r.outcome)}
                  onClick={() => {
                    window.location.hash = `#/run/${encodeURIComponent(r.id)}`
                  }}
                >
                  <td>
                    <code>{shortId(r.id)}</code>
                  </td>
                  <td>
                    <Time ms={r.startedAt} />
                  </td>
                  <td>{r.model ? <code>{r.model}</code> : <span className="muted">—</span>}</td>
                  <td>{r.outcome !== 'ok' ? <OutcomeBadge outcome={r.outcome} /> : r.status}</td>
                  <td>{r.actionCount}</td>
                  <td>
                    <Duration ms={r.durMs} />
                  </td>
                  <td>
                    <Tokens tokensIn={r.tokensIn} tokensOut={r.tokensOut} />
                  </td>
                  <td>
                    <Cache read={r.cacheReadTokens} write={r.cacheWriteTokens} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
