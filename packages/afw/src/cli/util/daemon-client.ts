// Thin HTTP client for the local afw daemon's REST surface. Shared by the
// route/model commands and the launcher so they all talk to the daemon the
// same way (and surface the same "is it running?" error).

import { DAEMON_BASE_URL } from '../../core/paths.ts'

export class DaemonUnreachableError extends Error {
  constructor() {
    super('cannot reach the afw daemon — start it with `afw daemon`')
    this.name = 'DaemonUnreachableError'
  }
}

/** Call a daemon API endpoint, returning the parsed JSON body. Throws
 *  DaemonUnreachableError if the daemon isn't up, or Error(message) on a
 *  non-2xx response (using the daemon's `{error}` field when present). */
export async function daemonFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${DAEMON_BASE_URL}${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    throw new DaemonUnreachableError()
  }
  const text = await res.text()
  let json: unknown = {}
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = {}
    }
  }
  if (!res.ok) {
    const msg =
      json && typeof json === 'object' && 'error' in json
        ? String((json as { error: unknown }).error)
        : `HTTP ${res.status}`
    throw new Error(msg)
  }
  return json as T
}

/** True if the daemon answers /health within a short timeout. */
export async function daemonHealthy(timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON_BASE_URL}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}
