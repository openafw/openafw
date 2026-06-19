import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileStore, resolveClaudeToken } from './claude-code.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'afw-oauth-cc-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('resolveClaudeToken', () => {
  it('returns the stored token when it is still fresh', async () => {
    const path = join(dir, 'creds.json')
    await writeFile(
      path,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'fresh-access',
          refreshToken: 'r',
          expiresAt: Date.now() + 60 * 60 * 1000,
        },
      }),
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const t = await resolveClaudeToken(fileStore(path))
    expect(t.token).toBe('fresh-access')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes an expired token and writes the rotated refresh token back', async () => {
    const path = join(dir, 'creds.json')
    await writeFile(
      path,
      JSON.stringify({
        other: 'preserve-me',
        claudeAiOauth: {
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          expiresAt: Date.now() - 1000,
        },
      }),
    )
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      return new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const t = await resolveClaudeToken(fileStore(path))
    expect(t.token).toBe('new-access')

    // refresh request shape
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://platform.claude.com/v1/oauth/token')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    })

    // rotated token written back, unrelated fields preserved
    const written = JSON.parse(await readFile(path, 'utf8'))
    expect(written.claudeAiOauth.accessToken).toBe('new-access')
    expect(written.claudeAiOauth.refreshToken).toBe('rotated-refresh')
    expect(written.other).toBe('preserve-me')
  })

  it('keeps the current refresh token when the response rotates none', async () => {
    const path = join(dir, 'creds.json')
    await writeFile(
      path,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'old',
          refreshToken: 'unchanged-refresh',
          expiresAt: Date.now() - 1000,
        },
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ access_token: 'new' }), { status: 200 })),
    )
    await resolveClaudeToken(fileStore(path))
    const written = JSON.parse(await readFile(path, 'utf8'))
    expect(written.claudeAiOauth.refreshToken).toBe('unchanged-refresh')
  })

  it('throws when the credential store has no usable credentials', async () => {
    await expect(resolveClaudeToken(fileStore(join(dir, 'absent.json')))).rejects.toThrow()
  })
})
