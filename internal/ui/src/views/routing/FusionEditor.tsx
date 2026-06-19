import { useState } from 'react'
import type {
  CombinationModel,
  ModelEntry,
  ProviderEntry,
  SwitchRule,
  ToolProvider,
} from '../../types'

type Ref = { modelId: string; providerId?: string }
// The UI exposes day/month plus the subscription 5-hour rolling window.
type Period = 'day' | 'month' | '5h'
// The limit that, once crossed, fails this member over to its fallback:
//   tokens    — an absolute token cap (for api-key upstreams; we see the tokens)
//   quota-pct — a % of the provider's own reported quota (for OAuth subscriptions
//               like Claude/Codex, whose absolute budget is invisible)
type LimitKind = 'none' | 'tokens' | 'quota-pct'

// Editor-local panel member: model + optional failover (a limit and/or on-error
// → fallback model). Flattened from the backend's {modelId, switchOn, fallback}.
type Member = {
  modelId: string
  providerId?: string
  fallback?: Ref
  limitKind: LimitKind
  tokenLimit: number // 0 = no cap
  period: Period
  usedPct: number // quota-pct threshold, 0 = unset
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

// Map a stored period (`'day'|'month'|{rollingHours}`) to the editor's options.
function toPeriod(p: unknown): Period {
  if (p && typeof p === 'object' && 'rollingHours' in p) return '5h'
  return p === 'month' ? 'month' : 'day'
}

// Hydrate an editor Member from a stored fusion panel member.
function toMember(m: CombinationModel['panel'][number]): Member {
  const tokens = m.switchOn?.find((r) => r.kind === 'tokens')
  const pct = m.switchOn?.find((r) => r.kind === 'quota-pct')
  const limitKind: LimitKind = pct ? 'quota-pct' : tokens ? 'tokens' : 'none'
  return {
    modelId: m.modelId,
    ...(m.providerId ? { providerId: m.providerId } : {}),
    ...(m.fallback ? { fallback: m.fallback } : {}),
    limitKind,
    tokenLimit: tokens && 'tokenLimit' in tokens ? tokens.tokenLimit : 0,
    period: tokens && 'period' in tokens ? toPeriod(tokens.period) : '5h',
    usedPct: pct && 'usedPct' in pct ? pct.usedPct : 0,
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
  const [cheap, setCheap] = useState<string>(
    editing?.cheapModel ? encodeRef(editing.cheapModel) : '',
  )

  const provName = (pid?: string) =>
    (pid && providers.find((p) => p.id === pid)?.label) || pid || '—'
  // OAuth subscriptions (claude-code/codex) hide their absolute token budget, so
  // a % cap is the sensible default for them; api-key providers get a token cap.
  const isSubscription = (pid?: string) =>
    !!pid && providers.find((p) => p.id === pid)?.auth?.kind === 'agent-oauth'
  const defaultLimitKind = (pid?: string): LimitKind =>
    isSubscription(pid) ? 'quota-pct' : 'tokens'
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
          if (m.limitKind === 'tokens' && m.tokenLimit > 0) {
            const period = m.period === '5h' ? { rollingHours: 5 } : m.period
            switchOn.push({ kind: 'tokens', tokenLimit: m.tokenLimit, period })
          } else if (m.limitKind === 'quota-pct' && m.usedPct > 0) {
            switchOn.push({ kind: 'quota-pct', usedPct: m.usedPct })
          }
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
      ...(cheap ? { cheapModel: decodeRef(cheap) } : {}),
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
                      <span className="dim">switch when</span>
                      <select
                        disabled={busy}
                        value={m.limitKind}
                        onChange={(e) =>
                          updateMember(i, { limitKind: e.target.value as LimitKind })
                        }
                      >
                        <option value="none">never (only on failure)</option>
                        <option value="tokens">over token cap</option>
                        <option value="quota-pct">over subscription %</option>
                      </select>
                    </label>
                    {m.limitKind === 'tokens' ? (
                      <>
                        <label className="fusion-cap">
                          <input
                            type="number"
                            min={0}
                            step={100000}
                            placeholder="tokens"
                            style={{ width: '7rem' }}
                            disabled={busy}
                            value={m.tokenLimit || ''}
                            onChange={(e) =>
                              updateMember(i, {
                                tokenLimit: Number.parseInt(e.target.value, 10) || 0,
                              })
                            }
                          />
                        </label>
                        <label className="fusion-cap">
                          <select
                            disabled={busy}
                            value={m.period}
                            onChange={(e) => updateMember(i, { period: e.target.value as Period })}
                          >
                            <option value="5h">/ 5h</option>
                            <option value="day">/ day</option>
                            <option value="month">/ month</option>
                          </select>
                        </label>
                      </>
                    ) : null}
                    {m.limitKind === 'quota-pct' ? (
                      <label className="fusion-cap">
                        <input
                          type="number"
                          min={1}
                          max={100}
                          step={5}
                          placeholder="80"
                          style={{ width: '4.5rem' }}
                          disabled={busy}
                          value={m.usedPct || ''}
                          onChange={(e) =>
                            updateMember(i, { usedPct: Number.parseInt(e.target.value, 10) || 0 })
                          }
                        />
                        <span className="dim">% of 5h quota used</span>
                      </label>
                    ) : null}
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
                setPanel([
                  ...panel,
                  {
                    ...ref,
                    limitKind: defaultLimitKind(ref.providerId),
                    tokenLimit: 0,
                    period: '5h',
                    usedPct: 0,
                    onError: true,
                  },
                ])
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
            one model that describes images for any text-only panel member — skip it if the panel is
            already multimodal
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

      <div className="combo-row">
        <span className="combo-label">
          Cheap model
          <div className="dim">
            For the simple, high-volume work routed here — Claude Code subagents and hermes/openclaw
            cron jobs. These skip the panel and go straight to this one model.
          </div>
        </span>
        <select disabled={busy} value={cheap} onChange={(e) => setCheap(e.target.value)}>
          <option value="">none — every request runs the full fusion</option>
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
