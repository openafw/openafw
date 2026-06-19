import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// daemonFetch is the only outward call needsOnboarding() makes; stub it so the
// gate can be exercised without a running daemon.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }))
vi.mock('../util/daemon-client.ts', () => ({ daemonFetch: mockFetch }))

// paths.ts captures AFW_HOME at import time → point it at a throwaway dir.
let mod: typeof import('./onboard.ts')
let config: typeof import('../../core/config.ts')
beforeAll(async () => {
  process.env.AFW_HOME = mkdtempSync(join(tmpdir(), 'afw-home-'))
  mod = await import('./onboard.ts')
  config = await import('../../core/config.ts')
})

beforeEach(() => mockFetch.mockReset())

describe('needsOnboarding', () => {
  it('short-circuits to false once onboarded, never touching the daemon', async () => {
    await config.updateConfig({ onboarded: true })
    expect(await mod.needsOnboarding()).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('is true on a fresh install with no models registered', async () => {
    await config.updateConfig({ onboarded: false })
    mockFetch.mockResolvedValue({ providers: [], models: [] })
    expect(await mod.needsOnboarding()).toBe(true)
  })

  it('is false when a model is already registered', async () => {
    await config.updateConfig({ onboarded: false })
    mockFetch.mockResolvedValue({
      providers: [{ id: 'openai' }],
      models: [{ id: 'gpt-4o', providerId: 'openai' }],
    })
    expect(await mod.needsOnboarding()).toBe(false)
  })
})
