// `afw model add` — interactive, multi-provider model onboarding. Prompts
// for one or more providers + their models, validates each with a live probe,
// and registers them via the daemon's /api/routing surface. Modeled on
// references/openclaw's onboard flow, generalized to add many providers in one
// run. The flag-based `afw route provider/model add` stays for scripting.

import process from 'node:process'
import { Command } from 'commander'
import { logger } from '../../core/logger.ts'
import type { ModelApi, ModelEntry, ProviderEntry } from '../../core/model-registry.ts'
import { type CatalogProvider, PROVIDER_CATALOG } from '../../core/provider-catalog.ts'
import { ensureDaemonRunning } from '../launch/daemon-autostart.ts'
import { oauthLogin } from '../oauth/login.ts'
import { daemonFetch } from '../util/daemon-client.ts'
import {
  confirmYesNo,
  promptChoice,
  promptMultiChoice,
  promptSecret,
  promptText,
} from '../util/prompt.ts'
import { modelRm, modelSet, providerCmd, secretCmd } from './route.ts'

type ApiCompat = 'openai-chat' | 'openai-responses' | 'anthropic'

const API_TO_MODEL_API: Record<ApiCompat, ModelApi> = {
  'openai-chat': 'openai-chat',
  'openai-responses': 'openai-responses',
  anthropic: 'anthropic-messages',
}

// ── live probe ─────────────────────────────────────────────────────

type ProbeResult = { ok: boolean; status?: number; error?: string }

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/** Minimal reachability + auth probe. Treats a response that isn't 401/403 and
 *  isn't a 5xx as "reachable and authorized" — a 400 from a slightly-off body
 *  still proves the key and host work. */
async function probeOnce(
  api: ApiCompat,
  baseUrl: string,
  key: string,
  model: string,
): Promise<ProbeResult> {
  let url: string
  let headers: Record<string, string> = { 'content-type': 'application/json' }
  let body: unknown
  if (api === 'anthropic') {
    url = joinUrl(baseUrl, baseUrl.endsWith('/v1') ? '/messages' : '/v1/messages')
    headers = { ...headers, 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] }
  } else if (api === 'openai-responses') {
    url = joinUrl(baseUrl, '/responses')
    headers = { ...headers, authorization: `Bearer ${key}` }
    body = { model, input: 'Hi', max_output_tokens: 16 }
  } else {
    url = joinUrl(baseUrl, '/chat/completions')
    headers = { ...headers, authorization: `Bearer ${key}` }
    body = { model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 16, stream: false }
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: 'auth rejected (check the API key)' }
    }
    if (res.status >= 500) {
      return { ok: false, status: res.status, error: `upstream error ${res.status}` }
    }
    return { ok: true, status: res.status }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Probe, auto-detecting the API when `api` is 'auto'. Returns the working
 *  compatibility on success. */
async function probe(
  api: ApiCompat | 'auto',
  baseUrl: string,
  key: string,
  model: string,
): Promise<{ result: ProbeResult; api?: ApiCompat }> {
  const order: ApiCompat[] =
    api === 'auto' ? ['openai-chat', 'openai-responses', 'anthropic'] : [api]
  let last: ProbeResult = { ok: false, error: 'no api tried' }
  for (const a of order) {
    const r = await probeOnce(a, baseUrl, key, model)
    if (r.ok) return { result: r, api: a }
    last = r
  }
  return { result: last }
}

// ── wizard ─────────────────────────────────────────────────────────

function providerIdFromUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.replace(/^www\./, '')
    return (
      host
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'custom'
    )
  } catch {
    return 'custom'
  }
}

/** One model staged for registration. Catalog models carry their known
 *  metadata; hand-typed ids default to text-only (the user can flip vision +
 *  context later via `afw route model` or the dashboard). */
type PendingModel = {
  id: string
  label?: string
  vision: boolean
  contextWindow?: number
  maxTokens?: number
}

type PendingProvider = {
  baseUrl: string
  api: ApiCompat | 'auto'
  key: string
  providerId: string
  label?: string
  models: PendingModel[]
}

const CUSTOM_PROVIDER_LABEL = 'Custom — enter a base URL manually'

/** Run the interactive provider wizard once. Returns the registered provider
 *  id and its model ids on success, or null when the user skipped it. Exported
 *  so the first-run onboarding flow can reuse the exact same prompts + probe.
 *
 *  Starts from a curated catalog of well-known providers (base URL + wire
 *  format + known models pre-filled) so the common case is a couple of menu
 *  picks; "Custom" drops to the manual base-URL flow for anything not listed. */
export async function addOneProvider(): Promise<{ providerId: string; modelIds: string[] } | null> {
  // Non-interactive runs can't pick from a menu — keep the old manual flow,
  // which returns null on the empty base-URL prompt so scripts never block.
  if (!process.stdin.isTTY) return addCustomProvider()

  const labels = [...PROVIDER_CATALOG.map((p) => p.label), CUSTOM_PROVIDER_LABEL]
  const choice = await promptChoice('Which model provider?', labels)
  if (choice === CUSTOM_PROVIDER_LABEL) return addCustomProvider()
  const preset = PROVIDER_CATALOG.find((p) => p.label === choice)
  return preset ? addCatalogProvider(preset) : addCustomProvider()
}

