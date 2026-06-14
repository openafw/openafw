import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type DiscoveredModel,
  type ProviderInput,
  fetchModelList,
  fetchRegistry,
  removeModel,
  removeProvider,
  saveModel,
  saveProvider,
} from '../../api'
import type { Modality, ModelApi, ProviderEntry, Registry } from '../../types'

const APIS: ModelApi[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const AUTH_KINDS = ['passthrough', 'bearer', 'api-key'] as const
const MODALITIES: Modality[] = ['text', 'image', 'pdf', 'audio', 'video']

type ProviderForm = ProviderInput
const EMPTY_PROVIDER: ProviderForm = {
  name: '',
  baseUrl: '',
  api: 'openai-chat',
  authKind: 'bearer',
  authHeader: 'x-api-key',
  apiKey: '',
}

// contextWindow 0 = unset (the common case — agentfw only needs it for the rare
// model whose real window is smaller than what the agent asks for, to clamp the
// output budget).
type ModelDraft = { id: string; input: Modality[]; window: number; showWindow: boolean }
const EMPTY_DRAFT: ModelDraft = { id: '', input: ['text'], window: 0, showWindow: false }

const providerName = (p: ProviderEntry): string => p.label || p.id

// A provider is only useful once it has models, so this page treats "add a
// provider" and "give it models" as one flow: creating (or managing) a provider
// drops you into a models step — list its catalog or add by hand — that you
// finish explicitly. Models harvested at wire time appear here too.
export function ModelsTab() {
  const [registry, setRegistry] = useState<Registry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [prov, setProv] = useState<ProviderForm>(EMPTY_PROVIDER)
  const [editingProvider, setEditingProvider] = useState<string | null>(null)

  // The provider whose models we're setting up (the second step). null = the
  // provider list. Set right after creating a provider, or via "manage models".
  const [setup, setSetup] = useState<string | null>(null)
  const [draft, setDraft] = useState<ModelDraft>(EMPTY_DRAFT)
  const [editingModel, setEditingModel] = useState<string | null>(null)
  const [listing, setListing] = useState<{ models: DiscoveredModel[]; picked: Set<string> } | null>(
    null,
  )
  const modelNameRef = useRef<HTMLInputElement>(null)

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

  // Focus the model-name field whenever we enter the models step.
  useEffect(() => {
    if (setup) modelNameRef.current?.focus()
  }, [setup])

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

  // ── providers ──────────────────────────────────────────────────────
  const resetProviderForm = () => {
    setProv(EMPTY_PROVIDER)
    setEditingProvider(null)
  }

  const enterSetup = (providerId: string) => {
    setSetup(providerId)
    setDraft(EMPTY_DRAFT)
    setEditingModel(null)
    setListing(null)
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
    const creating = !editingProvider
    const name = prov.name.trim()
    setBusy(true)
    void (async () => {
      try {
        await saveProvider({
          ...prov,
          ...(editingProvider ? { id: editingProvider } : {}),
          ...(prov.authKind === 'api-key' ? {} : { authHeader: undefined }),
          ...(prov.authKind === 'passthrough' ? { apiKey: undefined } : {}),
        })
        const reg = await fetchRegistry()
        setRegistry(reg)
        setError(null)
        resetProviderForm()
        // On create, go straight into the models step for the new provider.
        if (creating) {
          const added =
            reg.providers.find((p) => (p.label || p.id) === name) ??
            reg.providers[reg.providers.length - 1]
          if (added) enterSetup(added.id)
        }
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setBusy(false)
      }
    })()
  }

  // ── models (within the setup step) ──────────────────────────────────
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
      setListing({ models, picked: new Set() })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const addPicked = (providerId: string) => {
    if (!listing) return
    const { models, picked } = listing
    void run(async () => {
      for (const m of models) {
        if (!picked.has(m.id)) continue
        await saveModel({ id: m.id, providerId, label: m.label ?? m.id, input: ['text'] })
      }
      setListing(null)
    })
  }

  const toggleModality = (mod: Modality) =>
    setDraft((d) => {
      const has = d.input.includes(mod)
      const next = has ? d.input.filter((x) => x !== mod) : [...d.input, mod]
      return { ...d, input: next.length ? next : ['text'] }
    })

  const editModel = (m: { id: string; input?: string[]; contextWindow?: number }) => {
    setEditingModel(m.id)
    setDraft({
      id: m.id,
      input: (m.input as Modality[] | undefined)?.length ? (m.input as Modality[]) : ['text'],
      window: m.contextWindow ?? 0,
      showWindow: !!m.contextWindow,
    })
    modelNameRef.current?.focus()
  }

  const addModel = (providerId: string) => {
    const id = draft.id.trim()
    if (!id) return setError('a model name is required')
    void run(async () => {
      await saveModel({
        id,
        providerId,
        label: id,
        input: draft.input,
        ...(draft.window > 0 ? { contextWindow: draft.window } : {}),
      })
      if (editingModel && editingModel !== id) await removeModel(editingModel, providerId)
      setDraft(EMPTY_DRAFT)
      setEditingModel(null)
      modelNameRef.current?.focus()
    })
  }

  if (error && !registry) return <div className="error">Error: {error}</div>
  if (!registry) return <div className="loading">Loading…</div>

  const { providers, models } = registry
  const modelsOf = (pid: string) => models.filter((m) => m.providerId === pid)

  // ── step 2: set up a provider's models ──────────────────────────────
  if (setup) {
    const provider = providers.find((p) => p.id === setup)
    if (!provider) {
      // Provider vanished (e.g. removed) — fall back to the list.
      setSetup(null)
      return <div className="loading">…</div>
    }
    const mine = modelsOf(provider.id)
    return (
      <div>
        {error && <div className="error inline">{error}</div>}
        <section className="home-section">
          <div className="detail-back">
            <button type="button" className="btn-plain" onClick={() => setSetup(null)}>
              ← all providers
            </button>
          </div>
          <h2>
            Models for <code>{providerName(provider)}</code>
          </h2>
          <p className="hint">
            A provider isn&apos;t usable until it has models. Pull its catalog with{' '}
            <strong>List models</strong>, or add them by hand — then finish.
          </p>

          {mine.length === 0 ? (
            <div className="flash">No models yet — list the catalog or add one below.</div>
          ) : (
            <table className="kv-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Modalities</th>
                  <th>Window</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mine.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <code>{m.id}</code>
                    </td>
                    <td>{(m.input ?? ['text']).join(', ')}</td>
                    <td>{m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k` : '—'}</td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="btn-plain"
                        disabled={busy}
                        onClick={() => editModel(m)}
                      >
                        edit
                      </button>
                      <button
                        type="button"
                        className="btn-danger"
                        disabled={busy}
                        onClick={() => void run(() => removeModel(m.id, provider.id))}
                      >
                        remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="setup-actions">
            <button
              type="button"
              className="btn-small"
              disabled={busy}
              onClick={() => void listModels(provider)}
            >
              List models from provider
            </button>
          </div>

          {listing && (
            <div className="list-models-panel">
              <div className="list-models-head">
                <strong>{listing.models.length}</strong> models from{' '}
                <code>{providerName(provider)}</code>
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
                    onClick={() => addPicked(provider.id)}
                  >
                    add {listing.picked.size} model{listing.picked.size === 1 ? '' : 's'}
                  </button>
                </>
              )}
            </div>
          )}

          <form
            className="add-form"
            onSubmit={(e) => {
              e.preventDefault()
              addModel(provider.id)
            }}
          >
            <input
              ref={modelNameRef}
              placeholder="model name (sent to provider, e.g. claude-sonnet-4-6)"
              value={draft.id}
              onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            />
            <span className="modality-select">
              {MODALITIES.map((mod) => (
                <label key={mod} className="toggle">
                  <input
                    type="checkbox"
                    checked={draft.input.includes(mod)}
                    onChange={() => toggleModality(mod)}
                  />{' '}
                  {mod}
                </label>
              ))}
            </span>
            {draft.showWindow ? (
              <input
                type="number"
                min={1}
                step={1024}
                placeholder="context window (tokens)"
                value={draft.window || ''}
                onChange={(e) =>
                  setDraft({ ...draft, window: Number.parseInt(e.target.value, 10) || 0 })
                }
              />
            ) : (
              <button
                type="button"
                className="btn-plain"
                disabled={busy}
                title="Only needed when the model's real context window is smaller than what the agent requests."
                onClick={() => setDraft({ ...draft, showWindow: true })}
              >
                + context window
              </button>
            )}
            <button type="submit" disabled={busy}>
              {editingModel ? 'save model' : 'add model'}
            </button>
            {editingModel ? (
              <button
                type="button"
                className="btn-plain"
                disabled={busy}
                onClick={() => {
                  setDraft(EMPTY_DRAFT)
                  setEditingModel(null)
                }}
              >
                cancel
              </button>
            ) : null}
          </form>

          <div className="setup-footer">
            <button
              type="button"
              className="btn-small btn-primary"
              disabled={busy || mine.length === 0}
              title={mine.length === 0 ? 'Add at least one model first' : ''}
              onClick={() => setSetup(null)}
            >
              Done
            </button>
            {mine.length === 0 && (
              <button
                type="button"
                className="btn-danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await removeProvider(provider.id)
                    setSetup(null)
                  })
                }
              >
                discard provider
              </button>
            )}
          </div>
        </section>
      </div>
    )
  }

  // ── step 1: the provider list + add-provider form ───────────────────
  return (
    <div>
      {error && <div className="error inline">{error}</div>}

      <section className="home-section">
        <h2>Model providers</h2>
        <p className="hint">
          An upstream agentfw can route to, and the models it serves. Add a provider, then give it
          models — list its catalog or add them by hand. Providers and models discovered at wire
          time appear here automatically.
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
              {providers.map((p) => {
                const count = modelsOf(p.id).length
                return (
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
                    <td>{p.auth?.kind ?? '—'}</td>
                    <td>
                      <code className="path">{p.baseUrl}</code>
                    </td>
                    <td>
                      {count === 0 ? (
                        <span className="dim" title="this provider has no models yet">
                          none
                        </span>
                      ) : (
                        count
                      )}
                    </td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="btn-plain"
                        disabled={busy}
                        onClick={() => enterSetup(p.id)}
                      >
                        {count === 0 ? 'add models' : 'manage models'}
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
                )
              })}
            </tbody>
          </table>
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
            {editingProvider ? 'save changes' : 'add provider → models'}
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
