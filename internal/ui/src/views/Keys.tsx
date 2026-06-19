import { useCallback, useEffect, useState } from 'react'
import {
  createKey,
  fetchKeys,
  fetchRegistry,
  fetchTiers,
  revokeKey,
  setTier,
  unsetTier,
} from '../api'
import type {
  AccessKeyItem,
  CombinationModel,
  KeyConnection,
  ModelEntry,
  ProviderEntry,
  RoutingTarget,
  TierRow,
} from '../types'

const UNSET = '__unset__'

function provName(providers: ProviderEntry[], id: string): string {
  return providers.find((p) => p.id === id)?.label ?? id
}

// The select value for a tier's current mapping: unset, a fusion (`c:<id>`), or
// a model (`m:<providerId>/<modelId>`).
function currentTierValue(t: RoutingTarget | undefined): string {
  if (!t || t.kind === 'passthrough') return UNSET
  if (t.kind === 'composite') return `c:${t.comboId}`
  if (t.kind === 'chain' && t.members[0]) {
    const m = t.members[0]
    return `m:${m.providerId ?? ''}/${m.modelId}`
  }
  return UNSET
}

function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="muted"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
    >
      {done ? 'copied' : 'copy'}
    </button>
  )
}

function ConnectionCard({ conn, token }: { conn: KeyConnection; token: string }) {
  const rows: Array<[string, string]> = [
    ['Base URL (OpenAI)', conn.baseUrl],
    ['Base URL (Anthropic)', conn.anthropicBaseUrl],
    ['API key', token],
  ]
  return (
    <div className="card">
      <table className="kv-table">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>
                <code>{value}</code>
              </td>
              <td className="row-actions">
                <Copy value={value} />
              </td>
            </tr>
          ))}
          <tr>
            <td>Model names</td>
            <td>
              {conn.modelNames.map((m, i) => (
                <span key={m.tier}>
                  {i > 0 && ' · '}
                  <code>{m.name}</code>
                </span>
              ))}
            </td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  )
}

export function Keys() {
  const [tiers, setTiers] = useState<TierRow[] | null>(null)
  const [conn, setConn] = useState<KeyConnection | null>(null)
  const [keys, setKeys] = useState<AccessKeyItem[] | null>(null)
  const [models, setModels] = useState<ModelEntry[]>([])
  const [providers, setProviders] = useState<ProviderEntry[]>([])
  const [combos, setCombos] = useState<CombinationModel[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [label, setLabel] = useState('default')

  const load = useCallback(async () => {
    try {
      const [t, k, reg] = await Promise.all([fetchTiers(), fetchKeys(), fetchRegistry()])
      setTiers(t.tiers)
      setConn(t.connection)
      setKeys(k.keys)
      setModels(reg.models)
      setProviders(reg.providers)
      setCombos(reg.combos)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      await load()
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onTierChange = (tier: string, value: string) =>
    run(async () => {
      if (value === UNSET) {
        await unsetTier(tier)
        return
      }
      if (value.startsWith('c:')) {
        await setTier(tier, { kind: 'composite', comboId: value.slice(2) })
        return
      }
      // m:<providerId>/<modelId>
      const rest = value.slice(2)
      const slash = rest.indexOf('/')
      const providerId = rest.slice(0, slash)
      const modelId = rest.slice(slash + 1)
      const target: RoutingTarget = {
        kind: 'chain',
        members: [{ modelId, ...(providerId ? { providerId } : {}) }],
      }
      await setTier(tier, target)
    })

  if (!tiers || !conn || !keys) {
    return <div className="hint">{error ? `Error: ${error}` : 'Loading…'}</div>
  }

  const noModels = models.length === 0

  return (
    <div>
      {error && <div className="error">{error}</div>}

      <section className="home-section">
        <h2>Models</h2>
        <p className="hint">
          afw exposes three fixed model names, low → high. Map each to one of your configured models
          (or a Fusion combo); agents request these names and afw routes to your choice.
        </p>
        {noModels ? (
          <p className="hint">
            Register a model first on the <a href="#/routing">Routing</a> tab (or{' '}
            <code>afw model add</code>).
          </p>
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Model name</th>
                <th>Maps to</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => (
                <tr key={t.tier}>
                  <td>
                    <code>{t.display}</code>
                  </td>
                  <td>
                    <select
                      value={currentTierValue(t.target)}
                      disabled={busy}
                      onChange={(e) => void onTierChange(t.tier, e.target.value)}
                    >
                      <option value={UNSET}>— not mapped —</option>
                      {combos.length > 0 && (
                        <optgroup label="Model Fusion">
                          {combos.map((c) => (
                            <option key={c.id} value={`c:${c.id}`}>
                              {c.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup label="Models">
                        {models.map((m) => (
                          <option
                            key={`${m.providerId}/${m.id}`}
                            value={`m:${m.providerId}/${m.id}`}
                          >
                            {m.id} ({provName(providers, m.providerId)})
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="home-section">
        <h2>API keys</h2>
        <p className="hint">
          An API key is an auth token. Point your OpenAI/Anthropic-compatible agent at the base URL
          below with a key, and request one of the three model names. Claude Code / Codex need no
          key — run <code>afw claude</code> or <code>afw codex</code>.
        </p>

        <ConnectionCard conn={conn} token={keys[0]?.token ?? '(create a key below)'} />

        {keys.length === 0 ? (
          <p className="hint">No keys yet — create one below.</p>
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Label</th>
                <th>Token</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.instance ? `${k.agent}@${k.instance}` : k.agent}</td>
                  <td>{k.label}</td>
                  <td>
                    <code>{k.token}</code>
                  </td>
                  <td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'}</td>
                  <td className="row-actions">
                    <Copy value={k.token} />
                    <button
                      type="button"
                      className="btn-danger"
                      disabled={busy}
                      onClick={() => void run(() => revokeKey(k.id))}
                    >
                      revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <form
          className="add-form"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              await createKey(label.trim() || 'default')
            })
          }}
        >
          <label>
            Label
            <input value={label} onChange={(e) => setLabel(e.target.value)} disabled={busy} />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            Create key
          </button>
        </form>
      </section>
    </div>
  )
}
