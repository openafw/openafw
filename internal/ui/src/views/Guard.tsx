import { useEffect, useState } from 'react'
import { fetchRisk } from '../api'
import { Time, shortId } from '../components/Format'
import { MaskingPanel } from '../components/MaskingPanel'
import type { RiskFinding, RiskPage } from '../types'

const SEVERITY_ORDER: Record<string, number> = { high: 0, warn: 1, info: 2 }

function detailText(detail: unknown): string {
  if (detail == null) return ''
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

export function Guard() {
  const [page, setPage] = useState<RiskPage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const r = await fetchRisk({ limit: 200 })
        if (!cancelled) {
          setPage(r)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    }
    void load()
    const t = setInterval(load, 6000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  const counts =
    page?.findings.reduce<Record<string, number>>((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1
      return acc
    }, {}) ?? {}

  const sorted = [...(page?.findings ?? [])].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || b.ts - a.ts,
  )

  return (
    <div className="guard">
      <MaskingPanel />

      <h2 className="mask-title guard-findings-title">Risk findings</h2>
      {error && !page ? (
        <div className="error">Error: {error}</div>
      ) : !page ? (
        <div className="loading">Loading…</div>
      ) : page.findings.length === 0 ? (
        <div className="empty">
          <p>No risk findings.</p>
          <p className="hint">
            The detector pipeline (secret-leak, dangerous-shell) runs over every captured packet.
            Findings show up here as agents pull in untrusted content.
          </p>
        </div>
      ) : (
        <>
          <div className="guard-summary">
            {(['high', 'warn', 'info'] as const).map((s) => (
              <span key={s} className={`sev-pill sev-${s}`}>
                {counts[s] ?? 0} {s}
              </span>
            ))}
          </div>
          <table className="runs">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Detector</th>
                <th>Agent</th>
                <th>Kind</th>
                <th>When</th>
                <th>Detail</th>
                <th>Run</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((f: RiskFinding) => (
                <tr
                  key={`${f.actionId}-${f.tag}`}
                  onClick={() => {
                    window.location.hash = `#/run/${encodeURIComponent(f.runId)}`
                  }}
                >
                  <td>
                    <span className={`sev-pill sev-${f.severity}`}>{f.severity}</span>
                  </td>
                  <td>{f.tag}</td>
                  <td>{f.agent}</td>
                  <td>{f.kind}</td>
                  <td>
                    <Time ms={f.ts} />
                  </td>
                  <td className="guard-detail">{detailText(f.detail)}</td>
                  <td>
                    <code>{shortId(f.runId)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
