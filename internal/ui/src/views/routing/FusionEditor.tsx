import { useState } from 'react'
import type { CombinationModel, ModelEntry, ProviderEntry, SwitchRule, ToolProvider } from '../../types'

type Ref = { modelId: string; providerId?: string }
type Period = 'day' | 'month'

// Editor-local panel member: model + optional failover (token cap / on-error →
// fallback model). Flattened from the backend's {modelId, switchOn, fallback}.
type Member = {
  modelId: string
  providerId?: string
  fallback?: Ref
  tokenLimit: number // 0 = no cap
  period: Period
  onError: boolean
}

const memberKey = (m: Ref) => `${m.providerId ?? ''}/${m.modelId}`
const isVision = (m: ModelEntry) => (m.input ?? ['text']).includes('image')

const encodeRef = (m: Ref) =>
  `${encodeURIComponent(m.providerId ?? '')}/${encodeURIComponent(m.modelId)}`
function decodeRef(v: string): Ref {
  const slash = v.indexOf('/')
  const providerId = decodeURIComponent(v.slice(0, slash))
  const modelId = decodeURIComponent(v.slice(slash + 1))
  return { modelId, ...(providerId ? { providerId } : {}) }
}

// Hydrate an editor Member from a stored fusion panel member.
function toMember(m: CombinationModel['panel'][number]): Member {
  const tokens = m.switchOn?.find((r) => r.kind === 'tokens')
  return {
    modelId: m.modelId,
    ...(m.providerId ? { providerId: m.providerId } : {}),
    ...(m.fallback ? { fallback: m.fallback } : {}),
    tokenLimit: tokens && 'tokenLimit' in tokens ? tokens.tokenLimit : 0,
    period: tokens && 'period' in tokens ? (tokens.period as Period) : 'day',
    onError: m.switchOn?.some((r) => r.kind === 'error') ?? true,
  }
}

