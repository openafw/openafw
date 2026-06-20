import { access, readFile, readdir } from 'node:fs/promises'
import { basename, delimiter, dirname, isAbsolute, join, normalize, sep } from 'node:path'
import process from 'node:process'

export type ResolvedLaunchBin = {
  command: string
  argsPrefix: string[]
  shell: boolean
}

type ResolveOpts = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

const EXECUTABLE_EXTENSIONS = ['.exe', '.com']
const SHELL_EXTENSIONS = ['.cmd', '.bat']

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function pathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? ''
}

function pathExts(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? env.PathExt ?? '.COM;.EXE;.BAT;.CMD'
  return raw
    .split(';')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\')
}

/** Resolve a candidate path the way Windows' loader does — case-insensitively.
 *  Returns the real on-disk path (preserving its actual case) or undefined.
 *  An exact match is the fast path (correct on real Windows and on a
 *  case-insensitive host FS like macOS); the directory scan is the fallback
 *  that makes win32 resolution behave correctly even on a case-sensitive host
 *  FS (Linux CI), where `PATHEXT`'s case need not match the file's. */
async function resolveCaseInsensitive(path: string): Promise<string | undefined> {
  if (await exists(path)) return path
  const dir = dirname(path)
  const target = basename(path).toLowerCase()
  try {
    const entries = await readdir(dir)
    const match = entries.find((e) => e.toLowerCase() === target)
    return match ? join(dir, match) : undefined
  } catch {
    return undefined
  }
}

async function firstExisting(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const hit = await resolveCaseInsensitive(candidate)
    if (hit) return hit
  }
  return undefined
}

function asResolved(command: string, shell: boolean, argsPrefix: string[] = []): ResolvedLaunchBin {
  return { command, argsPrefix, shell }
}

function windowsCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const dirs =
    hasPathSeparator(command) || isAbsolute(command) ? [''] : pathValue(env).split(delimiter)
  const exts = pathExts(env)
  const hasExt = /\.[^\\/]+$/.test(command)

  const suffixes = hasExt
    ? ['']
    : [
        ...EXECUTABLE_EXTENSIONS.filter((ext) => exts.includes(ext)),
        ...SHELL_EXTENSIONS.filter((ext) => exts.includes(ext)),
      ]

  const out: string[] = []
  for (const dir of dirs) {
    if (!dir && !hasPathSeparator(command) && !isAbsolute(command)) continue
    for (const suffix of suffixes)
      out.push(dir ? join(dir, `${command}${suffix}`) : `${command}${suffix}`)
  }
  return out
}

function resolveShimPath(raw: string, baseDir: string): string {
  const withBaseDir = raw.replace(/%~dp0/gi, baseDir).replace(/%dp0%/gi, baseDir)
  const withNativeSeparators = withBaseDir.replace(/[\\/]+/g, sep)
  return normalize(
    isAbsolute(withNativeSeparators) ? withNativeSeparators : join(baseDir, withNativeSeparators),
  )
}

function quotedDp0Targets(text: string, baseDir: string): string[] {
  return [...text.matchAll(/"([^"]*%~?dp0[^"]*)"/gi)].map((match) =>
    resolveShimPath(match[1]!, baseDir),
  )
}

async function resolveNpmCmdShim(command: string): Promise<ResolvedLaunchBin | undefined> {
  const lower = command.toLowerCase()
  if (!SHELL_EXTENSIONS.some((ext) => lower.endsWith(ext))) return undefined

  let text: string
  try {
    text = await readFile(command, 'utf8')
  } catch {
    return undefined
  }

  const baseDir = dirname(command)
  const targets = quotedDp0Targets(text, baseDir)
  const nativeTarget = targets.find(
    (target) => /\.(exe|com)$/i.test(target) && !/[\\/]node\.exe$/i.test(target),
  )
  if (nativeTarget && (await exists(nativeTarget))) return asResolved(nativeTarget, false)

  const scriptTarget = targets.find((target) => /\.(cjs|js|mjs)$/i.test(target))
  if (scriptTarget && (await exists(scriptTarget))) {
    const localNode = join(baseDir, 'node.exe')
    const node = (await exists(localNode)) ? localNode : process.execPath
    return asResolved(node, false, [scriptTarget])
  }

  return undefined
}

export async function resolveLaunchBin(
  command: string,
  opts: ResolveOpts = {},
): Promise<ResolvedLaunchBin> {
  const platform = opts.platform ?? process.platform
  if (platform !== 'win32') return asResolved(command, false)

  const env = opts.env ?? process.env
  const candidates = windowsCandidates(command, env)
  const resolved = await firstExisting(candidates)
  if (!resolved) return asResolved(command, false)

  const lower = resolved.toLowerCase()
  const shimTarget = await resolveNpmCmdShim(resolved)
  if (shimTarget) return shimTarget

  return asResolved(
    resolved,
    SHELL_EXTENSIONS.some((ext) => lower.endsWith(ext)),
  )
}
