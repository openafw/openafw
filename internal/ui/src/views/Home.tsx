import { useEffect, useState } from 'react'
import { fetchPolicy, fetchRegistry, fetchRisk, fetchTasks, fetchWireStatus } from '../api'
import { compactTokens, shortId } from '../components/Format'
import type {
  PolicyResponse,
  Registry,
  RiskPage,
  RoutingTarget,
  TaskListItem,
  WireStatus,
} from '../types'

function describeTarget(t: RoutingTarget | undefined): string {
  if (!t || t.kind === 'passthrough') return 'passthrough (no model swap)'
  if (t.kind === 'composite') return `fusion: ${t.comboId}`
  return t.members.map((m) => m.modelId).join(' → ')
}

function totalTokens(t: TaskListItem): number {
  return (t.tokensIn ?? 0) + (t.tokensOut ?? 0)
}

export function Home() {
  const [status, setStatus] = useState<WireStatus | null>(null)
  const [registry, setRegistry] = useState<Registry | null>(null)
  const [policy, setPolicy] = useState<PolicyResponse | null>(null)
  const [risk, setRisk] = useState<RiskPage | null>(null)
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [w, reg, pol, rk, tk] = await Promise.all([
          fetchWireStatus(),
          fetchRegistry(),
          fetchPolicy(),
          fetchRisk({ limit: 200 }),
          fetchTasks({ limit: 200 }),
        ])
        if (!cancelled) {
          setStatus(w)
          setRegistry(reg)
          setPolicy(pol)
          setRisk(rk)
          setTasks(tk.rows)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    }
    void load()
    const t = setInterval(load, 15_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  if (error) return <div className="error">Error: {error}</div>
  if (!status || !registry || !policy || !risk || !tasks)
    return <div className="loading">Loading…</div>

  const driftByAgent = new Map<string, boolean>()
  for (const e of status.entries) {
    if (e.drifted) driftByAgent.set(e.agent, true)
  }

  // The task that has moved the most tokens through the wire. afw ranks
  // by tokens, not dollars — it does not price traffic.
  const heaviestTask = tasks.reduce<TaskListItem | null>(
    (top, t) => (top == null || totalTokens(t) > totalTokens(top) ? t : top),
    null,
  )

  return (
    <div className="home">
      <section className="home-hero">
        <h1>afw</h1>
        <p className="home-sub">
          An AI agent firewall on the wire. Every call your agents make is captured here —
          <strong> see</strong> it, <strong>route</strong> it to the model you pick, and
          <strong> guard</strong> the untrusted content tool calls pull in.
        </p>
      </section>

      <div className="home-grid">
        <a className="home-card" href="#/tasks">
          <div className="home-card-num">{status.wiredAgents.length}</div>
          <div className="home-card-label">
            agent{status.wiredAgents.length === 1 ? '' : 's'} wired
          </div>
          <div className="home-card-cta">See tasks →</div>
        </a>
        <a className="home-card" href="#/routing">
          <div className="home-card-num">{registry.models.length}</div>
          <div className="home-card-label">
            models · {registry.providers.length} provider
            {registry.providers.length === 1 ? '' : 's'}
          </div>
          <div className="home-card-cta">Routing →</div>
        </a>
        <a className="home-card" href="#/guard">
          <div className="home-card-num">{risk.total}</div>
          <div className="home-card-label">risk finding{risk.total === 1 ? '' : 's'}</div>
          <div className="home-card-cta">Guard →</div>
        </a>
        {heaviestTask && totalTokens(heaviestTask) > 0 && (
          <a className="home-card" href={`#/task/${encodeURIComponent(heaviestTask.id)}`}>
            <div className="home-card-num">{compactTokens(totalTokens(heaviestTask))}</div>
            <div className="home-card-label">
              tokens · heaviest task
              <br />
              <span className="muted">
                {heaviestTask.title ?? shortId(heaviestTask.id)}
                {heaviestTask.model ? ` · ${heaviestTask.model}` : ''}
              </span>
            </div>
            <div className="home-card-cta">Open task →</div>
          </a>
        )}
      </div>

      <section className="home-section">
        <h2>Wired agents</h2>
        {status.wiredAgents.length === 0 ? (
          <div className="empty">
            <p>No agents wired yet.</p>
            <p className="hint">
              Launch one through afw — e.g. <code>afw claude</code>. afw never edits the agent's own
              config; it taps the wire per launch.
            </p>
          </div>
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Routes to</th>
                <th>Config</th>
              </tr>
            </thead>
            <tbody>
              {status.wiredAgents.map((agent) => (
                <tr key={agent}>
                  <td>{agent}</td>
                  <td>{describeTarget(policy.policy.agents[`${agent}/*`]?.target)}</td>
                  <td>
                    {driftByAgent.get(agent) ? (
                      <span className="run-error-badge">drifted</span>
                    ) : (
                      <span className="muted">untouched</span>
                    )}
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
