import { realpathSync } from 'node:fs'
import process from 'node:process'
import { DAEMON_BASE_URL } from '../../core/paths.ts'
import { installLaunchd, probeLaunchd, restartLaunchd, uninstallLaunchd } from './launchd.ts'
import { installSystemd, probeSystemd, restartSystemd, uninstallSystemd } from './systemd.ts'

export type ServiceState =
  | { state: 'not-installed' }
  | { state: 'installed'; pid?: number }
  | { state: 'unsupported'; platform: string }

export async function probeService(): Promise<ServiceState> {
  if (process.platform === 'darwin') {
    const p = await probeLaunchd()
    return p.installed ? { state: 'installed', pid: p.pid } : { state: 'not-installed' }
  }
  if (process.platform === 'linux') {
    const p = await probeSystemd()
    return p.installed ? { state: 'installed', pid: p.pid } : { state: 'not-installed' }
  }
  return { state: 'unsupported', platform: process.platform }
}

export async function ensureService(): Promise<void> {
  const args = computeDaemonArgs()
  if (process.platform === 'darwin') {
    await installLaunchd({ programArguments: args })
  } else if (process.platform === 'linux') {
    await installSystemd({ execStart: args })
  } else {
    throw new Error(`platform ${process.platform} not supported for service install`)
  }
}

/** Kill + restart the daemon service so it reloads freshly-installed code. */
export async function restartService(): Promise<void> {
  if (process.platform === 'darwin') return restartLaunchd()
  if (process.platform === 'linux') return restartSystemd()
  throw new Error(`platform ${process.platform} not supported for service restart`)
}

export async function uninstallService(): Promise<void> {
  if (process.platform === 'darwin') await uninstallLaunchd()
  else if (process.platform === 'linux') await uninstallSystemd()
}

export async function waitForHealth(timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${DAEMON_BASE_URL}/health`, {
        signal: AbortSignal.timeout(500),
      })
      if (r.ok) return true
    } catch {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/**
 * Compute the command line the service should run. Mirrors the way the
 * currently-running afw process was invoked so dev (raw .ts via
 * --experimental-strip-types) and prod (built .js) both work.
 */
function computeDaemonArgs(): string[] {
  const node = process.execPath
  const entry = process.argv[1]
  if (!entry) throw new Error('cannot resolve afw entry path (process.argv[1] is empty)')
  const resolvedEntry = safeRealpath(entry)
  const isTs = resolvedEntry.endsWith('.ts')
  return isTs
    ? [node, '--experimental-strip-types', resolvedEntry, 'daemon', 'run']
    : [node, resolvedEntry, 'daemon', 'run']
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
