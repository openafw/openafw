import { useCallback, useEffect, useState } from 'react'
import {
  fetchPolicy,
  fetchRegistry,
  setAgentRoute,
  setSubagentDowngrade,
  unsetAgentRoute,
} from '../../api'
import { HelpTip } from '../../components/HelpTip'
import type {
  CombinationModel,
  ModelEntry,
  PolicyResponse,
  Registry,
  RoutingTarget,
  SubagentDowngrade,
} from '../../types'

const PASSTHROUGH = '__passthrough__'
const COMBO_PREFIX = 'combo:'

// The select value for a route's current target: passthrough, a combination
// (`combo:<id>`), or a plain model id.
function currentRouteValue(t: RoutingTarget | undefined): string {
  if (!t || t.kind === 'passthrough') return PASSTHROUGH
  if (t.kind === 'composite') return `${COMBO_PREFIX}${t.comboId}`
  if (t.kind === 'chain' && t.members[0]) return t.members[0].modelId
  return PASSTHROUGH
}

function describeTarget(t: RoutingTarget | undefined, combos: CombinationModel[]): string {
  if (!t || t.kind === 'passthrough') return 'passthrough (no model swap)'
  if (t.kind === 'composite') {
    const c = combos.find((x) => x.id === t.comboId)
    return c ? `combination: ${c.label}` : `combination: ${t.comboId} (missing)`
  }
  return t.members.map((m) => m.modelId).join(' → ')
}

// A combination's one-line summary for the read-only Details column.
function comboSummary(c: CombinationModel): string {
  const parts = [c.members.map((m) => m.modelId).join(' → ')]
  if (c.capabilities?.vision?.via === 'companion')
    parts.push(`vision → ${c.capabilities.vision.modelId}`)
  if (c.capabilities?.web_search) parts.push('web_search')
  return parts.join(' · ')
}

