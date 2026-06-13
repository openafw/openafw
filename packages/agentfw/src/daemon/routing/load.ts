// Cached, hot-reloaded views of the three routing config files. Mirrors
// daemon/routes/load.ts: load once at daemon start, watch for changes, and
// serve the last-good value from memory so the proxy path never does disk IO.

import { type FSWatcher, watch } from 'node:fs'
import { basename } from 'node:path'
import { logger } from '../../core/logger.ts'
import {
  EMPTY_REGISTRY,
  type ModelRegistry,
  readModelRegistry,
} from '../../core/model-registry.ts'
import { paths } from '../../core/paths.ts'
import {
  EMPTY_POLICY,
  type RoutingPolicy,
  readRoutingPolicy,
} from '../../core/routing-policy.ts'
import { EMPTY_SECRETS, readSecrets, type SecretStore } from '../../core/secrets.ts'

let registry: ModelRegistry = EMPTY_REGISTRY
let policy: RoutingPolicy = EMPTY_POLICY
let secrets: SecretStore = EMPTY_SECRETS

let watcher: FSWatcher | undefined
const debounces = new Map<string, ReturnType<typeof setTimeout>>()

const MODELS_FILE = basename(paths.models)
const ROUTING_FILE = basename(paths.routing)
const SECRETS_FILE = basename(paths.secrets)

export function getModelRegistry(): ModelRegistry {
  return registry
}

export function getRoutingPolicy(): RoutingPolicy {
  return policy
}

export function getSecrets(): SecretStore {
  return secrets
}

export async function initRoutingTables(): Promise<void> {
  await Promise.all([reloadModels(), reloadRouting(), reloadSecrets()])
  startWatcher()
}

async function reloadModels(): Promise<void> {
  try {
    registry = await readModelRegistry()
    logger.debug(
      `routing: loaded ${registry.providers.length} providers, ${registry.models.length} models`,
    )
  } catch (err) {
    logger.error(`routing: failed to load models.json — ${(err as Error).message}`)
  }
}

async function reloadRouting(): Promise<void> {
  try {
    policy = await readRoutingPolicy()
    logger.debug(`routing: loaded policy for ${Object.keys(policy.agents).length} agents`)
  } catch (err) {
    logger.error(`routing: failed to load routing.json — ${(err as Error).message}`)
  }
}

async function reloadSecrets(): Promise<void> {
  try {
    secrets = await readSecrets()
  } catch (err) {
    logger.error(`routing: failed to load secrets.json — ${(err as Error).message}`)
  }
}

function startWatcher(): void {
  if (watcher) return
  try {
    // All three files live directly under ~/.agentfw/ — one directory watch
    // covers them; dispatch on the filename.
    watcher = watch(paths.home, (_event, filename) => {
      if (filename == null) return
      const reload =
        filename === MODELS_FILE
          ? reloadModels
          : filename === ROUTING_FILE
            ? reloadRouting
            : filename === SECRETS_FILE
              ? reloadSecrets
              : undefined
      if (!reload) return
      const pending = debounces.get(filename)
      if (pending) clearTimeout(pending)
      debounces.set(
        filename,
        setTimeout(() => {
          debounces.delete(filename)
          void reload()
        }, 50),
      )
    })
  } catch (err) {
    logger.warn(
      `routing: watch failed — ${(err as Error).message}; reload won't be automatic`,
    )
  }
}

export function stopRoutingWatcher(): void {
  watcher?.close()
  watcher = undefined
  for (const t of debounces.values()) clearTimeout(t)
  debounces.clear()
}
