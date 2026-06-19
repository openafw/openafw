// `afw model add` — interactive, multi-provider model onboarding. Prompts
// for one or more providers + their models, validates each with a live probe,
// and registers them via the daemon's /api/routing surface. Modeled on
// references/openclaw's onboard flow, generalized to add many providers in one
// run. The flag-based `afw route provider/model add` stays for scripting.

import process from 'node:process'
import { Command } from 'commander'
import { logger } from '../../core/logger.ts'
import type { ModelApi, ModelEntry, ProviderEntry } from '../../core/model-registry.ts'
import { ensureDaemonRunning } from '../launch/daemon-autostart.ts'
import { daemonFetch } from '../util/daemon-client.ts'
import { confirmYesNo, promptChoice, promptSecret, promptText } from '../util/prompt.ts'
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

/** Run the interactive provider wizard once. Returns the registered provider
 *  id and its model ids on success, or null when the user skipped it. Exported
 *  so the first-run onboarding flow can reuse the exact same prompts + probe. */
export async function addOneProvider(): Promise<{ providerId: string; modelIds: string[] } | null> {
  let baseUrl = await promptText('Provider base URL (e.g. https://api.openai.com/v1)')
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

  let key = await promptSecret('API key (leave blank for none): ')

  const modelIds: string[] = []
  for (;;) {
    const id = await promptText(
      modelIds.length === 0 ? 'Model id' : 'Another model id (blank to finish)',
    )
    if (!id) break
    modelIds.push(id)
    if (!process.stdin.isTTY) break
  }
  if (modelIds.length === 0) {
    logger.print('  (no models — skipping)')
    return null
  }

  const vision = await confirmYesNo('Do these models accept image input?', false)
  const providerId = await promptText('Provider id', providerIdFromUrl(baseUrl))

  // Validate with a live probe (best-effort retry loop).
  let resolvedApi: ApiCompat | undefined
  for (;;) {
    logger.print(`  probing ${baseUrl} …`)
    const { result, api } = await probe(apiChoice, baseUrl, key, modelIds[0]!)
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
      modelIds[0] = (await promptText('Model id', modelIds[0])) || modelIds[0]!
    if (retry === 'edit API key') key = await promptSecret('API key (leave blank for none): ')
  }

  const modelApi = API_TO_MODEL_API[resolvedApi ?? 'openai-chat']
  const authKind = key ? (resolvedApi === 'anthropic' ? 'api-key' : 'bearer') : 'passthrough'

  await daemonFetch('POST', '/api/routing/provider', {
    id: providerId,
    baseUrl,
    api: modelApi,
    authKind,
    ...(authKind === 'api-key' ? { authHeader: 'x-api-key' } : {}),
    ...(key ? { apiKey: key } : {}),
  })
  for (const id of modelIds) {
    await daemonFetch('POST', '/api/routing/model', {
      id,
      providerId,
      input: vision ? ['text', 'image'] : ['text'],
    })
  }
  logger.print(`✓ provider ${providerId} + ${modelIds.length} model(s) registered`)
  return { providerId, modelIds }
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
