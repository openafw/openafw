import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCodexToken } from './codex.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'afw-oauth-codex-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

/** A JWT whose `exp` is `offsetSeconds` from now. */
function jwt(offsetSeconds: number): string {
  const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'none' })}.${seg({
    exp: Math.floor(Date.now() / 1000) + offsetSeconds,
  })}.sig`
}

describe('resolveCodexToken', () => {
  it('returns the stored token when its JWT exp is in the future', async () => {
    const path = join(dir, 'auth.json')
    const access = jwt(3600)
    await writeFile(
      path,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: access, refresh_token: 'r', account_id: 'acct-1' },
      }),
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const t = await resolveCodexToken(path)
    expect(t.token).toBe(access)
    expect(t.accountId).toBe('acct-1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes an expired token and writes the rotated set back', async () => {
    const path = join(dir, 'auth.json')
    await writeFile(
      path,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: jwt(-100),
          refresh_token: 'old-refresh',
          account_id: 'acct-1',
        },
        last_refresh: '2020-01-01T00:00:00Z',
      }),
    )
    const fresh = jwt(3600)
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      return new Response(
        JSON.stringify({
          access_token: fresh,
          refresh_token: 'rotated-refresh',
          id_token: 'new-id-token',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const t = await resolveCodexToken(path)
    expect(t.token).toBe(fresh)
    expect(t.accountId).toBe('acct-1')

    // refresh request shape
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://auth.openai.com/oauth/token')
    expect(JSON.parse(init.body as string)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    })

    // rotated token set written back
    const written = JSON.parse(await readFile(path, 'utf8'))
    expect(written.tokens.access_token).toBe(fresh)
    expect(written.tokens.refresh_token).toBe('rotated-refresh')
    expect(written.tokens.id_token).toBe('new-id-token')
    expect(typeof written.last_refresh).toBe('string')
    expect(written.last_refresh).not.toBe('2020-01-01T00:00:00Z')
  })

  it('throws when auth.json has no usable tokens', async () => {
    await expect(resolveCodexToken(join(dir, 'absent.json'))).rejects.toThrow()
  })
})
