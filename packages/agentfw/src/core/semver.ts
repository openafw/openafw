// Minimal semver comparison. agentfw versions are plain `major.minor.patch`
// with an optional `-prerelease` suffix — no need for a dependency, just
// enough to answer "is the registry's latest newer than what's installed?".

export type ParsedVersion = {
  major: number
  minor: number
  patch: number
  pre: string
}

export function parseVersion(v: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ?? '',
  }
}

/** -1 if a < b, 0 if equal, 1 if a > b. Unparseable input sorts as equal. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] < pb[k]) return -1
    if (pa[k] > pb[k]) return 1
  }
  // Same x.y.z: a real release outranks any prerelease of it.
  if (pa.pre === pb.pre) return 0
  if (pa.pre === '') return 1
  if (pb.pre === '') return -1
  return pa.pre < pb.pre ? -1 : 1
}

/** Is `latest` strictly newer than `current`? */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0
}
