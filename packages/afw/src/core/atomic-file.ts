import { access, chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'

// why: write to a sibling .tmp then atomically rename into place — a reader,
// or a crash mid-write, never observes a half-written file. `mode` lets a
// secret file be created 0600 without a separate chmod race against readers.
export async function atomicWrite(
  path: string,
  content: string | Uint8Array,
  opts?: { mode?: number },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  await writeFile(tmp, content)
  if (opts?.mode != null) await chmod(tmp, opts.mode)
  await rename(tmp, path)
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
