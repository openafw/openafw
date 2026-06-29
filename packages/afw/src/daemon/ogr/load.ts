// Live-reload the approved OGR policy. The tagger reads it through the cached
// loadOgrPolicy(); this watcher drops that cache whenever the live file changes
// — so a CLI `afw ogr approve`, a hand-edit, or a UI approval takes effect on
// the next packet without a daemon restart. Mirrors daemon/masking/load.ts.

import { type FSWatcher, watch } from 'node:fs'
import { basename } from 'node:path'
import { logger } from '../../core/logger.ts'
import { paths } from '../../core/paths.ts'
import { loadOgrPolicy, resetOgrPolicyCache } from './policy.ts'

let watcher: FSWatcher | undefined
let debounce: ReturnType<typeof setTimeout> | undefined

const POLICY_FILENAME = basename(paths.ogrPolicy)

export function initOgrPolicy(): void {
  // Warm the cache once so the first packet doesn't pay the disk read.
  loadOgrPolicy()
  startWatcher()
}

function startWatcher(): void {
  if (watcher) return
  try {
    watcher = watch(paths.home, (_event, filename) => {
      if (filename !== POLICY_FILENAME) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        resetOgrPolicyCache()
        loadOgrPolicy()
        logger.debug('ogr: reloaded policy after file change')
      }, 50)
    })
  } catch (err) {
    logger.warn(`ogr: watch failed — ${(err as Error).message}; reload won't be automatic`)
  }
}

export function stopOgrPolicyWatcher(): void {
  watcher?.close()
  watcher = undefined
  if (debounce) clearTimeout(debounce)
}
