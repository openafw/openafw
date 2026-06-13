import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

// paths.ts captures AGENTFW_HOME at import time, so point it at a throwaway dir
// before importing the module under test.
let mod: typeof import('./per-dir.ts')
beforeAll(async () => {
  process.env.AGENTFW_HOME = mkdtempSync(join(tmpdir(), 'agentfw-home-'))
  mod = await import('./per-dir.ts')
})

describe('per-directory launch memory', () => {
  it('round-trips a config keyed by absolute cwd', async () => {
    await mod.writeLaunchConfig('/proj/alpha', 'claude-code', { model: 'claude-sonnet-4-6' }, 1)
    expect(await mod.readLaunchConfig('/proj/alpha', 'claude-code')).toEqual({
      model: 'claude-sonnet-4-6',
    })
  })

  it('isolates directories from each other', async () => {
    await mod.writeLaunchConfig('/proj/one', 'claude-code', { model: 'a' }, 1)
    expect(await mod.readLaunchConfig('/proj/two', 'claude-code')).toBeUndefined()
  })

  it('keeps multiple agents independent within one directory', async () => {
    await mod.writeLaunchConfig('/proj/multi', 'claude-code', { model: 'm' }, 1)
    await mod.writeLaunchConfig('/proj/multi', 'codex', { mode: 'monitor' }, 1)
    expect(await mod.readLaunchConfig('/proj/multi', 'claude-code')).toEqual({ model: 'm' })
    expect(await mod.readLaunchConfig('/proj/multi', 'codex')).toEqual({ mode: 'monitor' })
  })

  it('overwrites a prior config for the same (dir, agent)', async () => {
    await mod.writeLaunchConfig('/proj/over', 'claude-code', { model: 'old' }, 1)
    await mod.writeLaunchConfig('/proj/over', 'claude-code', { mode: 'raw' }, 2)
    expect(await mod.readLaunchConfig('/proj/over', 'claude-code')).toEqual({ mode: 'raw' })
  })
})
