// Best-effort advisory file lock around an OAuth refresh. The in-memory
// single-flight in each agent module is the real dedup within this process;
// this lock only narrows the cross-process window where two agentfw daemons
// (or a daemon racing the owning agent) could each rotate the refresh token
// and invalidate the other. It never throws and never blocks forever: a
// stale lock is stolen and an un-acquirable lock is proceeded past.

import { open, stat, unlink } from 'node:fs/promises'

const STALE_MS = 30_000
const MAX_WAIT_MS = 5_000
const POLL_MS = 100

export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const held = await acquire(path)
  try {
    return await fn()
  } finally {
    if (held) await unlink(path).catch(() => {})
  }
}

async function acquire(path: string): Promise<boolean> {
  const deadline = Date.now() + MAX_WAIT_MS
  for (;;) {
    try {
      const fh = await open(path, 'wx')
      await fh.close()
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false
      try {
        const st = await stat(path)
        if (Date.now() - st.mtimeMs > STALE_MS) {
          await unlink(path).catch(() => {})
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) return false
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
  }
}
