import { useCallback, useEffect, useState } from 'react'
import { fetchRegistry, fetchToolProviders, removeCombo, saveCombo } from '../../api'
import type { CombinationModel, Registry, ToolProvider } from '../../types'
import { FusionEditor } from './FusionEditor'

// Dedicated home for Model Fusion — agentfw's local OpenRouter Fusion. A fusion
// model runs a panel of models (from the Models tab) in parallel, a judge
// distils their answers, and a synthesizer writes the final one. Built here,
// assigned to an agent on the Routes tab.
export function ModelFusionTab() {
  const [registry, setRegistry] = useState<Registry | null>(null)
  const [toolProviders, setToolProviders] = useState<ToolProvider[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // null = closed, {} via null sentinel = creating, a combo = editing.
  const [editing, setEditing] = useState<CombinationModel | null | undefined>(undefined)

  const load = useCallback(async () => {
    try {
      const [reg, tools] = await Promise.all([fetchRegistry(), fetchToolProviders()])
      setRegistry(reg)
      setToolProviders(tools.providers)
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

  const submit = (combo: Parameters<typeof saveCombo>[0]) =>
    void run(async () => {
      await saveCombo(combo)
      setEditing(undefined)
    })

  if (error && !registry) return <div className="error">Error: {error}</div>
  if (!registry) return <div className="loading">Loading…</div>

  const { providers, models, combos } = registry
  const describePanel = (c: CombinationModel) =>
    c.panel.map((m) => (m.fallback ? `${m.modelId}→${m.fallback.modelId}` : m.modelId)).join(' + ')
  const describePipeline = (c: CombinationModel) => {
    const judge = c.judge?.modelId ?? 'synthesizer'
    const synth = c.synthesizer?.modelId ?? c.panel[0]?.modelId ?? '—'
    const extras: string[] = []
    if (c.vision) extras.push(`vision: ${c.vision.modelId}`)
    if (c.webSearch) extras.push('web search')
    return `judge: ${judge} → synth: ${synth}${extras.length ? ` · ${extras.join(' · ')}` : ''}`
  }

  return (
    <div>
      {error && <div className="error inline">{error}</div>}

      <section className="home-section">
        <h2>Model Fusion</h2>
        <p className="hint">
          Diversity beats any one model. A fusion turns one request into a small deliberation across{' '}
          <em>your</em> providers, on your wire — then hands your agent a single answer. Assign a
          fusion to an agent on the <strong>Routes</strong> tab.
        </p>

        <div className="fusion-how">
          <div className="fusion-flow">
            <div className="fusion-step">
              <div className="fusion-step-n">1</div>
              <strong>Panel</strong>
              <p>
                Your models all answer the same prompt <em>in parallel</em>. Each can fail over to a
                backup on a token cap or error; one multimodal companion lets a text-only model join
                an image prompt.
              </p>
            </div>
            <div className="fusion-arrow" aria-hidden="true">
              →
            </div>
            <div className="fusion-step">
              <div className="fusion-step-n">2</div>
              <strong>Judge</strong>
              <p>
                Reads every answer and distils structured notes — consensus, contradictions, unique
                insights, blind spots. It organizes; it doesn&apos;t write the answer, so a mid-tier
                model is plenty.
              </p>
            </div>
            <div className="fusion-arrow" aria-hidden="true">
              →
            </div>
            <div className="fusion-step fusion-step-key">
              <div className="fusion-step-n">3</div>
              <strong>Synthesize</strong>
              <p>
                Writes the single best final answer, grounded in those notes. Most of the quality
                gain is here — <strong>give it your strongest model</strong>.
              </p>
            </div>
          </div>
          <p className="hint">
            Your agent sees one normal response. Cost = the sum of every call; latency = the slowest
            panel model + judge + synthesizer.
          </p>
        </div>

        {combos.length === 0 ? (
          <p className="hint">No fusion models yet — create one below.</p>
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Panel</th>
                <th>Pipeline</th>
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
                  <td>{describePanel(c)}</td>
                  <td className="dim">{describePipeline(c)}</td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="btn-plain"
                      disabled={busy}
                      onClick={() => setEditing(c)}
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

        {editing !== undefined ? (
          <FusionEditor
            models={models}
            providers={providers}
            toolProviders={toolProviders}
            editing={editing}
            busy={busy}
            onSubmit={submit}
            onCancel={() => setEditing(undefined)}
          />
        ) : (
          <button
            type="button"
            className="btn-small"
            disabled={models.length === 0}
            onClick={() => setEditing(null)}
          >
            + New fusion model
          </button>
        )}
        {models.length === 0 && (
          <p className="hint">Add some models on the <strong>Models</strong> tab first.</p>
        )}
      </section>
    </div>
  )
}
