import { useState } from 'react'
import type { CombinationModel, ModelEntry, ProviderEntry, ToolProvider } from '../../types'

type Member = { modelId: string; providerId?: string }

const memberKey = (m: Member) => `${m.providerId ?? ''}/${m.modelId}`
const isVision = (m: ModelEntry) => (m.input ?? ['text']).includes('image')

// Encode/decode a model reference as a `providerId/modelId` select value so the
// same model id under two providers stays distinct.
const encodeRef = (m: { providerId?: string; modelId: string }) =>
  `${encodeURIComponent(m.providerId ?? '')}/${encodeURIComponent(m.modelId)}`
function decodeRef(v: string): Member {
  const slash = v.indexOf('/')
  const providerId = decodeURIComponent(v.slice(0, slash))
  const modelId = decodeURIComponent(v.slice(slash + 1))
  return { modelId, ...(providerId ? { providerId } : {}) }
}

// Build/edit a combination model: an ordered failover chain of models + a vision
// companion + a web_search tool provider. Composition lives here, not on routes.
export function ComboEditor({
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
  onSubmit: (combo: {
    id?: string
    label: string
    members: { modelId: string; providerId?: string; switchOn?: { kind: string }[] }[]
    capabilities?: Record<string, unknown>
  }) => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState(editing?.label ?? '')
  const [members, setMembers] = useState<Member[]>(
    editing?.members.map((m) => ({ modelId: m.modelId, providerId: m.providerId })) ?? [],
  )
  const visionCap = editing?.capabilities?.vision
  const [vision, setVision] = useState<string>(
    visionCap?.via === 'companion'
      ? encodeRef({ modelId: visionCap.modelId, providerId: visionCap.providerId })
      : '',
  )
  const wsCap = editing?.capabilities?.web_search
  const [webSearch, setWebSearch] = useState<string>(
    wsCap?.via === 'local' && wsCap.providerId ? wsCap.providerId : '',
  )

  const provName = (pid?: string) =>
    (pid && providers.find((p) => p.id === pid)?.label) || pid || '—'
  const used = new Set(members.map(memberKey))
  const available = models.filter((m) => !used.has(`${m.providerId}/${m.id}`))
  const visionModels = models.filter(isVision)

  const submit = () => {
    if (!label.trim() || members.length === 0) return
    const memberPayload = members.map((m, i) => ({
      modelId: m.modelId,
      ...(m.providerId ? { providerId: m.providerId } : {}),
      ...(i < members.length - 1 ? { switchOn: [{ kind: 'error' }] } : {}),
    }))
    const capabilities: Record<string, unknown> = {}
    if (vision) {
      const ref = decodeRef(vision)
      capabilities.vision = {
        via: 'companion',
        modelId: ref.modelId,
        ...(ref.providerId ? { providerId: ref.providerId } : {}),
      }
    }
    if (webSearch) capabilities.web_search = { via: 'local', providerId: webSearch }
    onSubmit({
      ...(editing ? { id: editing.id } : {}),
      label: label.trim(),
      members: memberPayload,
      ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    })
  }

  return (
    <div className="combo-editor">
      <div className="combo-row">
        <span className="combo-label">Name</span>
        <input
          placeholder="combination name (e.g. coding-with-vision)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>

      <div className="combo-row combo-row-top">
        <span className="combo-label">
          Models
          <div className="dim">primary first; the rest are error-failover fallbacks</div>
        </span>
        <div className="fallback-edit">
          {members.map((m, i) => (
            <div className="fallback-row" key={memberKey(m)}>
              <span>
                {i + 1}. <code>{m.modelId}</code>{' '}
                <span className="dim">
                  ({provName(m.providerId)}
                  {i === 0 ? ' · primary' : i === members.length - 1 ? ' · final' : ''})
                </span>
              </span>
              <button
                type="button"
                className="btn-small"
                disabled={busy}
                onClick={() => setMembers(members.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
          {available.length > 0 && (
            <select
              disabled={busy}
              value=""
              onChange={(e) => {
                if (!e.target.value) return
                setMembers([...members, decodeRef(e.target.value)])
              }}
            >
              <option value="">+ add model…</option>
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
          Vision companion
          <div className="dim">describes images when the chain's model is text-only</div>
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
          Web search tool
          <div className="dim">
            fulfills the agent's web_search calls via a tool provider (Anthropic clients only)
          </div>
        </span>
        <select disabled={busy} value={webSearch} onChange={(e) => setWebSearch(e.target.value)}>
          <option value="">none</option>
          {toolProviders
            .filter((t) => t.kind === 'web_search')
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} ({t.backend})
              </option>
            ))}
        </select>
      </div>

      <div className="combo-actions">
        <button
          type="button"
          className="btn-small btn-primary"
          disabled={busy || !label.trim() || members.length === 0}
          onClick={submit}
        >
          {editing ? 'save changes' : 'create combination'}
        </button>
        <button type="button" className="btn-small" disabled={busy} onClick={onCancel}>
          cancel
        </button>
      </div>
    </div>
  )
}