// Build/edit a Model Fusion combo: a panel of models that answer in parallel
// (each with its own token-cap / on-error failover to a backup model), one
// multimodal companion for the whole fusion, a web-search tool, and the judge +
// synthesizer that distil and write the final answer.
export function FusionEditor({
  models,
  providers,
  toolProviders,
  editing,
  busy,
  onSubmit,
  onCancel,
}: {
  models: ModelEntry[]
  providers: ProviderEntry[]
  toolProviders: ToolProvider[]
  editing: CombinationModel | null
  busy: boolean
  onSubmit: (combo: Parameters<typeof import('../../api').saveCombo>[0]) => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState(editing?.label ?? '')
  const [panel, setPanel] = useState<Member[]>(editing?.panel.map(toMember) ?? [])
  const [vision, setVision] = useState<string>(editing?.vision ? encodeRef(editing.vision) : '')
  const [webSearch, setWebSearch] = useState<string>(editing?.webSearch?.providerId ?? '')
  const [judge, setJudge] = useState<string>(editing?.judge ? encodeRef(editing.judge) : '')
  const [synth, setSynth] = useState<string>(
    editing?.synthesizer ? encodeRef(editing.synthesizer) : '',
  )

  const provName = (pid?: string) =>
    (pid && providers.find((p) => p.id === pid)?.label) || pid || '—'
  const used = new Set(panel.map(memberKey))
  const available = models.filter((m) => !used.has(`${m.providerId}/${m.id}`))
  const visionModels = models.filter(isVision)
  const webProviders = toolProviders.filter((t) => t.kind === 'web_search')

  const updateMember = (i: number, patch: Partial<Member>) =>
    setPanel(panel.map((m, j) => (j === i ? { ...m, ...patch } : m)))

  const submit = () => {
    if (!label.trim() || panel.length === 0) return
    onSubmit({
      ...(editing ? { id: editing.id } : {}),
      label: label.trim(),
      panel: panel.map((m) => {
        const switchOn: SwitchRule[] = []
        if (m.fallback) {
          if (m.tokenLimit > 0)
            switchOn.push({ kind: 'tokens', tokenLimit: m.tokenLimit, period: m.period })
          if (m.onError) switchOn.push({ kind: 'error' })
        }
        return {
          modelId: m.modelId,
          ...(m.providerId ? { providerId: m.providerId } : {}),
          ...(switchOn.length > 0 ? { switchOn } : {}),
          ...(m.fallback ? { fallback: m.fallback } : {}),
        }
      }),
      ...(vision ? { vision: decodeRef(vision) } : {}),
      ...(webSearch ? { webSearch: { providerId: webSearch } } : {}),
      ...(judge ? { judge: decodeRef(judge) } : {}),
      ...(synth ? { synthesizer: decodeRef(synth) } : {}),
    })
  }

  const modelOptions = models.map((m) => (
    <option
      key={`${m.providerId}/${m.id}`}
      value={encodeRef({ modelId: m.id, providerId: m.providerId })}
    >
      {m.id} ({provName(m.providerId)})
    </option>
  ))

  return (
    <div className="combo-editor">
      <div className="combo-row">
        <span className="combo-label">Name</span>
        <input
          placeholder="fusion name (e.g. frontier-panel)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>

      <div className="combo-row combo-row-top">
        <span className="combo-label">
          Panel
          <div className="dim">these models all answer in parallel — diversity is the point</div>
        </span>
        <div className="fallback-edit">
          {panel.map((m, i) => (
            <div className="fusion-member" key={memberKey(m)}>
              <div className="fallback-row">
                <span>
                  <code>{m.modelId}</code> <span className="dim">({provName(m.providerId)})</span>
                </span>
                <button
                  type="button"
                  className="btn-small"
                  disabled={busy}
                  onClick={() => setPanel(panel.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
              <div className="fusion-member-caps">
                <label className="fusion-cap">
                  <span className="dim">fallback</span>
                  <select
                    disabled={busy}
                    value={m.fallback ? encodeRef(m.fallback) : ''}
                    onChange={(e) =>
                      updateMember(i, {
                        fallback: e.target.value ? decodeRef(e.target.value) : undefined,
                      })
                    }
                  >
                    <option value="">none</option>
                    {models
                      .filter((x) => !(x.id === m.modelId && x.providerId === m.providerId))
                      .map((x) => (
                        <option
                          key={`${x.providerId}/${x.id}`}
                          value={encodeRef({ modelId: x.id, providerId: x.providerId })}
                        >
                          {x.id} ({provName(x.providerId)})
                        </option>
                      ))}
                  </select>
                </label>
                {m.fallback ? (
                  <>
                    <label className="fusion-cap">
                      <span className="dim">token cap</span>
                      <input
                        type="number"
                        min={0}
                        step={100000}
                        placeholder="none"
                        style={{ width: '7rem' }}
                        disabled={busy}
                        value={m.tokenLimit || ''}
                        onChange={(e) =>
                          updateMember(i, { tokenLimit: Number.parseInt(e.target.value, 10) || 0 })
                        }
                      />
                    </label>
                    <label className="fusion-cap">
                      <select
                        disabled={busy}
                        value={m.period}
                        onChange={(e) => updateMember(i, { period: e.target.value as Period })}
                      >
                        <option value="day">/ day</option>
                        <option value="month">/ month</option>
                      </select>
                    </label>
                    <label className="fusion-cap">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={m.onError}
                        onChange={(e) => updateMember(i, { onError: e.target.checked })}
                      />{' '}
                      <span className="dim">on failure</span>
                    </label>
                  </>
                ) : null}
              </div>
            </div>
          ))}
          {available.length > 0 && (
            <select
              disabled={busy}
              value=""
              onChange={(e) => {
                if (!e.target.value) return
                const ref = decodeRef(e.target.value)
                setPanel([...panel, { ...ref, tokenLimit: 0, period: 'day', onError: true }])
              }}
            >
              <option value="">+ add panel model…</option>
              {available.map((m) => (
                <option
                  key={`${m.providerId}/${m.id}`}
                  value={encodeRef({ modelId: m.id, providerId: m.providerId })}
                >
                  {m.id} ({provName(m.providerId)})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="combo-row">
        <span className="combo-label">
          Multimodal
          <div className="dim">
            one model that describes images for any text-only panel member — skip it if the panel
            is already multimodal
          </div>
        </span>
        <select disabled={busy} value={vision} onChange={(e) => setVision(e.target.value)}>
          <option value="">none</option>
          {visionModels.map((m) => (
            <option
              key={`${m.providerId}/${m.id}`}
              value={encodeRef({ modelId: m.id, providerId: m.providerId })}
            >
              {m.id} ({provName(m.providerId)})
            </option>
          ))}
        </select>
      </div>

      <div className="combo-row">
        <span className="combo-label">
          Web search
          <div className="dim">fulfills the panel&apos;s web_search calls (Anthropic clients)</div>
        </span>
        <select disabled={busy} value={webSearch} onChange={(e) => setWebSearch(e.target.value)}>
          <option value="">none</option>
          {webProviders.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label} ({t.backend})
            </option>
          ))}
        </select>
      </div>

      <div className="combo-row">
        <span className="combo-label">
          Synthesizer
          <div className="dim">
            Writes the final answer from the judge&apos;s notes. Most of fusion&apos;s quality gain
            comes from this step — <strong>use your strongest model here</strong>.
          </div>
        </span>
        <select disabled={busy} value={synth} onChange={(e) => setSynth(e.target.value)}>
          <option value="">default — the first panel model</option>
          {modelOptions}
        </select>
      </div>

      <div className="combo-row">
        <span className="combo-label">
          Judge
          <div className="dim">
            Organizes the panel&apos;s answers into structured notes (consensus, contradictions,
            blind spots) — it doesn&apos;t write the answer, so a solid mid-tier model is plenty.
          </div>
        </span>
        <select disabled={busy} value={judge} onChange={(e) => setJudge(e.target.value)}>
          <option value="">default — same model as the synthesizer</option>
          {modelOptions}
        </select>
      </div>

      <div className="combo-actions">
        <button
          type="button"
          className="btn-small btn-primary"
          disabled={busy || !label.trim() || panel.length === 0}
          onClick={submit}
        >
          {editing ? 'save changes' : 'create fusion'}
        </button>
        <button type="button" className="btn-small" disabled={busy} onClick={onCancel}>
          cancel
        </button>
      </div>
    </div>
  )
}
