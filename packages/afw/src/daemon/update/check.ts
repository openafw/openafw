import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { logger } from '../../core/logger.ts'
import { paths } from '../../core/paths.ts'
import { isNewer } from '../../core/semver.ts'
import { VERSION } from '../../core/version.ts'

// The only network endpoint this feature touches: the public npm registry.
// The request carries the package name (in the URL) and nothing else — no
// user data, no identifiers, and never one of our own servers.
const REGISTRY_URL = 'https://registry.npmjs.org/openafw/latest'

export type UpdateState = {
  currentVersion: string
  latestVersion: string | null
  available: boolean
  checkedAt: number | null
  error: string | null
}

function freshState(): UpdateState {
  return {
    currentVersion: VERSION,
    latestVersion: null,
    available: false,
    checkedAt: null,
    error: null,
  }
}

/**
 * Read the cached update state. `currentVersion` and `available` are always
 * recomputed against the running build — so right after an update the cache
 * does not falsely keep claiming an update is available.
 */
export async function readUpdateState(): Promise<UpdateState> {
  try {
    const parsed = JSON.parse(await readFile(paths.update, 'utf8')) as UpdateState
    return {
      ...parsed,
      currentVersion: VERSION,
      available: parsed.latestVersion ? isNewer(parsed.latestVersion, VERSION) : false,
    }
  } catch {
    return freshState()
  }
}

async function writeUpdateState(state: UpdateState): Promise<void> {
  await mkdir(dirname(paths.update), { recursive: true })
  await writeFile(paths.update, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * Ask the npm registry for the latest published version, compare to the
 * installed one, and cache the result to ~/.afw/update.json. Network
 * failures are non-fatal — they are recorded in `error` and never surface
 * as a false "update available".
 */
export async function checkForUpdate(): Promise<UpdateState> {
  const state = freshState()
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`registry HTTP ${res.status}`)
    const body = (await res.json()) as { version?: string }
    if (!body.version) throw new Error('registry response missing version')
    state.latestVersion = body.version
    state.available = isNewer(body.version, VERSION)
    state.checkedAt = Date.now()
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e)
    logger.debug(`update: check failed — ${state.error}`)
  }
  await writeUpdateState(state)
  return state
}
