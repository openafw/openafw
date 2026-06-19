import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DecoderKind } from '../../core/routes.ts'
import { decoderForClaudeCodeBaseUrl } from './claude-code.ts'
import {
  buildWireSecrets,
  captureClaudeCodeCredentials,
  captureCodexCredentials,
  captureHermesCredentials,
  captureOpenClawCredentials,
  parseDotEnv,
  resolveSecretInput,
} from './credentials.ts'
import type { PlannedEndpoint } from './types.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'afw-creds-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function ep(
  modelId: string,
  configLocation: string,
  decoder: DecoderKind = 'openai-chat',
  active = true,
): PlannedEndpoint {
  return {
    modelId,
    originalBaseUrl: 'https://up.example/v1',
    afwBaseUrl: 'http://localhost:9877/wire/x/y',
    upstream: 'https://up.example/v1',
    decoder,
    configLocation,
    filePath: join(dir, 'cfg'),
    active,
  }
}

describe('resolveSecretInput', () => {
  it('returns a plain string literal unchanged', () => {
    expect(resolveSecretInput('sk-literal', {})).toBe('sk-literal')
  })

  it('substitutes a ${VAR} template from env', () => {
    expect(resolveSecretInput('${KEY}', { KEY: 'sk-1' })).toBe('sk-1')
    expect(resolveSecretInput('Bearer ${KEY}', { KEY: 'tok' })).toBe('Bearer tok')
  })

  it('returns undefined when a ${VAR} cannot be resolved', () => {
    expect(resolveSecretInput('${MISSING}', {})).toBeUndefined()
  })

  it('resolves a { source: env, id } SecretRef', () => {
    expect(resolveSecretInput({ source: 'env', id: 'KEY' }, { KEY: 'sk-2' })).toBe('sk-2')
    expect(resolveSecretInput({ source: 'env', id: 'NOPE' }, {})).toBeUndefined()
  })

  it('resolves a bare env-var-name string when it names an env key', () => {
    expect(resolveSecretInput('VLLM_API_KEY', { VLLM_API_KEY: 'sk-3' })).toBe('sk-3')
  })

  it('treats a bare string not in env as a literal', () => {
    expect(resolveSecretInput('VLLM_API_KEY', {})).toBe('VLLM_API_KEY')
  })

  it('returns undefined for empty or non-string/non-ref input', () => {
    expect(resolveSecretInput('', {})).toBeUndefined()
    expect(resolveSecretInput(undefined, {})).toBeUndefined()
    expect(resolveSecretInput(42, {})).toBeUndefined()
  })
})

describe('parseDotEnv', () => {
  it('parses assignments, export prefixes, quotes; skips comments/blanks', () => {
    const env = parseDotEnv(
      ['# a comment', '', 'PLAIN=value', 'export EXPORTED=exp', 'DQ="double"', "SQ='single'"].join(
        '\n',
      ),
    )
    expect(env).toEqual({
      PLAIN: 'value',
      EXPORTED: 'exp',
      DQ: 'double',
      SQ: 'single',
    })
  })
})

describe('buildWireSecrets', () => {
  it('emits one ref per active endpoint with a captured credential', () => {
    const captured = new Map([
      ['openai', { auth: { kind: 'bearer' as const }, value: 'sk-active' }],
      ['groq', { auth: { kind: 'bearer' as const }, value: 'sk-inactive' }],
    ])
    const secrets = buildWireSecrets(
      'hermes',
      [
        ep('openai', '/model/base_url'),
        ep('groq', '/custom_providers/groq/base_url', 'openai-chat', false),
      ],
      captured,
    )
    expect(secrets).toEqual([{ ref: 'provider:hermes/openai', value: 'sk-active' }])
  })
})

describe('captureClaudeCodeCredentials', () => {
  it('captures ANTHROPIC_AUTH_TOKEN as a bearer credential', async () => {
    const settings = join(dir, 'settings.json')
    await writeFile(settings, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'tok-1' } }))
    const out = await captureClaudeCodeCredentials({ settingsPath: settings })
    expect(out.get('anthropic')).toEqual({ auth: { kind: 'bearer' }, value: 'tok-1' })
  })

  it('captures ANTHROPIC_API_KEY as an x-api-key credential', async () => {
    const settings = join(dir, 'settings.json')
    await writeFile(settings, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant' } }))
    const out = await captureClaudeCodeCredentials({ settingsPath: settings })
    expect(out.get('anthropic')).toEqual({
      auth: { kind: 'api-key', header: 'x-api-key' },
      value: 'sk-ant',
    })
  })

  it('falls back to .claude.json primaryApiKey', async () => {
    const settings = join(dir, 'settings.json')
    const legacy = join(dir, 'claude.json')
    await writeFile(settings, JSON.stringify({ env: {} }))
    await writeFile(legacy, JSON.stringify({ primaryApiKey: 'sk-legacy' }))
    const out = await captureClaudeCodeCredentials({
      settingsPath: settings,
      legacyPath: legacy,
    })
    expect(out.get('anthropic')?.value).toBe('sk-legacy')
  })

  it('captures nothing when no static key and Claude.ai is not logged in', async () => {
    const settings = join(dir, 'settings.json')
    await writeFile(settings, JSON.stringify({ env: {} }))
    const out = await captureClaudeCodeCredentials({
      settingsPath: settings,
      legacyPath: join(dir, 'absent.json'),
      oauthProbe: async () => false,
    })
    expect(out.size).toBe(0)
  })

  it('captures subscription OAuth when no static key but Claude.ai is logged in', async () => {
    const settings = join(dir, 'settings.json')
    await writeFile(settings, JSON.stringify({ env: {} }))
    const out = await captureClaudeCodeCredentials({
      settingsPath: settings,
      legacyPath: join(dir, 'absent.json'),
      oauthProbe: async () => true,
    })
    expect(out.get('anthropic')).toEqual({
      auth: { kind: 'agent-oauth', agent: 'claude-code' },
    })
  })
})