/** Catalog path: provider host + wire format are known, so we only ask which
 *  models to enable (multi-select from the known list, plus any extra ids) and
 *  for the API key. */
async function addCatalogProvider(
  preset: CatalogProvider,
): Promise<{ providerId: string; modelIds: string[] } | null> {
  logger.print(`\n${preset.label} — ${preset.baseUrl}`)
  const models: PendingModel[] = []

  if (preset.models.length > 0) {
    const labels = preset.models.map((m) => `${m.label}  (${m.id})`)
    const chosen = await promptMultiChoice('Select models to enable', labels)
    for (const lbl of chosen) {
      const m = preset.models[labels.indexOf(lbl)]
      if (m) {
        models.push({
          id: m.id,
          label: m.label,
          vision: m.vision === true,
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
        })
      }
    }
  }

  // Always allow adding ids not in the catalog — and it's the only way to add a
  // model for catalog entries (like OpenRouter) that pin no preset models.
  for (;;) {
    const id = await promptText(
      models.length === 0 ? 'Model id' : 'Add another model id (blank to finish)',
    )
    if (!id) break
    models.push({ id, vision: false })
  }
  if (models.length === 0) {
    logger.print('  (no models selected — skipping)')
    return null
  }

  // Offer an OAuth subscription login where the provider supports it. afw runs
  // its own login and stores its own token — it never reads the agent's creds.
  if (preset.oauthKey) {
    const apiKeyLabel = 'API key'
    const oauthLabel = 'Log in with your subscription (OAuth — afw stores its own token)'
    const method = await promptChoice(`How should afw authenticate to ${preset.label}?`, [
      oauthLabel,
      apiKeyLabel,
    ] as const)
    if (method === oauthLabel) return registerOAuthProvider(preset, models)
  }

  const key = await promptSecret(
    `API key${preset.apiKeyUrl ? ` — get one at ${preset.apiKeyUrl}` : ''} (leave blank for none): `,
  )
  const providerId = await promptText('Provider id', preset.id)
  return finalizeProvider({
    baseUrl: preset.baseUrl,
    api: preset.api,
    key,
    providerId,
    label: preset.label,
    models,
  })
}

/** OAuth path: run afw's own subscription login, then register the provider
 *  with `agent-oauth` auth (the token is resolved + refreshed from afw's own
 *  store at request time) plus the selected models. */
async function registerOAuthProvider(
  preset: CatalogProvider,
  models: PendingModel[],
): Promise<{ providerId: string; modelIds: string[] } | null> {
  const def = await oauthLogin(preset.oauthKey as 'anthropic' | 'openai')
  if (!def) {
    logger.print('  (login not completed — skipping this provider)')
    return null
  }
  const providerId = await promptText('Provider id', preset.id)
  await daemonFetch('POST', '/api/routing/provider', {
    id: providerId,
    name: preset.label,
    baseUrl: def.register.baseUrl,
    api: def.register.api,
    authKind: 'agent-oauth',
    agent: def.register.agent,
  })
  for (const m of models) {
    await daemonFetch('POST', '/api/routing/model', {
      id: m.id,
      providerId,
      ...(m.label ? { label: m.label } : {}),
      input: m.vision ? ['text', 'image'] : ['text'],
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
    })
  }
  logger.print(`✓ provider ${providerId} + ${models.length} model(s) registered (OAuth subscription)`)
  return { providerId, modelIds: models.map((m) => m.id) }
}

/** Manual path: ask for everything (base URL, wire format, models, vision). */
async function addCustomProvider(): Promise<{ providerId: string; modelIds: string[] } | null> {
  const baseUrl = await promptText('Provider base URL (e.g. https://api.openai.com/v1)')
  if (!baseUrl) {
    logger.print('  (no base URL — skipping)')
    return null
  }

  const apiChoice = await promptChoice('API compatibility', [
    'auto',
    'openai-chat',
    'openai-responses',
    'anthropic',
  ] as const)

  const key = await promptSecret('API key (leave blank for none): ')

  const ids: string[] = []
  for (;;) {
    const id = await promptText(ids.length === 0 ? 'Model id' : 'Another model id (blank to finish)')
    if (!id) break
    ids.push(id)
    if (!process.stdin.isTTY) break
  }
  if (ids.length === 0) {
    logger.print('  (no models — skipping)')
    return null
  }

  const vision = await confirmYesNo('Do these models accept image input?', false)
  const providerId = await promptText('Provider id', providerIdFromUrl(baseUrl))
  return finalizeProvider({
    baseUrl,
    api: apiChoice,
    key,
    providerId,
    models: ids.map((id) => ({ id, vision })),
  })
}

/** Shared tail of both paths: validate with a live probe (best-effort retry
 *  loop), then register the provider + its models via the daemon. */
