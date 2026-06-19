import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  type BackupEntry,
  MANIFEST_VERSION,
  type Manifest,
  SUPPORTED_MANIFEST_VERSIONS,
} from '../../core/manifest.ts'
import { paths } from '../../core/paths.ts'
import { atomicWrite, fileExists } from './files.ts'

export async function readManifest(): Promise<Manifest> {
  if (!(await fileExists(paths.backups.manifest))) {
    return { version: MANIFEST_VERSION, entries: [] }
  }
  const text = await readFile(paths.backups.manifest, 'utf8')
  let parsed: Manifest
  try {
    parsed = JSON.parse(text) as Manifest
  } catch (e) {
    throw new Error(
      `Failed to parse manifest at ${paths.backups.manifest}: ${(e as Error).message}`,
    )
  }
  if (!SUPPORTED_MANIFEST_VERSIONS.includes(parsed.version)) {
    throw new Error(
      `Manifest version ${parsed.version} not supported ` +
        `(expected one of ${SUPPORTED_MANIFEST_VERSIONS.join(', ')})`,
    )
  }
  return parsed
}

export async function writeManifest(manifest: Manifest): Promise<void> {
  await mkdir(dirname(paths.backups.manifest), { recursive: true })
  // Any write upgrades the manifest envelope to the current version. Older
  // entries keep their own (absent) `manifestVersion` and stay legacy.
  const upgraded: Manifest = { version: MANIFEST_VERSION, entries: manifest.entries }
  await atomicWrite(paths.backups.manifest, `${JSON.stringify(upgraded, null, 2)}\n`)
}

export async function appendEntries(newEntries: BackupEntry[]): Promise<void> {
  const m = await readManifest()
  m.entries.push(...newEntries)
  await writeManifest(m)
}

export async function removeEntries(ids: string[]): Promise<void> {
  const m = await readManifest()
  const idSet = new Set(ids)
  m.entries = m.entries.filter((e) => !idSet.has(e.id))
  await writeManifest(m)
}
