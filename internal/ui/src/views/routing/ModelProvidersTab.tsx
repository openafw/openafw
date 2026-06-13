import { useCallback, useEffect, useState } from 'react'
import {
  type DiscoveredModel,
  type ProviderInput,
  fetchModelList,
  fetchRegistry,
  removeProvider,
  saveModel,
  saveProvider,
} from '../../api'
import type { ModelApi, ProviderEntry, Registry } from '../../types'

const APIS: ModelApi[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const AUTH_KINDS = ['passthrough', 'bearer', 'api-key'] as const

type ProviderForm = ProviderInput

const EMPTY_PROVIDER: ProviderForm = {
  name: '',
  baseUrl: '',
  api: 'openai-chat',
  authKind: 'bearer',
  authHeader: 'x-api-key',
  apiKey: '',
}

const providerName = (p: ProviderEntry): string => p.label || p.id

// Provider-centric: CRUD providers and discover/add their models. The Models
// tab is where the resulting catalog lives and where combinations are built.
export function ModelProvidersTab() {
  const [registry, setRegistry] = useState<Registry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [prov, setProv] = useState<ProviderForm>(EMPTY_PROVIDER)
  const [editingProvider, setEditingProvider] = useState<string | null>(null)

  // list-models discovery panel state, keyed to the provider being listed.
  const [listing, setListing] = useState<{
    providerId: string
    models: DiscoveredModel[]
    picked: Set<string>
  } | null>(null)

  const load = useCallback(async () => {
    try {
      setRegistry(await fetchRegistry())
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

  const resetProviderForm = () => {
    setProv(EMPTY_PROVIDER)
    setEditingProvider(null)
  }

  const editProvider = (p: ProviderEntry) => {
    setEditingProvider(p.id)
    setProv({
      name: providerName(p),
      id: p.id,
      baseUrl: p.baseUrl,
      api: p.api,
      authKind: (p.auth?.kind as ProviderForm['authKind']) ?? 'bearer',
      authHeader: p.auth?.header ?? 'x-api-key',
      apiKey: '',
    })
  }

  const submitProvider = (e: React.FormEvent) => {
    e.preventDefault()
    if (!prov.name.trim() || !prov.baseUrl.trim())
      return setError('provider name and base URL are required')
    void run(async () => {
      await saveProvider({
        ...prov,
        ...(editingProvider ? { id: editingProvider } : {}),
        ...(prov.authKind === 'api-key' ? {} : { authHeader: undefined }),
        ...(prov.authKind === 'passthrough' ? { apiKey: undefined } : {}),
      })
      resetProviderForm()
    })
  }

  const listModels = async (p: ProviderEntry) => {
    setBusy(true)
    setError(null)
    try {
      const models = await fetchModelList({
        baseUrl: p.baseUrl,
        api: p.api,
        authKind: (p.auth?.kind as ProviderForm['authKind']) ?? 'passthrough',
        ...(p.auth?.header ? { authHeader: p.auth.header } : {}),
        providerId: p.id,
      })
      setListing({ providerId: p.id, models, picked: new Set() })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const addPicked = () => {
    if (!listing) return
    const { providerId, models, picked } = listing
    void run(async () => {
      for (const m of models) {
        if (!picked.has(m.id)) continue
        await saveModel({ id: m.id, providerId, label: m.label ?? m.id, input: ['text'] })
      }
      setListing(null)
    })
  }

  if (error && !registry) return <div className="error">Error: {error}</div>
  if (!registry) return <div className="loading">Loading…</div>

  const { providers, models } = registry
  const modelCount = (pid: string) => models.filter((m) => m.providerId === pid).length

  return (
    <div>
      {error && <div className="error inline">{error}</div>}

      <section className="home-section">
        <h2>Model providers</h2>
        <p className="hint">
          An upstream agentfw can route to. Add a provider, then <strong>List models</strong> to
          pull its catalog (or add models by hand on the <strong>Models</strong> tab). The
          discovered models become available to routes and combinations.
        </p>
        {providers.length === 0 ? (
          <p className="hint">No providers yet — add one below.</p>
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>API</th>
                <th>Auth</th>
                <th>Base URL</th>
                <th>Models</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="reg-name">{providerName(p)}</span>
                    {p.label && p.label !== p.id ? (
                      <span className="reg-id" title="internal id (referenced by routing)">
                        {p.id}
                      </span>
                    ) : null}
                  </td>
                  <td>{p.api}</td>
                  <td>{p.auth?.kind ?? p.authKind ?? '—'}</td>
                  <td>
                    <code className="path">{p.baseUrl}</code>
                  </td>
                  <td>{modelCount(p.id)}</td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="btn-plain"
                      disabled={busy}
                      onClick={() => void listModels(p)}
                    >
                      list models
                    </button>
                    <button
                      type="button"
                      className="btn-plain"
                      disabled={busy}
                      onClick={() => editProvider(p)}
                    >
                      edit
                    </button>
                    <button
                      type="button"
                      className="btn-danger"
                      disabled={busy}
                      onClick={() => void run(() => removeProvider(p.id))}
                    >
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {listing && (
          <div className="list-models-panel">
            <div className="list-models-head">
              <strong>{listing.models.length}</strong> models from <code>{listing.providerId}</code>
              <button type="button" className="btn-plain" onClick={() => setListing(null)}>
                close
              </button>
            </div>
            {listing.models.length === 0 ? (
              <p className="hint">No models returned.</p>
            ) : (
              <>
                <div className="list-models-grid">
                  {listing.models.map((m) => (
                    <label key={m.id} className="toggle">
                      <input
                        type="checkbox"
                        checked={listing.picked.has(m.id)}
                        onChange={(e) => {
                          const picked = new Set(listing.picked)
                          if (e.target.checked) picked.add(m.id)
                          else picked.delete(m.id)
                          setListing({ ...listing, picked })
                        }}
                      />{' '}
                      <code>{m.id}</code>
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn-small btn-primary"
                  disabled={busy || listing.picked.size === 0}
                  onClick={addPicked}
                >
                  add {listing.picked.size} model{listing.picked.size === 1 ? '' : 's'}
                </button>
              </>
            )}
          </div>
        )}

        <form className="add-form" onSubmit={submitProvider}>
          <input
            placeholder="provider name (e.g. Xiangxin)"
            value={prov.name}
            onChange={(e) => setProv({ ...prov, name: e.target.value })}
          />
          <input
            placeholder="base URL (https://…/v1)"
            value={prov.baseUrl}
            onChange={(e) => setProv({ ...prov, baseUrl: e.target.value })}
          />
          <select value={prov.api} onChange={(e) => setProv({ ...prov, api: e.target.value })}>
            {APIS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select
            value={prov.authKind}
            onChange={(e) =>
              setProv({ ...prov, authKind: e.target.value as ProviderForm['authKind'] })
            }
          >
            {AUTH_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {prov.authKind === 'api-key' && (
            <input
              placeholder="header (x-api-key)"
              value={prov.authHeader ?? ''}
              onChange={(e) => setProv({ ...prov, authHeader: e.target.value })}
            />
          )}
          {prov.authKind !== 'passthrough' && (
            <input
              type="password"
              placeholder={editingProvider ? 'API key (blank = keep)' : 'API key'}
              value={prov.apiKey ?? ''}
              onChange={(e) => setProv({ ...prov, apiKey: e.target.value })}
            />
          )}
          <button type="submit" disabled={busy}>
            {editingProvider ? 'save changes' : 'add provider'}
          </button>
          {editingProvider ? (
            <button type="button" className="btn-plain" disabled={busy} onClick={resetProviderForm}>
              cancel
            </button>
          ) : null}
        </form>
      </section>
    </div>
  )
}
