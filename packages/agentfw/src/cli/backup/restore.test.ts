import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newBackupId } from '../../core/ids.ts'
import { type BackupEntry, type ChangeRecord, MANIFEST_VERSION } from '../../core/manifest.ts'
import { revertEntry } from './restore.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentfw-restore-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function entry(
  partial: Partial<BackupEntry> & Pick<BackupEntry, 'originalPath' | 'changes'>,
): BackupEntry {
  return {
    id: newBackupId(),
    agent: 'claude-code',
    backupPath: join(dir, 'backup.snapshot'),
    originalSha256: 'sha-orig',
    rewrittenSha256: 'sha-rewritten',
    wiredAt: Date.now(),
    manifestVersion: MANIFEST_VERSION,
    ...partial,
  }
}

describe('revertEntry — reverse-replay', () => {
  it('restores a set to its original value', async () => {
    const file = join(dir, 'settings.json')
    await writeFile(
      file,
      '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "http://localhost:9877/wire/claude-code/anthropic"\n  }\n}\n',
    )
    const changes: ChangeRecord[] = [
      {
        type: 'set',
        jsonPointer: '/env/ANTHROPIC_BASE_URL',
        from: 'https://api.anthropic.com',
        to: 'http://localhost:9877/wire/claude-code/anthropic',
      },
    ]
    const r = await revertEntry(entry({ originalPath: file, changes }))
    expect(r.mode).toBe('replay')
    expect(r.reverted).toBe(1)
    expect(r.skipped).toEqual([])
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    })
  })

  it('fromAbsent deletes the key; create-path removes the emptied parent', async () => {
    const file = join(dir, 'settings.json')
    await writeFile(
      file,
      '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "http://localhost:9877/wire/claude-code/anthropic"\n  }\n}\n',
    )
    const changes: ChangeRecord[] = [
      { type: 'create-path', jsonPointer: '/env' },
      {
        type: 'set',
        jsonPointer: '/env/ANTHROPIC_BASE_URL',
        fromAbsent: true,
        to: 'http://localhost:9877/wire/claude-code/anthropic',
      },
    ]
    const r = await revertEntry(entry({ originalPath: file, changes }))
    expect(r.mode).toBe('replay')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({})
  })

  it('skips a pointer the agent changed after wiring and reports it', async () => {
    const file = join(dir, 'settings.json')
    await writeFile(
      file,
      '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://user-changed.example"\n  }\n}\n',
    )
    const changes: ChangeRecord[] = [
      {
        type: 'set',
        jsonPointer: '/env/ANTHROPIC_BASE_URL',
        from: 'https://api.anthropic.com',
        to: 'http://localhost:9877/wire/claude-code/anthropic',
      },
    ]
    const r = await revertEntry(entry({ originalPath: file, changes }))
    expect(r.reverted).toBe(0)
    expect(r.skipped).toEqual([
      { pointer: '/env/ANTHROPIC_BASE_URL', reason: 'changed after wiring' },
    ])
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      env: { ANTHROPIC_BASE_URL: 'https://user-changed.example' },
    })
  })

  it('reverse-replays a wrap-mcp to the pre-wrap command', async () => {
    const file = join(dir, 'claude.json')
    await writeFile(
      file,
      `${JSON.stringify(
        {
          mcpServers: {
            fs: {
              command: 'agentfw-tap',
              args: ['claude-code', 'fs', '--', 'node', 'server.js'],
            },
          },
        },
        null,
        2,
      )}\n`,
    )
    const changes: ChangeRecord[] = [
      {
        type: 'wrap-mcp',
        name: 'fs',
        from: { command: 'node', args: ['server.js'], type: 'stdio' },
        to: {
          command: 'agentfw-tap',
          args: ['claude-code', 'fs', '--', 'node', 'server.js'],
          type: 'stdio',
        },
      },
    ]
    const r = await revertEntry(entry({ originalPath: file, changes }))
    expect(r.reverted).toBe(1)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      mcpServers: { fs: { command: 'node', args: ['server.js'] } },
    })
  })

  it('restores an http/sse MCP server url repointed at the relay', async () => {
    const file = join(dir, 'claude.json')
    await writeFile(
      file,
      `${JSON.stringify(
        {
          mcpServers: {
            remote: { type: 'sse', url: 'http://localhost:9877/wire-mcp/claude-code/remote' },
          },
        },
        null,
        2,
      )}\n`,
    )
    const changes: ChangeRecord[] = [
      {
        type: 'set',
        jsonPointer: '/mcpServers/remote/url',
        from: 'https://remote.example.com/sse',
        to: 'http://localhost:9877/wire-mcp/claude-code/remote',
      },
    ]
    const r = await revertEntry(entry({ originalPath: file, changes }))
    expect(r.reverted).toBe(1)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      mcpServers: { remote: { type: 'sse', url: 'https://remote.example.com/sse' } },
    })
  })

  it('reverts codex model_provider + section, leaving agent-edited [projects] intact', async () => {
    const file = join(dir, 'config.toml')
    await writeFile(
      file,
      'model = "gpt-5"\n' +
        'model_provider = "agentfw"\n\n' +
        '[model_providers.agentfw]\n' +
        'name = "agentfw (OpenAI)"\n' +
        'base_url = "http://localhost:9877/wire/codex/openai"\n\n' +
        '[projects]\n' +
        '"/Users/tom/x" = { trust_level = "trusted" }\n',
    )
    const changes: ChangeRecord[] = [
      { type: 'set', jsonPointer: '/model_provider', from: 'openai', to: 'agentfw' },
      { type: 'create-path', jsonPointer: '/model_providers/agentfw' },
    ]
    const r = await revertEntry(entry({ agent: 'codex', originalPath: file, changes }))
    expect(r.mode).toBe('replay')
    const out = await readFile(file, 'utf8')
    expect(out).toContain('model_provider = "openai"')
    expect(out).not.toContain('[model_providers.agentfw]')
    expect(out).toContain('[projects]')
    expect(out).toContain('"/Users/tom/x" = { trust_level = "trusted" }')
  })

  it('reports env-inject reverts as unsupported and skips them', async () => {
    const file = join(dir, 'settings.json')
    await writeFile(file, '{ "a": 1 }\n')
    const changes: ChangeRecord[] = [{ type: 'env-inject', key: 'FOO', to: 'bar' }]
    const r = await revertEntry(entry({ originalPath: file, changes }))
    expect(r.skipped).toEqual([{ pointer: 'env:FOO', reason: 'env-inject revert unsupported' }])
  })

  // Regression: the openclaw recovery wire seeds an empty `models: []`
  // alongside the new provider so OpenClaw's schema validates. The seed is
  // recorded as a `create-path` so unwire can delete-if-empty it, letting
  // the parent provider's `create-path` collapse the whole section.
  it('create-path on an empty array removes it, then collapses the parent', async () => {
    const file = join(dir, 'openclaw.json')
    await writeFile(
      file,
      `${JSON.stringify(
        {
          models: {
            providers: {
              vllm: { baseUrl: 'http://localhost:9877/wire/openclaw/vllm', models: [] },
            },
          },
        },
        null,
        2,
      )}\n`,
    )
    const changes: ChangeRecord[] = [
      { type: 'create-path', jsonPointer: '/models/providers/vllm' },
      { type: 'create-path', jsonPointer: '/models/providers/vllm/models' },
      {
        type: 'set',
        jsonPointer: '/models/providers/vllm/baseUrl',
        fromAbsent: true,
        to: 'http://localhost:9877/wire/openclaw/vllm',
      },
    ]
    const r = await revertEntry(entry({ agent: 'openclaw', originalPath: file, changes }))
    expect(r.mode).toBe('replay')
    // Whole vllm provider should be gone — no stranded {models:[]} left.
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      models: { providers: {} },
    })
  })

  it('create-path on an array the user populated since wiring leaves it intact', async () => {
    const file = join(dir, 'openclaw.json')
    await writeFile(
      file,
      `${JSON.stringify(
        {
          models: {
            providers: {
              vllm: {
                baseUrl: 'http://localhost:9877/wire/openclaw/vllm',
                models: [{ id: 'Xiangxin-2XL-Chat', name: 'Xiangxin' }],
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    )
    const changes: ChangeRecord[] = [
      { type: 'create-path', jsonPointer: '/models/providers/vllm' },
      { type: 'create-path', jsonPointer: '/models/providers/vllm/models' },
      {
        type: 'set',
        jsonPointer: '/models/providers/vllm/baseUrl',
        fromAbsent: true,
        to: 'http://localhost:9877/wire/openclaw/vllm',
      },
    ]
    const r = await revertEntry(entry({ agent: 'openclaw', originalPath: file, changes }))
    expect(r.mode).toBe('replay')
    // baseUrl removed, but the user-added model entry survives — and because
    // the provider is no longer empty, the parent create-path leaves it.
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      models: {
        providers: {
          vllm: { models: [{ id: 'Xiangxin-2XL-Chat', name: 'Xiangxin' }] },
        },
      },
    })
  })
})

describe('revertEntry — fallbacks', () => {
  it('falls back to whole-file restore for a v1 (legacy) entry', async () => {
    const file = join(dir, 'settings.json')
    const backup = join(dir, 'snapshot.json')
    await writeFile(file, '{"current":"rewritten"}\n')
    await writeFile(backup, '{"original":"snapshot"}\n')
    const r = await revertEntry(
      entry({
        originalPath: file,
        backupPath: backup,
        changes: [{ type: 'set', jsonPointer: '/x', from: 'a', to: 'b' }],
        manifestVersion: undefined,
      }),
    )
    expect(r.mode).toBe('whole-file')
    expect(await readFile(file, 'utf8')).toBe('{"original":"snapshot"}\n')
  })

  it('--force does a whole-file restore even for a v2 entry', async () => {
    const file = join(dir, 'settings.json')
    const backup = join(dir, 'snapshot.json')
    await writeFile(file, '{"env":{"ANTHROPIC_BASE_URL":"http://localhost:9877/wire/x"}}\n')
    await writeFile(backup, '{"original":"snapshot"}\n')
    const changes: ChangeRecord[] = [
      {
        type: 'set',
        jsonPointer: '/env/ANTHROPIC_BASE_URL',
        from: 'https://api.anthropic.com',
        to: 'http://localhost:9877/wire/x',
      },
    ]
    const r = await revertEntry(entry({ originalPath: file, backupPath: backup, changes }), {
      force: true,
    })
    expect(r.mode).toBe('whole-file')
    expect(await readFile(file, 'utf8')).toBe('{"original":"snapshot"}\n')
  })

  it('reports noop when the original file no longer exists', async () => {
    const r = await revertEntry(
      entry({
        originalPath: join(dir, 'gone.json'),
        changes: [{ type: 'set', jsonPointer: '/x', from: 'a', to: 'b' }],
      }),
    )
    expect(r.mode).toBe('noop')
    expect(r.skipped[0]?.reason).toBe('original file no longer exists')
  })
})
