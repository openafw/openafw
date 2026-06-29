import { useEffect, useState } from 'react'
import { fetchOgrPolicy } from '../api'
import type { OgrDecision, OgrPolicyResponse } from '../types'

// Read-only view of the active OGR gateway policy. afw is the OGR `gateway`
// altitude: it normalizes the wire into GuardEvents, runs these composed
// detectors per ~/.afw/ogr.policy.json, and folds the effective Verdict into the
// risk findings below. The policy is authored in the file (canonical OGR
// snake_case) and reloaded; per OGR's approval gate the UI does not edit it live.
const DECISION_SEV: Record<OgrDecision, string> = {
  block: 'high',
  require_approval: 'high',
  redact: 'warn',
  modify: 'warn',
  allow: 'info',
}

function Pill({ decision }: { decision: OgrDecision }) {
  return <span className={`sev-pill sev-${DECISION_SEV[decision]}`}>{decision}</span>
}

export function OgrPolicyPanel() {
  const [data, setData] = useState<OgrPolicyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchOgrPolicy()
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [])

  if (error) return null
  if (!data) return null

  const { policy } = data
  const cr = policy.contentRules

  return (
    <div className="mask-panel ogr-panel">
      <h2 className="mask-title">
        OGR gateway policy
        <span className="ogr-altitude">{data.altitude} altitude</span>
      </h2>
      <p className="hint ogr-source">
        {data.usingDefault ? 'Using the bundled default policy. Create ' : 'Loaded from '}
        <code>{data.policyPath}</code>
        {data.usingDefault
          ? ' to customize (canonical OGR format).'
          : ' — edit the file to change.'}
      </p>

      <div className="ogr-grid">
        <section className="ogr-card">
          <h3>Detectors</h3>
          <ul className="ogr-list">
            {data.detectors.map((d) => (
              <li key={d.provider}>
                <code>{d.provider}</code>
                <span className="ogr-handles">{d.handles.join(', ')}</span>
                <div className="ogr-desc">{d.description}</div>
              </li>
            ))}
          </ul>
        </section>

        <section className="ogr-card">
          <h3>Content rules</h3>
          <table className="ogr-kv">
            <tbody>
              <tr>
                <td>injection · untrusted</td>
                <td>
                  <Pill decision={cr.injectionFromUntrusted} />
                </td>
              </tr>
              <tr>
                <td>injection · unverified</td>
                <td>
                  <Pill decision={cr.injectionFromUnverified} />
                </td>
              </tr>
              <tr>
                <td>secret leakage</td>
                <td>
                  <Pill decision={cr.redactSecrets ? 'redact' : 'block'} />
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="ogr-card">
          <h3>Composition</h3>
          <table className="ogr-kv">
            <tbody>
              {Object.entries(policy.composition).map(([cat, rule]) => (
                <tr key={cat}>
                  <td>
                    <code>{cat}</code>
                  </td>
                  <td>
                    {rule.strategy}
                    {rule.onAllFailed ? ` · fail→${rule.onAllFailed}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="ogr-card ogr-rules">
        <h3>Command rules ({policy.configRules.commandRules.length})</h3>
        <table className="runs">
          <thead>
            <tr>
              <th>Decision</th>
              <th>Rule</th>
              <th>Category</th>
              <th>Pattern</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {policy.configRules.commandRules.map((r) => (
              <tr key={r.id}>
                <td>
                  <Pill decision={r.decision} />
                </td>
                <td>{r.id}</td>
                <td>{r.category}</td>
                <td>
                  <code className="ogr-regex">{r.regex}</code>
                </td>
                <td className="guard-detail">{r.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