describe('decoderForClaudeCodeBaseUrl', () => {
  it('always uses the Anthropic Messages decoder for Claude Code base URLs', () => {
    expect(decoderForClaudeCodeBaseUrl('https://api.anthropic.com')).toBe('anthropic')
    expect(decoderForClaudeCodeBaseUrl('https://cc-vibe.com')).toBe('anthropic')
    expect(decoderForClaudeCodeBaseUrl('https://relay.example/v1')).toBe('anthropic')
  })
})

describe('captureCodexCredentials', () => {
  it('captures OPENAI_API_KEY as a bearer credential', async () => {
    const auth = join(dir, 'auth.json')
    await writeFile(auth, JSON.stringify({ OPENAI_API_KEY: 'sk-oai', auth_mode: 'apikey' }))
    const out = await captureCodexCredentials({ authPath: auth })
    expect(out.get('openai')).toEqual({ auth: { kind: 'bearer' }, value: 'sk-oai' })
  })

  it('captures ChatGPT-subscription mode as an agent-oauth credential', async () => {
    const auth = join(dir, 'auth.json')
    await writeFile(
      auth,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'x', refresh_token: 'y' },
      }),
    )
    const out = await captureCodexCredentials({ authPath: auth })
    expect(out.get('openai')).toEqual({ auth: { kind: 'agent-oauth', agent: 'codex' } })
  })
})

describe('captureHermesCredentials', () => {
  it('resolves model + custom_providers api_key against the hermes .env', async () => {
    const config = join(dir, 'config.yaml')
    const env = join(dir, '.env')
    await writeFile(
      config,
      [
        'model:',
        '  base_url: https://api.openai.com/v1',
        '  provider: default',
        '  api_key: ${OPENAI_KEY}',
        'custom_providers:',
        '  - name: groq',
        '    base_url: https://api.groq.com/openai/v1',
        '    api_key: gsk-literal',
        '  - name: anthropic',
        '    base_url: https://api.anthropic.com',
        '    api_key: sk-ant-direct',
      ].join('\n'),
    )
    await writeFile(env, 'OPENAI_KEY=sk-from-env\n')
    const out = await captureHermesCredentials(
      [
        ep('default', '/model/base_url', 'openai-chat'),
        ep('groq', '/custom_providers/groq/base_url', 'openai-chat'),
        ep('anthropic', '/custom_providers/anthropic/base_url', 'anthropic'),
      ],
      { configPath: config, envPath: env },
    )
    expect(out.get('default')).toEqual({ auth: { kind: 'bearer' }, value: 'sk-from-env' })
    expect(out.get('groq')).toEqual({ auth: { kind: 'bearer' }, value: 'gsk-literal' })
    expect(out.get('anthropic')).toEqual({
      auth: { kind: 'api-key', header: 'x-api-key' },
      value: 'sk-ant-direct',
    })
  })
})

describe('captureOpenClawCredentials', () => {
  it('resolves apiKey as a bare env name and api_key as a literal', async () => {
    const config = join(dir, 'openclaw.json')
    const env = join(dir, '.env')
    await writeFile(
      config,
      JSON.stringify({
        models: {
          providers: {
            vllm: { baseUrl: 'http://localhost:8000/v1', apiKey: 'VLLM_API_KEY' },
            oai: { baseUrl: 'https://api.openai.com/v1', api_key: 'sk-direct' },
          },
        },
      }),
    )
    await writeFile(env, 'VLLM_API_KEY=sk-vllm\n')
    const out = await captureOpenClawCredentials(
      [ep('vllm', '/models/providers/vllm/apiKey'), ep('oai', '/models/providers/oai/api_key')],
      { configPath: config, envPath: env },
    )
    expect(out.get('vllm')?.value).toBe('sk-vllm')
    expect(out.get('oai')?.value).toBe('sk-direct')
  })
})
