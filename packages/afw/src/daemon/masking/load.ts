// Cached, hot-reloaded view of masking.json. Mirrors daemon/routes/load.ts:
// load once at daemon start, watch for changes, serve the last-good value from
// memory so the proxy path never does disk IO on the hot request path.

import { type FSWatcher, watch } from 'node:fs'
import { basename } from 'node:path'
import { logger } from '../../core/logger.ts'
import {
  DEFAULT_MASKING_CONFIG,
  type MaskingConfig,
  readMaskingConfig,
} from '../../core/masking.ts'
import { paths } from '../../core/paths.ts'

let cached: MaskingConfig = { ...DEFAULT_MASKING_CONFIG }
let watcher: FSWatcher | undefined
let debounce: ReturnType<typeof setTimeout> | undefined

const MASKING_FILENAME = basename(paths.masking)

export function getMaskingConfig(): MaskingConfig {
  return cached
}

export async function initMaskingTable(): Promise<void> {
  await reload()
  startWatcher()
}

async function reload(): Promise<void> {
  try {
    cached = await readMaskingConfig()
    logger.debug(`masking: loaded (${Object.keys(cached.providers).length} provider(s) configured)`)
  } catch (err) {
    logger.error(`masking: failed to load — ${(err as Error).message}`)
  }
}

function startWatcher(): void {
  if (watcher) return
  try {
    watcher = watch(paths.home, (_event, filename) => {
      if (filename !== MASKING_FILENAME) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => void reload(), 50)
    })
  } catch (err) {
    logger.warn(`masking: watch failed — ${(err as Error).message}; reload won't be automatic`)
  }
}

export function stopMaskingWatcher(): void {
  watcher?.close()
  watcher = undefined
  if (debounce) clearTimeout(debounce)
}