async function finalizeProvider(
  p: PendingProvider,
): Promise<{ providerId: string; modelIds: string[] } | null> {
  let baseUrl = p.baseUrl
  let key = p.key
  const apiChoice = p.api

  let resolvedApi: ApiCompat | undefined
  for (;;) {
    logger.print(`  probing ${baseUrl} …`)
    const { result, api } = await probe(apiChoice, baseUrl, key, p.models[0]!.id)
    if (result.ok && (api ?? (apiChoice !== 'auto' ? apiChoice : undefined))) {
      resolvedApi = api ?? (apiChoice as ApiCompat)
      logger.print(`  ✓ reachable (${resolvedApi}, HTTP ${result.status})`)
      break
    }
    logger.print(`  ✗ probe failed: ${result.error ?? 'unknown'}`)
    if (!process.stdin.isTTY) {
      // Non-interactive: don't loop. Fall back to the explicit choice if any.
      if (apiChoice !== 'auto') resolvedApi = apiChoice
      break
    }
    const retry = await promptChoice('Retry?', [
      'edit base URL',
      'edit model id',
      'edit API key',
      'register anyway',
      'skip this provider',
    ] as const)
    if (retry === 'skip this provider') return null
    if (retry === 'register anyway') {
      resolvedApi = apiChoice === 'auto' ? 'openai-chat' : apiChoice
      break
    }
    if (retry === 'edit base URL')
      baseUrl = (await promptText('Provider base URL', baseUrl)) || baseUrl
    if (retry === 'edit model id')
      p.models[0]!.id = (await promptText('Model id', p.models[0]!.id)) || p.models[0]!.id
    if (retry === 'edit API key') key = await promptSecret('API key (leave blank for none): ')
  }

  const modelApi = API_TO_MODEL_API[resolvedApi ?? 'openai-chat']
  const authKind = key ? (resolvedApi === 'anthropic' ? 'api-key' : 'bearer') : 'passthrough'

  await daemonFetch('POST', '/api/routing/provider', {
    id: p.providerId,
    ...(p.label ? { name: p.label } : {}),
    baseUrl,
    api: modelApi,
    authKind,
    ...(authKind === 'api-key' ? { authHeader: 'x-api-key' } : {}),
    ...(key ? { apiKey: key } : {}),
  })
  for (const m of p.models) {
    await daemonFetch('POST', '/api/routing/model', {
      id: m.id,
      providerId: p.providerId,
      ...(m.label ? { label: m.label } : {}),
      input: m.vision ? ['text', 'image'] : ['text'],
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
    })
  }
  logger.print(`✓ provider ${p.providerId} + ${p.models.length} model(s) registered`)
  return { providerId: p.providerId, modelIds: p.models.map((m) => m.id) }
}

const addCmd = new Command('add')
  .description('Interactively add one or more model providers (validated with a live probe).')
  .action(async () => {
    try {
      await ensureDaemonRunning()
      let added = 0
      for (;;) {
        if (await addOneProvider()) added++
        if (!process.stdin.isTTY) break
        if (!(await confirmYesNo('Add another provider?', false))) break
      }
      logger.print(added > 0 ? `\nDone — ${added} provider(s) added.` : '\nNothing added.')
    } catch (e) {
      logger.print(`error: ${(e as Error).message}`)
      process.exitCode = 1
    }
  })

const listCmd = new Command('list')
  .description('List registered providers and models.')
  .action(async () => {
    try {
      const reg = await daemonFetch<{
        providers: ProviderEntry[]
        models: ModelEntry[]
        combos?: { id: string; label?: string; panel?: unknown[] }[]
      }>('GET', '/api/routing/registry')
      logger.print('Providers:')
      for (const p of reg.providers) {
        const path = `path=${p.generationPath ?? 'versioned'}`
        const effort = p.reasoningEffort ? ` effort=${p.reasoningEffort}` : ''
        logger.print(`  ${p.id.padEnd(20)} ${p.api.padEnd(18)} ${path}${effort}  ${p.baseUrl}`)
      }
      logger.print('Models:')
      for (const m of reg.models) {
        const effort = m.reasoningEffort ? `  effort=${m.reasoningEffort}` : ''
        logger.print(
          `  ${m.id.padEnd(28)} ${m.providerId}${m.input.includes('image') ? '  (vision)' : ''}${effort}`,
        )
      }
      if (reg.combos && reg.combos.length > 0) {
        logger.print('Fusion models:')
        for (const c of reg.combos) {
          const n = c.panel?.length ?? 0
          logger.print(
            `  ${(c.label ?? c.id).padEnd(28)} ${c.id}  (${n}-model panel — route with --fusion ${c.id})`,
          )
        }
      }
    } catch (e) {
      logger.print(`error: ${(e as Error).message}`)
      process.exitCode = 1
    }
  })

export const modelCommand = new Command('model')
  .description('Manage the providers, models, and API-key secrets afw can route to.')
  .addCommand(addCmd)
  .addCommand(listCmd)
  .addCommand(modelRm)
  .addCommand(modelSet)
  .addCommand(providerCmd)
  .addCommand(secretCmd)
