import { type FSWatcher, watch } from 'node:fs'
import { basename } from 'node:path'
import { readRoutes } from '../../cli/wire/routes.ts'
import { logger } from '../../core/logger.ts'
import { paths } from '../../core/paths.ts'
import { ROUTES_VERSION, type Routes } from '../../core/routes.ts'

let cached: Routes = { version: ROUTES_VERSION, routes: {} }
let watcher: FSWatcher | undefined
let debounce: ReturnType<typeof setTimeout> | undefined

const ROUTES_FILENAME = basename(paths.wire.routes)

// Fired after every successful (re)load — provider seeding hooks in here so a
// new wire route immediately gets a seeded provider in the model registry.
const reloadHooks: Array<() => void> = []

export function onRoutesReload(cb: () => void): void {
  reloadHooks.push(cb)
}

export async function initRoutesTable(): Promise<void> {
  await reload()
  startWatcher()
}

export function getRoutes(): Routes {
  return cached
}

async function reload(): Promise<void> {
  try {
    cached = await readRoutes()
    logger.debug(`routes: loaded ${Object.keys(cached.routes).length} entries`)
  } catch (err) {
    logger.error(`routes: failed to load — ${(err as Error).message}`)
  }
  for (const hook of reloadHooks) {
    try {
      hook()
    } catch (err) {
      logger.warn(`routes: reload hook failed — ${(err as Error).message}`)
    }
  }
}

function startWatcher(): void {
  if (watcher) return
  try {
    watcher = watch(paths.wire.dir, (_event, filename) => {
      if (filename !== ROUTES_FILENAME) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        void reload()
      }, 50)
    })
  } catch (err) {
    logger.warn(`routes: watch failed — ${(err as Error).message}; reload won't be automatic`)
  }
}

export function stopWatcher(): void {
  watcher?.close()
  watcher = undefined
  if (debounce) clearTimeout(debounce)
}
