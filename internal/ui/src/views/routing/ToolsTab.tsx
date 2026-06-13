import { useCallback, useEffect, useState } from 'react'
import {
  deleteToolProvider,
  fetchToolProviders,
  setActiveToolProvider,
  upsertToolProvider,
} from '../../api'
import type { SearchBackend, ToolProvider, ToolProvidersResponse } from '../../types'

const BACKENDS: SearchBackend[] = ['duckduckgo', 'brave', 'searxng', 'tavily', 'baidu']
const KEYED = new Set<SearchBackend>(['brave', 'tavily', 'baidu'])
const NEEDS_URL = new Set<SearchBackend>(['searxng'])

type NewTool = { id: string; backend: SearchBackend; baseUrl: string; apiKey: string }
const EMPTY: NewTool = { id: '', backend: 'duckduckgo', baseUrl: '', apiKey: '' }

/** Which provider actually serves web_search: the explicit active pick, else
 *  the first provider of that kind (matches the daemon's fallback). */
function activeId(store: ToolProvidersResponse): string | undefined {
  return store.active.web_search ?? store.providers.find((p) => p.kind === 'web_search')?.id
}

export function ToolsTab() {
  const [store, setStore] = useState<ToolProvidersResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<NewTool>(EMPTY)

  const load = useCallback(async () => {
    try {
      setStore(await fetchToolProviders())
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
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.id) return setError('tool provider id is required')
    void run(async () => {
      await upsertToolProvider({
        id: form.id,
        kind: 'web_search',
        backend: form.backend,
        ...(NEEDS_URL.has(form.backend) && form.baseUrl ? { baseUrl: form.baseUrl } : {}),
        ...(KEYED.has(form.backend) && form.apiKey ? { apiKey: form.apiKey } : {}),
      })
      setForm(EMPTY)
    })
  }

  if (error && !store) return <div className="error">Error: {error}</div>
  if (!store) return <div className="loading">Loading…</div>

  const active = activeId(store)
  const websearch = store.providers.filter((p) => p.kind === 'web_search')

  return (
    <div>
      {error && <div className="error inline">{error}</div>}

      <section className="home-section">
        <h2>Web search backends</h2>
        <p className="hint">
          Backends that fulfill the <code>web_search</code> capability for models that lack it. The
          active one serves every routed search; changes apply on the next call (no restart).
        </p>
        {websearch.length === 0 ? (
          <p className="hint">No tool providers.</p>
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Active</th>
                <th>Provider</th>
                <th>Backend</th>
                <th>Endpoint / key</th>
                <th>$/call</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {websearch.map((p: ToolProvider) => (
                <tr key={p.id}>
                  <td>
                    <input
                      type="radio"
                      name="active-web_search"
                      checked={active === p.id}
                      disabled={busy}
                      onChange={() => void run(() => setActiveToolProvider('web_search', p.id))}
                    />
                  </td>
                  <td>
                    {p.label}
                    {p.origin === 'seeded' && <span className="muted"> (default)</span>}
                  </td>
                  <td>{p.backend}</td>
                  <td>
                    {p.baseUrl ? <code className="path">{p.baseUrl}</code> : null}
                    {p.authRef ? <span className="ok-badge">key set</span> : null}
                    {!p.baseUrl && !p.authRef ? <span className="muted">—</span> : null}
                  </td>
                  <td>{p.costPerCall ? `$${p.costPerCall}` : '—'}</td>
                  <td>
                    {p.origin === 'seeded' ? (
                      <span className="muted">built-in</span>
                    ) : (
                      <button
                        type="button"
                        className="btn-danger"
                        disabled={busy}
                        onClick={() => void run(() => deleteToolProvider(p.id))}
                      >
                        remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <form className="add-form" onSubmit={submit}>
          <input
            placeholder="provider id"
            value={form.id}
            onChange={(e) => setForm({ ...form, id: e.target.value })}
          />
          <select
            value={form.backend}
            onChange={(e) => setForm({ ...form, backend: e.target.value as SearchBackend })}
          >
            {BACKENDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          {NEEDS_URL.has(form.backend) && (
            <input
              placeholder="instance URL"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
          )}
          {KEYED.has(form.backend) && (
            <input
              type="password"
              placeholder="API key"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          )}
          <button type="submit" disabled={busy}>
            add backend
          </button>
        </form>
      </section>
    </div>
  )
}
