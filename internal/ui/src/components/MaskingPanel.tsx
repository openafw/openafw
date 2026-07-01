import { useEffect, useState } from 'react'
import {
  type CustomMaskingInput,
  deleteMaskingCustom,
  fetchMasking,
  setMaskingFake,
  setMaskingProvider,
  setMaskingRule,
  upsertMaskingCustom,
} from '../api'
import type { MaskingProvider, MaskingRule, MaskingScope } from '../types'

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')

type MaskingForm = {
  label: string
  pattern: string
  fake: string
  scopeRole: MaskingScope['role']
  scopeMessage: MaskingScope['message']
}

const blankForm = (): MaskingForm => ({
  label: '',
  pattern: '',
  fake: '',
  scopeRole: 'any',
  scopeMessage: 'all',
})

function parseRegexInput(input: string): { pattern: string; flags?: string } {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return { pattern: input }

  let slash = -1
  for (let i = trimmed.length - 1; i > 0; i--) {
    if (trimmed[i] !== '/') continue
    let escapes = 0
    for (let j = i - 1; j >= 0 && trimmed[j] === '\\'; j--) escapes++
    if (escapes % 2 === 0) {
      slash = i
      break
    }
  }
  if (slash <= 0) return { pattern: input }

  const flags = trimmed.slice(slash + 1)
  if (!/^[A-Za-z]*$/.test(flags)) return { pattern: input }
  return {
    pattern: trimmed.slice(1, slash),
    ...(flags ? { flags } : {}),
  }
}

function scopeMessageLabel(message: MaskingScope['message']): string {
  return message === 'first' ? 'first message for role' : 'all messages'
}