export function RoutesTab() {
  const [registry, setRegistry] = useState<Registry | null>(null)
  const [policy, setPolicy] = useState<PolicyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [reg, pol] = await Promise.all([fetchRegistry(), fetchPolicy()])
      setRegistry(reg)
      setPolicy(pol)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Assign the route a single model, a combination, or passthrough. Failover /
  // vision / tools all live inside a combination now — a plain model is exactly
  // one model.
  const onChangeRoute = async (routeKey: string, value: string, models: ModelEntry[]) => {
    setBusy(routeKey)
    try {
      if (value === PASSTHROUGH) {
        await unsetAgentRoute(routeKey)
      } else if (value.startsWith(COMBO_PREFIX)) {
        await setAgentRoute(routeKey, {
          kind: 'composite',
          comboId: value.slice(COMBO_PREFIX.length),
        })
      } else {
        const model = models.find((m) => m.id === value)
        await setAgentRoute(routeKey, {
          kind: 'chain',
          members: [{ modelId: value, ...(model ? { providerId: model.providerId } : {}) }],
        })
      }
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const onSubagent = async (patch: Partial<SubagentDowngrade>) => {
    setBusy('subagent')
    try {
      await setSubagentDowngrade(patch)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (error && !registry) return <div className="error">Error: {error}</div>
  if (!registry || !policy) return <div className="loading">Loading…</div>

  const { models, providers, combos } = registry
  const sub = policy.subagentDowngrade
  const provName = (pid: string): string => providers.find((p) => p.id === pid)?.label ?? pid
  const comboById = (id: string) => combos.find((c) => c.id === id)

  return (
    <div>
      {error && <div className="error inline">{error}</div>}

      <section className="home-section">
        <h2>Per-agent routes</h2>
        <p className="hint">
          Each wired agent passes through unchanged, swaps to a single model, or uses a{' '}
          <strong>combination model</strong> (failover chain + vision + tools), built on the{' '}
          <strong>Models</strong> tab. <code>&lt;agent&gt;/*</code> is the agent-wide default.
        </p>
        {policy.routes.length === 0 ? (
          <div className="empty">
            <p>
              No routes yet — launch a wired agent (e.g. <code>agentfw claude</code>).
            </p>
          </div>
        ) : (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Route</th>
                <th>Decoder</th>
                <th>Currently</th>
                <th>Route to</th>
                <th>
                  Details
                  <HelpTip>
                    For a combination model, the chain + vision companion + tools it carries. Edit
                    these on the <strong>Models</strong> tab — a route just picks one.
                  </HelpTip>
                </th>
              </tr>
            </thead>
            <tbody>
              {policy.routes.map((r) => {
                const target = policy.policy.agents[r.routeKey]?.target
                const combo = target?.kind === 'composite' ? comboById(target.comboId) : undefined
                return (
                  <tr key={r.routeKey}>
                    <td>
                      <code>{r.routeKey}</code>
                    </td>
                    <td>{r.decoder}</td>
                    <td>{describeTarget(target, combos)}</td>
                    <td>
                      <select
                        disabled={busy === r.routeKey}
                        value={currentRouteValue(target)}
                        onChange={(e) => void onChangeRoute(r.routeKey, e.target.value, models)}
                      >
                        <option value={PASSTHROUGH}>passthrough (no swap)</option>
                        {combos.length > 0 && (
                          <optgroup label="Combination models">
                            {combos.map((c) => (
                              <option key={c.id} value={`${COMBO_PREFIX}${c.id}`}>
                                {c.label}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        <optgroup label="Models">
                          {models.map((m) => (
                            <option key={`${m.providerId}/${m.id}`} value={m.id}>
                              {m.id} ({provName(m.providerId)})
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    </td>
                    <td className="dim">
                      {combo ? (
                        comboSummary(combo)
                      ) : target?.kind === 'composite' ? (
                        <span title="this combination no longer exists">missing combination</span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      {sub && (
        <section className="home-section">
          <h2>Subagent downgrade</h2>
          <p className="hint">
            Route Claude Code dynamic-workflow subagents to a cheaper model; the planner stays on
            its model. Small utility calls (under the min output budget) are left untouched.
          </p>
          <table className="kv-table">
            <tbody>
              <tr>
                <td>Enabled</td>
                <td>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      disabled={busy === 'subagent'}
                      checked={sub.enabled}
                      onChange={(e) => void onSubagent({ enabled: e.target.checked })}
                    />{' '}
                    {sub.enabled ? 'on' : 'off'}
                  </label>
                </td>
              </tr>
              <tr>
                <td>
                  Run subagents on
                  <HelpTip>
                    The model Claude Code subagents are routed to while the planner stays on its own
                    model. Pick a model that's actually registered with a provider — an unregistered
                    id can't be resolved, so the call fails instead of downgrading.
                  </HelpTip>
                </td>
                <td>
                  <select
                    disabled={busy === 'subagent'}
                    value={sub.modelId}
                    onChange={(e) => void onSubagent({ modelId: e.target.value })}
                  >
                    {models.every((m) => m.id !== sub.modelId) ? (
                      <option value={sub.modelId}>{sub.modelId} (unregistered)</option>
                    ) : null}
                    {models.map((m) => (
                      <option key={`${m.providerId}/${m.id}`} value={m.id}>
                        {m.id} ({provName(m.providerId)}){m.id === sub.modelId ? ' — current' : ''}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
              <tr>
                <td>
                  Min output budget
                  <HelpTip>
                    agentfw tells a subagent apart from a tiny utility call by the request's
                    <code> max_tokens</code>. Calls asking for fewer than{' '}
                    {sub.minMaxTokens.toLocaleString()} output tokens are treated as utility calls
                    and left on their original model — only larger calls get downgraded.
                  </HelpTip>
                </td>
                <td>leave calls under {sub.minMaxTokens.toLocaleString()} max_tokens untouched</td>
              </tr>
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
