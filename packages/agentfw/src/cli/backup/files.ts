import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// atomicWrite / fileExists are generic fs primitives — they live in core/ so
// runtime config modules can use them without a cli/ → core/ layering inversion.
export { atomicWrite, fileExists } from '../../core/atomic-file.ts'

export async function sha256OfFile(path: string): Promise<string> {
  const buf = await readFile(path)
  return createHash('sha256').update(buf).digest('hex')
}

export function sha256OfString(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export async function backupCopy(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(src, dest)
}