// The credential-masking control panel on the Guard page. Masking is opt-in and
// configured per provider (registry provider id): pick a provider, then turn on
// the credential types to de-identify. When a rule is on, afw swaps that
// credential for a real-looking fake before the request reaches that provider,
// and restores the real value in the response — so the provider (or an API
// relay) never sees it, while the agent keeps working with the real key. The
// fakes are editable, and you can add your own credential types.
export function MaskingPanel() {
  const [rules, setRules] = useState<MaskingRule[] | null>(null)
  const [providers, setProviders] = useState<MaskingProvider[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [fakeDraft, setFakeDraft] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<MaskingForm>(blankForm)

  const apply = (p: { rules: MaskingRule[]; providers: MaskingProvider[] }) => {
    setRules(p.rules)
    setProviders(p.providers)
    setSelected((cur) => cur ?? p.providers[0]?.id ?? null)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    let cancelled = false
    fetchMasking()
      .then((r) => !cancelled && apply(r))
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [])

  const current = providers.find((p) => p.id === selected) ?? null

  const run = async (
    key: string,
    fn: () => Promise<{ rules: MaskingRule[]; providers: MaskingProvider[] }>,
  ) => {
    setBusy(key)
    setError(null)
    try {
      apply(await fn())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const toggle = (rule: MaskingRule, on: boolean) =>
    current && run(rule.id, () => setMaskingRule(current.id, rule.id, on))

  const selectAll = () =>
    current && run('__all', () => setMaskingProvider(current.id, rules?.map((r) => r.id) ?? []))
  const clearAll = () => current && run('__clear', () => setMaskingProvider(current.id, []))

  const saveFake = (rule: MaskingRule) => {
    const draft = fakeDraft[rule.id]
    if (draft == null || draft === rule.fake) return
    void run(`fake:${rule.id}`, () => setMaskingFake(rule.id, draft)).then(() =>
      setFakeDraft((d) => {
        const rest = { ...d }
        delete rest[rule.id]
        return rest
      }),
    )
  }

  const addCustom = () => {
    const id = slug(form.label)
    if (!id || !form.pattern || !form.fake) {
      setError('Custom credential needs a name, a pattern, and a fake value.')
      return
    }
    const parsedPattern = parseRegexInput(form.pattern)
    const rule: CustomMaskingInput = {
      id,
      label: form.label,
      pattern: parsedPattern.pattern,
      ...(parsedPattern.flags ? { flags: parsedPattern.flags } : {}),
      fake: form.fake,
      ...(form.scopeRole !== 'any' || form.scopeMessage !== 'all'
        ? { scope: { role: form.scopeRole, message: form.scopeMessage } }
        : {}),
    }
    void run('__custom', async () => {
      const created = await upsertMaskingCustom(rule)
      return current ? setMaskingRule(current.id, id, true) : created
    }).then(() => {
      setForm(blankForm())
      setAdding(false)
    })
  }

  return (
    <section className="mask-panel">
      <div className="mask-head">
        <h2 className="mask-title">Credential masking</h2>
        <span className="mask-sub">
          Off by default. Pick a provider and turn on the credential types to de-identify — they're
          swapped for real-looking fakes before the request reaches that provider, then restored in
          the response, so the provider (or an API relay) never sees the real value.
        </span>
      </div>
      {error && <div className="error">Error: {error}</div>}
      {rules == null ? (
        <div className="loading">Loading…</div>
      ) : providers.length === 0 ? (
        <div className="empty">
          <p>No providers yet.</p>
          <p className="hint">
            Add a provider (Routing) or launch an agent to register an upstream.
          </p>
        </div>
      ) : (
        <>
          <div className="mask-provider-row">
            <label className="mask-provider-label" htmlFor="mask-provider">
              Provider
            </label>
            <select
              id="mask-provider"
              className="mask-provider-select"
              value={selected ?? ''}
              onChange={(e) => setSelected(e.target.value)}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.baseUrl ? ` — ${p.baseUrl}` : ''} ({p.enabled.length} on)
                </option>
              ))}
            </select>
            <div className="mask-bulk">
              <button
                type="button"
                className="btn-small"
                disabled={busy != null}
                onClick={selectAll}
              >
                Select all
              </button>
              <button
                type="button"
                className="btn-small"
                disabled={busy != null}
                onClick={clearAll}
              >
                Clear
              </button>
            </div>
          </div>
          <table className="runs mask-table">
            <thead>
              <tr>
                <th>On</th>
                <th>Credential</th>
                <th>Matches</th>
                <th>Replaced with (editable)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => {
                const on = current?.enabled.includes(rule.id) ?? false
                const draft = fakeDraft[rule.id] ?? rule.fake
                return (
                  <tr key={rule.id} className={on ? '' : 'mask-off'}>
                    <td>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={busy != null || !current}
                          onChange={(e) => void toggle(rule, e.target.checked)}
                        />
                      </label>
                    </td>
                    <td>
                      {rule.label}
                      {rule.custom && <span className="mask-badge">custom</span>}
                    </td>
                    <td className="mask-desc">
                      <code className="mask-pat">{rule.pattern}</code>
                      {rule.description ? (
                        <span className="mask-desc-text">{rule.description}</span>
                      ) : null}
                      {rule.scope ? (
                        <span className="mask-desc-text">
                          scope: {rule.scope.role} / {scopeMessageLabel(rule.scope.message)}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <div className="mask-replacement-edit">
                        <input
                          className="mask-fake-input"
                          value={draft}
                          spellCheck={false}
                          onChange={(e) =>
                            setFakeDraft((d) => ({ ...d, [rule.id]: e.target.value }))
                          }
                          onBlur={() => saveFake(rule)}
                          onKeyDown={(e) => e.key === 'Enter' && saveFake(rule)}
                        />
                        <button
                          type="button"
                          className="btn-small"
                          disabled={busy != null || draft === rule.fake}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => saveFake(rule)}
                        >
                          Save
                        </button>
                      </div>
                    </td>
                    <td>
                      {rule.custom && (
                        <button
                          type="button"
                          className="btn-small btn-danger"
                          disabled={busy != null}
                          onClick={() =>
                            void run(`del:${rule.id}`, () => deleteMaskingCustom(rule.id))
                          }
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {adding ? (
            <div className="mask-add-form">
              <input
                placeholder="Name (e.g. Internal token)"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
              />
              <input
                placeholder="Regex pattern (e.g. INT-[0-9]{8})"
                value={form.pattern}
                spellCheck={false}
                onChange={(e) => setForm({ ...form, pattern: e.target.value })}
              />
              <input
                placeholder="Replacement (supports $1, $<name>)"
                value={form.fake}
                spellCheck={false}
                onChange={(e) => setForm({ ...form, fake: e.target.value })}
              />
              <select
                value={form.scopeRole}
                onChange={(e) =>
                  setForm({
                    ...form,
                    scopeRole: e.target.value as MaskingScope['role'],
                  })
                }
              >
                <option value="any">any role</option>
                <option value="system">system</option>
                <option value="developer">developer</option>
                <option value="user">user</option>
                <option value="assistant">assistant</option>
              </select>
              <select
                value={form.scopeMessage}
                onChange={(e) =>
                  setForm({
                    ...form,
                    scopeMessage: e.target.value as MaskingScope['message'],
                  })
                }
              >
                <option value="all">all messages</option>
                <option value="first">first message for role</option>
              </select>
              <button
                type="button"
                className="btn-small btn-primary"
                disabled={busy != null}
                onClick={addCustom}
              >
                Add
              </button>
              <button type="button" className="btn-small" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="btn-small" onClick={() => setAdding(true)}>
              + Add credential type
            </button>
          )}
        </>
      )}
    </section>
  )
}
