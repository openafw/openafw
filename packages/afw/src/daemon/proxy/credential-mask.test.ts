import { describe, expect, it } from 'vitest'
import { makeRestoreTransform } from './credential-mask.ts'

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
