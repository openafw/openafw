import type { Context } from 'hono'
import {
  type CustomRuleConfig,
  type MaskingConfig,
  enabledRuleIds,
  readMaskingConfig,
  removeCustomRule,
  ruleCatalog,
  setProviderRuleEnabled,
  setProviderRules,
  setRuleFake,
  upsertCustomRule,
} from '../../core/masking.ts'
import { getModelRegistry } from '../routing/load.ts'

/** The providers masking can be configured per — the registry providers (a
 *  seeded `<agent>/*` for each passthrough route, plus every routing target the
 *  user added). Keyed by provider id, which is what the proxy keys masking on. */
function listProviders(): Array<{ id: string; label: string; baseUrl: string }> {
  return getModelRegistry()
    .providers.map((p) => ({ id: p.id, label: p.label?.trim() || p.id, baseUrl: p.baseUrl }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

function buildResponse(cfg: MaskingConfig): {
  rules: ReturnType<typeof ruleCatalog>
  providers: Array<{ id: string; label: string; baseUrl?: string; enabled: string[] }>
} {
  const providers: Array<{ id: string; label: string; baseUrl?: string; enabled: string[] }> =
    listProviders().map((p) => ({
      id: p.id,
      label: p.label,
      baseUrl: p.baseUrl,
      enabled: enabledRuleIds(cfg, p.id),
    }))
  // Surface providers that have masking config but are no longer in the registry
  // (e.g. one was removed) so the user can still see / clear them.
  for (const [id, enabled] of Object.entries(cfg.providers)) {
    if (!providers.some((p) => p.id === id)) providers.push({ id, label: id, enabled })
  }
  return { rules: ruleCatalog(cfg), providers }
}

/** GET /api/masking — the rule catalog (built-in + custom, with effective fakes)
 *  and the per-provider enabled selection. Masking is opt-in and off for every
 *  provider by default. */
export async function handleGetMasking(c: Context): Promise<Response> {
  return c.json(buildResponse(await readMaskingConfig()))
}

/** POST /api/masking/rule { provider, id, enabled } — toggle one rule for one
 *  provider. */
export async function handlePostMaskingRule(c: Context): Promise<Response> {
  const b = (await c.req.json().catch(() => ({}))) as {
    provider?: unknown
    id?: unknown
    enabled?: unknown
  }
  if (
    typeof b.provider !== 'string' ||
    typeof b.id !== 'string' ||
    typeof b.enabled !== 'boolean'
  ) {
    return c.json({ error: 'masking: expected { provider, id, enabled }' }, 400)
  }
  return c.json(buildResponse(await setProviderRuleEnabled(b.provider, b.id, b.enabled)))
}

/** POST /api/masking/provider { provider, enabled: string[] } — set a provider's
 *  whole enabled set at once (powers select-all / clear-all). */
export async function handlePostMaskingProvider(c: Context): Promise<Response> {
  const b = (await c.req.json().catch(() => ({}))) as { provider?: unknown; enabled?: unknown }
  if (
    typeof b.provider !== 'string' ||
    !Array.isArray(b.enabled) ||
    !b.enabled.every((x) => typeof x === 'string')
  ) {
    return c.json({ error: 'masking: expected { provider, enabled: string[] }' }, 400)
  }
  return c.json(buildResponse(await setProviderRules(b.provider, b.enabled as string[])))
}

/** POST /api/masking/fake { id, fake } — override the fake a rule swaps in (an
 *  empty / default-equal value resets it). */
export async function handlePostMaskingFake(c: Context): Promise<Response> {
  const b = (await c.req.json().catch(() => ({}))) as { id?: unknown; fake?: unknown }
  if (typeof b.id !== 'string' || typeof b.fake !== 'string') {
    return c.json({ error: 'masking: expected { id, fake }' }, 400)
  }
  return c.json(buildResponse(await setRuleFake(b.id, b.fake)))
}

/** POST /api/masking/custom — add or edit a user-defined credential type. */
export async function handlePostMaskingCustom(c: Context): Promise<Response> {
  const b = (await c.req.json().catch(() => ({}))) as Partial<CustomRuleConfig>
  if (
    typeof b.id !== 'string' ||
    b.id.length === 0 ||
    typeof b.pattern !== 'string' ||
    typeof b.fake !== 'string' ||
    b.fake.length === 0
  ) {
    return c.json({ error: 'masking: expected { id, label, pattern, fake }' }, 400)
  }
  const parsedPattern = parseRegexInput(b.pattern)
  const rule: CustomRuleConfig = {
    id: b.id,
    label: typeof b.label === 'string' && b.label ? b.label : b.id,
    ...(typeof b.description === 'string' ? { description: b.description } : {}),
    pattern: parsedPattern.pattern,
    ...(typeof b.flags === 'string'
      ? { flags: b.flags }
      : parsedPattern.flags
        ? { flags: parsedPattern.flags }
        : {}),
    ...(typeof b.group === 'number' ? { group: b.group } : {}),
    fake: b.fake,
    ...(isMaskingScope(b.scope) ? { scope: b.scope } : {}),
  }
  const cfg = await upsertCustomRule(rule)
  // upsert is a no-op on a bad regex / built-in id collision — report that.
  if (!cfg.custom.some((r) => r.id === rule.id)) {
    return c.json({ error: 'masking: invalid pattern, or id collides with a built-in' }, 400)
  }
  return c.json(buildResponse(cfg))
}

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

function isMaskingScope(v: unknown): v is CustomRuleConfig['scope'] {
  return (
    v != null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof (v as { role?: unknown }).role === 'string' &&
    ['system', 'developer', 'user', 'assistant', 'any'].includes(
      (v as { role: string }).role,
    ) &&
    typeof (v as { message?: unknown }).message === 'string' &&
    ['first', 'all'].includes((v as { message: string }).message)
  )
}

/** DELETE /api/masking/custom?id=… — remove a user-defined credential type. */
export async function handleDeleteMaskingCustom(c: Context): Promise<Response> {
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'masking: missing id' }, 400)
  return c.json(buildResponse(await removeCustomRule(id)))
}
