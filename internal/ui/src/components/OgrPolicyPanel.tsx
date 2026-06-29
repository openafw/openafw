import { useEffect, useState } from 'react'
import { deleteOgrCommandRule, fetchOgrPolicy, setOgrContent, upsertOgrCommandRule } from '../api'
import type { OgrDecision, OgrPolicyResponse } from '../types'

// The OGR gateway policy control panel on the Guard page. afw is the OGR
// `gateway` altitude: it normalizes the wire into GuardEvents, runs these
// composed detectors per ~/.afw/ogr.policy.json, and folds the effective Verdict
// into the risk findings below. The operator edits the policy here — per OGR's
// gate it is the AGENT, not the human operator, that may not silently change a
// live policy. Every save writes the canonical OGR file and reloads it.
const DECISION_SEV: Record<OgrDecision, string> = {
  block: 'high',
  require_approval: 'high',
  redact: 'warn',
  modify: 'warn',
  allow: 'info',
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')

function DecisionSelect({
  value,
  options,
  disabled,
  onChange,
}: {
  value: OgrDecision
  options: OgrDecision[]
  disabled?: boolean
  onChange: (d: OgrDecision) => void
}) {
  return (
    <select
      className={`ogr-decision sev-${DECISION_SEV[value]}`}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as OgrDecision)}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

const BLANK_RULE = { id: '', regex: '', decision: 'require_approval' as OgrDecision, why: '' }

export function OgrPolicyPanel() {
  const [data, setData] = useState<OgrPolicyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState(BLANK_RULE)

  useEffect(() => {
    let cancelled = false
    fetchOgrPolicy()
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [])

  if (!data) return null

  const { policy, decisions } = data
  const cr = policy.contentRules

  const run = async (key: string, fn: () => Promise<OgrPolicyResponse>) => {
    setBusy(key)
    setError(null)
    try {
      setData(await fn())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const addRule = async () => {
    const id = (form.id || form.regex).trim()
    await run('__add', () =>
      upsertOgrCommandRule({ ...form, id, regex: form.regex.trim(), why: form.why.trim() }),
    )
    setForm(BLANK_RULE)
    setAdding(false)
  }

  return (
    <div className="mask-panel ogr-panel">
      <h2 className="mask-title">
        OGR gateway policy
        <span className="ogr-altitude">{data.altitude} altitude</span>
      </h2>
      <p className="hint ogr-source">
        {data.usingDefault ? 'Editing creates ' : 'Loaded from '}
        <code>{data.policyPath}</code>
        {data.usingDefault ? ' (canonical OGR format).' : ' — changes are saved back to the file.'}
      </p>
      {error && <div className="error ogr-error">{error}</div>}

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
                  <DecisionSelect
                    value={cr.injectionFromUntrusted}
                    options={decisions}
                    disabled={busy === 'untrusted'}
                    onChange={(d) =>
                      run('untrusted', () => setOgrContent({ injectionFromUntrusted: d }))
                    }
                  />
                </td>
              </tr>
              <tr>
                <td>injection · unverified</td>
                <td>
                  <DecisionSelect
                    value={cr.injectionFromUnverified}
                    options={decisions}
                    disabled={busy === 'unverified'}
                    onChange={(d) =>
                      run('unverified', () => setOgrContent({ injectionFromUnverified: d }))
                    }
                  />
                </td>
              </tr>
              <tr>
                <td>redact secrets</td>
                <td>
                  <label className="ogr-toggle">
                    <input
                      type="checkbox"
                      checked={cr.redactSecrets}
                      disabled={busy === 'secrets'}
                      onChange={(e) =>
                        run('secrets', () => setOgrContent({ redactSecrets: e.target.checked }))
                      }
                    />
                    {cr.redactSecrets ? 'redact' : 'block'}
                  </label>
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
          <p className="ogr-desc">Composition is file-only for now.</p>
        </section>
      </div>

      <section className="ogr-card ogr-rules">
        <div className="ogr-rules-head">
          <h3>Command rules ({policy.configRules.commandRules.length})</h3>
          <button type="button" className="btn-small" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : '+ Add rule'}
          </button>
        </div>

        {adding && (
          <div className="ogr-add">
            <input
              placeholder="id (optional)"
              value={form.id}
              onChange={(e) => setForm({ ...form, id: slug(e.target.value) })}
            />
            <input
              placeholder="regex (required)"
              className="ogr-add-regex"
              value={form.regex}
              onChange={(e) => setForm({ ...form, regex: e.target.value })}
            />
            <DecisionSelect
              value={form.decision}
              options={decisions}
              onChange={(d) => setForm({ ...form, decision: d })}
            />
            <input
              placeholder="why"
              value={form.why}
              onChange={(e) => setForm({ ...form, why: e.target.value })}
            />
            <button
              type="button"
              className="btn-small"
              disabled={!form.regex.trim() || busy === '__add'}
              onClick={addRule}
            >
              Save
            </button>
          </div>
        )}

        <table className="runs">
          <thead>
            <tr>
              <th>Decision</th>
              <th>Rule</th>
              <th>Category</th>
              <th>Pattern</th>
              <th>Why</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {policy.configRules.commandRules.map((r) => (
              <tr key={r.id}>
                <td>
                  <DecisionSelect
                    value={r.decision}
                    options={decisions}
                    disabled={busy === r.id}
                    onChange={(d) => run(r.id, () => upsertOgrCommandRule({ ...r, decision: d }))}
                  />
                </td>
                <td>{r.id}</td>
                <td>{r.category}</td>
                <td>
                  <code className="ogr-regex">{r.regex}</code>
                </td>
                <td className="guard-detail">{r.why}</td>
                <td>
                  <button
                    type="button"
                    className="btn-small btn-danger"
                    disabled={busy === r.id}
                    onClick={() => run(r.id, () => deleteOgrCommandRule(r.id))}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
