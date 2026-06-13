import { useEffect, useState } from 'react'
import { type TasksPage, fetchTasks } from '../api'
import { Cache, Duration, Time, Tokens, shortId } from '../components/Format'
import { OutcomeBadge, outcomeRowClass } from '../components/Outcome'

const PAGE_SIZE = 50

export function TaskList() {
  const [page, setPage] = useState<TasksPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pageIndex, setPageIndex] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const r = await fetchTasks({ limit: PAGE_SIZE, offset: pageIndex * PAGE_SIZE })
        if (!cancelled) {
          setPage(r)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    }
    void load()
    const poll = setInterval(() => {
      if (pageIndex === 0) void load()
    }, 4000)
    return () => {
      cancelled = true
      clearInterval(poll)
    }
  }, [pageIndex])

  if (error && !page) return <div className="error">Error: {error}</div>
  if (page === null) return <div className="loading">Loading…</div>

  const { rows, total, offset, limit } = page
  const lastPage = Math.max(0, Math.ceil(total / limit) - 1)
  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(total, offset + rows.length)

  if (total === 0) {
    return (
      <div className="empty">
        <p>No tasks yet.</p>
        <p className="hint">
          Run a wired agent (e.g. <code>agentfw claude</code>) and refresh. A task is one correlated
          conversation — its turns show up as runs inside.
        </p>
      </div>
    )
  }

  return (
    <div className="run-list-wrap">
      <table className="runs">
        <thead>
          <tr>
            <th>Task</th>
            <th>Started</th>
            <th>Agent</th>
            <th>Model</th>
            <th>Status</th>
            <th>Runs</th>
            <th>Actions</th>
            <th>Dur</th>
            <th>In/Out</th>
            <th>Cache R/W</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
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
              <td>{t.agent}</td>
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
              <td>{t.actionCount}</td>
              <td>
                <Duration ms={t.durMs} />
              </td>
              <td>
                <Tokens tokensIn={t.tokensIn} tokensOut={t.tokensOut} />
              </td>
              <td>
                <Cache read={t.cacheReadTokens} write={t.cacheWriteTokens} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pager">
        <div className="pager-count">
          {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
        </div>
        <div className="pager-controls">
          <button
            type="button"
            disabled={pageIndex === 0}
            onClick={() => setPageIndex(0)}
            className="pager-btn"
          >
            « first
          </button>
          <button
            type="button"
            disabled={pageIndex === 0}
            onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
            className="pager-btn"
          >
            ← prev
          </button>
          <span className="pager-page">
            page {pageIndex + 1} / {lastPage + 1}
          </span>
          <button
            type="button"
            disabled={pageIndex >= lastPage}
            onClick={() => setPageIndex((p) => Math.min(lastPage, p + 1))}
            className="pager-btn"
          >
            next →
          </button>
          <button
            type="button"
            disabled={pageIndex >= lastPage}
            onClick={() => setPageIndex(lastPage)}
            className="pager-btn"
          >
            last »
          </button>
        </div>
      </div>
    </div>
  )
}
