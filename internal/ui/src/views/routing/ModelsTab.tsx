import { useCallback, useEffect, useState } from 'react'
import {
  fetchRegistry,
  fetchToolProviders,
  removeCombo,
  removeModel,
  saveCombo,
  saveModel,
} from '../../api'
import type { CombinationModel, Modality, ProviderEntry, Registry, ToolProvider } from '../../types'
import { ComboEditor } from './ComboEditor'

const MODALITIES: Modality[] = ['text', 'image', 'pdf', 'audio', 'video']
const DEFAULT_CONTEXT_WINDOW = 131072

type ModelForm = { id: string; providerId: string; input: Modality[]; contextWindow: number }
const EMPTY_MODEL: ModelForm = {
  id: '',
  providerId: '',
  input: ['text'],
  contextWindow: DEFAULT_CONTEXT_WINDOW,
}

const providerName = (p: ProviderEntry): string => p.label || p.id

// The catalog of models routes can use (incl. provider-listed ones), plus the
// place to build reusable combination models (chain + vision + tools).
export function ModelsTab() {
  const [registry, setRegistry] = useState<Registry | null>(null)
  const [toolProviders, setToolProviders] = useState<ToolProvider[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [model, setModel] = useState<ModelForm>(EMPTY_MODEL)
  const [editingModel, setEditingModel] = useState<{ id: string; providerId: string } | null>(null)

  // Combination editor: null = closed, {} = creating, a combo = editing.
  const [comboEditing, setComboEditing] = useState<CombinationModel | null | undefined>(undefined)

  const load = useCallback(async () => {
    try {
      const [reg, tools] = await Promise.all([fetchRegistry(), fetchToolProviders()])
      setRegistry(reg)
      setToolProviders(tools.providers)
      setError(null)
      setModel((m) => ({ ...m, providerId: m.providerId || (reg.providers[0]?.id ?? '') }))
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

  // ── models ─────────────────────────────────────────────────────────
  const resetModelForm = () => {
    setModel({ ...EMPTY_MODEL, providerId: registry?.providers[0]?.id ?? '' })
    setEditingModel(null)
  }

  const editModel = (m: {
    id: string
    providerId: string
    input?: string[]
    contextWindow?: number
  }) => {
    setEditingModel({ id: m.id, providerId: m.providerId })
    setModel({
      id: m.id,
      providerId: m.providerId,
      input: (m.input as Modality[] | undefined)?.length ? (m.input as Modality[]) : ['text'],
      contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    })
  }

  const toggleModality = (mod: Modality) => {
    setModel((m) => {
      const has = m.input.includes(mod)
      const next = has ? m.input.filter((x) => x !== mod) : [...m.input, mod]
      return { ...m, input: next.length ? next : ['text'] }
    })
  }

  const submitModel = (e: React.FormEvent) => {
    e.preventDefault()
    if (!model.id.trim() || !model.providerId)
      return setError('model name and provider are required')
    void run(async () => {
      const id = model.id.trim()
      await saveModel({
        id,
        providerId: model.providerId,
        label: id,
        input: model.input,
        contextWindow: model.contextWindow > 0 ? model.contextWindow : DEFAULT_CONTEXT_WINDOW,
      })
      if (
        editingModel &&
        (editingModel.id !== id || editingModel.providerId !== model.providerId)
      ) {
        await removeModel(editingModel.id, editingModel.providerId)
      }
      resetModelForm()
    })
  }

  // ── combinations ───────────────────────────────────────────────────
  const submitCombo = (combo: Parameters<typeof saveCombo>[0]) =>
    void run(async () => {
      await saveCombo(combo)
      setComboEditing(undefined)
    })

  if (error && !registry) return <div className="error">Error: {error}</div>
  if (!registry) return <div className="loading">Loading…</div>

  const { providers, models, combos } = registry
  const describeMembers = (c: CombinationModel) => c.members.map((m) => m.modelId).join(' → ')
  const describeCaps = (c: CombinationModel) => {
    const parts: string[] = []
    if (c.capabilities?.vision?.via === 'companion')
      parts.push(`vision: ${c.capabilities.vision.modelId}`)
    if (c.capabilities?.web_search) parts.push('web_search')
    return parts.join(' · ')
  }

  return (
    <div>
      {error && <div className="error inline">{error}</div>}

      <section className="home-section">
        <h2>Models</h2>
        <p className="hint">
          The models routes can use. Discover them per provider on the{' '}
          <strong>Model providers</strong> tab, or add one by hand below. A model&apos;s name is the
          exact string agentfw sends as <code>model</code>; modalities are what it accepts as input.
        </p>
        {models.length === 0 ? (
          <p className="hint">No models yet — add one below, or list a provider&apos;s catalog.</p>
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Provider</th>
                <th>Modalities</th>
                <th>Window</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const prov = providers.find((p) => p.id === m.providerId)
                return (
                  <tr key={`${m.providerId}/${m.id}`}>
                    <td>
                      <code>{m.id}</code>
                    </td>
                    <td>{prov ? providerName(prov) : m.providerId}</td>
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
                        onClick={() => void run(() => removeModel(m.id, m.providerId))}
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

        <form className="add-form" onSubmit={submitModel}>
          <input
            placeholder="model name (sent to provider, e.g. claude-sonnet-4-6)"
            value={model.id}
            onChange={(e) => setModel({ ...model, id: e.target.value })}
          />
          <select
            value={model.providerId}
            onChange={(e) => setModel({ ...model, providerId: e.target.value })}
          >
            <option value="">— provider —</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {providerName(p)}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            step={1024}
            placeholder="context window (tokens)"
            value={model.contextWindow || ''}
            onChange={(e) =>
              setModel({ ...model, contextWindow: Number.parseInt(e.target.value, 10) || 0 })
            }
          />
          <span className="modality-select">
            {MODALITIES.map((mod) => (
              <label key={mod} className="toggle">
                <input
                  type="checkbox"
                  checked={model.input.includes(mod)}
                  onChange={() => toggleModality(mod)}
                />{' '}
                {mod}
              </label>
            ))}
          </span>
          <button type="submit" disabled={busy}>
            {editingModel ? 'save changes' : 'add model'}
          </button>
          {editingModel ? (
            <button type="button" className="btn-plain" disabled={busy} onClick={resetModelForm}>
              cancel
            </button>
          ) : null}
        </form>
      </section>

      <section className="home-section">
        <h2>Combination models</h2>
        <p className="hint">
          A reusable model that bundles an ordered failover chain plus a vision companion and a
          web_search tool. Assign one to an agent on the <strong>Routes</strong> tab and agentfw
          handles the model failover, image description, and tool calls for it.
        </p>
        {combos.length === 0 ? (
          <p className="hint">No combinations yet — create one below.</p>
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Models</th>
                <th>Capabilities</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {combos.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className="reg-name">{c.label}</span>
                    <span className="reg-id">{c.id}</span>
                  </td>
                  <td>{describeMembers(c)}</td>
                  <td className="dim">{describeCaps(c) || '—'}</td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="btn-plain"
                      disabled={busy}
                      onClick={() => setComboEditing(c)}
                    >
                      edit
                    </button>
                    <button
                      type="button"
                      className="btn-danger"
                      disabled={busy}
                      onClick={() => void run(() => removeCombo(c.id))}
                    >
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {comboEditing !== undefined ? (
          <ComboEditor
            models={models}
            providers={providers}
            toolProviders={toolProviders}
            editing={comboEditing}
            busy={busy}
            onSubmit={submitCombo}
            onCancel={() => setComboEditing(undefined)}
          />
        ) : (
          <button
            type="button"
            className="btn-small"
            disabled={models.length === 0}
            onClick={() => setComboEditing(null)}
          >
            + New combination model
          </button>
        )}
      </section>
    </div>
  )
}
