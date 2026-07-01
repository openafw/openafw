import { describe, expect, it, vi } from 'vitest'
import type { MaskingConfig } from '../../core/masking.ts'

const state = vi.hoisted(
  (): { cfg: MaskingConfig } => ({
    cfg: {
      version: 3 as const,
      providers: {},
      fakes: {},
      custom: [],
    },
  }),
)

vi.mock('../masking/load.ts', () => ({
  getMaskingConfig: () => state.cfg,
}))

import { makeRestoreTransform, maskRequestBody } from './credential-mask.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Feed `chunks` through the restore transform and return the concatenated
 *  output text. */
async function runTransform(restore: Map<string, string>, chunks: string[]): Promise<string> {
  const ts = makeRestoreTransform(restore)
  const writer = ts.writable.getWriter()
  const reader = ts.readable.getReader()
  const out: Uint8Array[] = []
  const pump = (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out.push(value)
    }
  })()
  for (const c of chunks) await writer.write(enc.encode(c))
  await writer.close()
  await pump
  return dec.decode(Buffer.concat(out.map((u) => Buffer.from(u))))
}

describe('makeRestoreTransform', () => {
  it('restores a fake delivered in a single chunk', async () => {
    const restore = new Map([['FAKE_KEY_0000', 'sk-realSecretValue']])
    const out = await runTransform(restore, ['the key is FAKE_KEY_0000 done'])
    expect(out).toBe('the key is sk-realSecretValue done')
  })

  it('restores a fake that straddles a chunk boundary', async () => {
    const restore = new Map([['FAKE_KEY_0000', 'sk-realSecretValue']])
    // Split the fake across two writes.
    const out = await runTransform(restore, ['prefix FAKE_KE', 'Y_0000 suffix'])
    expect(out).toBe('prefix sk-realSecretValue suffix')
  })

  it('restores a fake split one byte at a time', async () => {
    const fake = 'FAKE_KEY_0000'
    const restore = new Map([[fake, 'REAL']])
    const text = `a${fake}b`
    const out = await runTransform(
      restore,
      [...text].map((ch) => ch),
    )
    expect(out).toBe('aREALb')
  })

  it('restores multiple distinct fakes in one stream', async () => {
    const restore = new Map([
      ['FAKE_AAAA', 'realA'],
      ['FAKE_BBBB', 'realB'],
    ])
    const out = await runTransform(restore, ['x FAKE_AAAA y ', 'FAKE_BBBB z'])
    expect(out).toBe('x realA y realB z')
  })

  it('passes through bytes that contain no fake', async () => {
    const restore = new Map([['FAKE_KEY_0000', 'REAL']])
    const out = await runTransform(restore, ['nothing to see ', 'here at all'])
    expect(out).toBe('nothing to see here at all')
  })
})

describe('maskRequestBody scoped rules', () => {
  it('applies a custom rule only to the first matching role message', () => {
    state.cfg = {
      version: 3,
      providers: { test: ['normalize-date'] },
      fakes: {},
      custom: [
        {
          id: 'normalize-date',
          label: 'Normalize date',
          pattern: "Today[^A-Za-z0-9]*s date is (\\d{4})/(\\d{2})/(\\d{2})",
          fake: "Today's date is $1-$2-$3",
          scope: { role: 'user', message: 'first' },
        },
      ],
    }

    const body = enc.encode(
      JSON.stringify({
        messages: [
          { role: 'system', content: "Today’s date is 2026/06/29." },
          { role: 'user', content: "Today’s date is 2026/06/30." },
          { role: 'user', content: "Today’s date is 2026/07/01." },
        ],
      }),
    )
    const masked = maskRequestBody(body.buffer, 'test')
    expect(masked).toBeDefined()
    const parsed = JSON.parse(dec.decode(masked?.body)) as {
      messages: Array<{ content: string }>
    }
    expect(parsed.messages[0]?.content).toBe("Today’s date is 2026/06/29.")
    expect(parsed.messages[1]?.content).toBe("Today's date is 2026-06-30.")
    expect(parsed.messages[2]?.content).toBe("Today’s date is 2026/07/01.")
    expect(masked?.restore.size).toBe(0)
    expect(masked?.edits).toEqual([
      {
        ruleId: 'normalize-date',
        path: '$.messages[1].content',
        role: 'user',
        before: "Today’s date is 2026/06/30.",
        after: "Today's date is 2026-06-30.",
      },
    ])
  })

  it('replaces every regex hit inside the first matching role message', () => {
    state.cfg = {
      version: 3,
      providers: { test: ['normalize-ticket'] },
      fakes: {},
      custom: [
        {
          id: 'normalize-ticket',
          label: 'Normalize ticket',
          pattern: 'TICKET-(\\d+)',
          fake: 'CASE-$1',
          scope: { role: 'user', message: 'first' },
        },
      ],
    }

    const body = enc.encode(
      JSON.stringify({
        messages: [
          { role: 'user', content: 'TICKET-1 then TICKET-2' },
          { role: 'user', content: 'TICKET-3' },
        ],
      }),
    )
    const masked = maskRequestBody(body.buffer, 'test')
    expect(masked).toBeDefined()
    const parsed = JSON.parse(dec.decode(masked?.body)) as {
      messages: Array<{ content: string }>
    }
    expect(parsed.messages[0]?.content).toBe('CASE-1 then CASE-2')
    expect(parsed.messages[1]?.content).toBe('TICKET-3')
    expect(masked?.edits[0]).toMatchObject({
      ruleId: 'normalize-ticket',
      path: '$.messages[0].content',
      role: 'user',
      before: 'TICKET-1 then TICKET-2',
      after: 'CASE-1 then CASE-2',
    })
  })
})
