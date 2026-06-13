// The secret store — ~/.agentfw/secrets.json, file mode 0600. Cross-agent
// routing and the vision companion need API keys for providers the client
// agent never authenticates to itself. ProviderAuth.valueRef in models.json
// points at a key here. Local-only: values go solely to the upstream URLs
// the user configured — agentfw opens no new outbound surface for them.

import { readFile } from 'node:fs/promises'
import { atomicWrite, fileExists } from './atomic-file.ts'
import { paths } from './paths.ts'

export const SECRETS_VERSION = 1 as const
const SECRETS_MODE = 0o600

export type SecretStore = {
  version: typeof SECRETS_VERSION
  secrets: Record<string, string>
}

export const EMPTY_SECRETS: SecretStore = { version: SECRETS_VERSION, secrets: {} }

// ── helpers ───────────────────────────────────────────────────────

export function getSecret(store: SecretStore, ref: string): string | undefined {
  return store.secrets[ref]
}

/** Refs present in the store, for the UI to show which keys are configured
 *  (it never receives the values themselves). */
export function secretRefs(store: SecretStore): string[] {
  return Object.keys(store.secrets)
}

// ── parse / normalize ─────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function normalizeSecretStore(raw: unknown): SecretStore {
  if (!isObj(raw)) return { ...EMPTY_SECRETS }
  if (raw.version !== SECRETS_VERSION) {
    throw new Error(
      `secrets.json version ${String(raw.version)} not supported (expected ${SECRETS_VERSION})`,
    )
  }
  const secrets: Record<string, string> = {}
  if (isObj(raw.secrets)) {
    for (const [ref, value] of Object.entries(raw.secrets)) {
      if (typeof value === 'string') secrets[ref] = value
    }
  }
  return { version: SECRETS_VERSION, secrets }
}

// ── read / write ──────────────────────────────────────────────────

export async function readSecrets(): Promise<SecretStore> {
  if (!(await fileExists(paths.secrets))) return { ...EMPTY_SECRETS }
  return normalizeSecretStore(JSON.parse(await readFile(paths.secrets, 'utf8')))
}

export async function writeSecrets(store: SecretStore): Promise<void> {
  await atomicWrite(paths.secrets, `${JSON.stringify(store, null, 2)}\n`, { mode: SECRETS_MODE })
}

let writeChain: Promise<unknown> = Promise.resolve()

/** Serialized read-modify-write — see model-registry.ts mutateModelRegistry. */
export function mutateSecrets(
  fn: (store: SecretStore) => SecretStore | undefined,
): Promise<SecretStore> {
  const next = writeChain.then(async () => {
    const store = await readSecrets()
    const updated = fn(store)
    if (updated) await writeSecrets(updated)
    return updated ?? store
  })
  writeChain = next.catch(() => {})
  return next
}

/** Store a secret value under a ref. */
export function setSecret(ref: string, value: string): Promise<SecretStore> {
  return mutateSecrets((store) => ({
    ...store,
    secrets: { ...store.secrets, [ref]: value },
  }))
}

/** Remove a secret. No-op if the ref is absent. */
export function removeSecret(ref: string): Promise<SecretStore> {
  return mutateSecrets((store) => {
    if (!(ref in store.secrets)) return undefined
    const secrets = { ...store.secrets }
    delete secrets[ref]
    return { ...store, secrets }
  })
}
