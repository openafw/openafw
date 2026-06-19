import { spawn } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { paths } from '../../core/paths.ts'
import { atomicWrite, fileExists } from '../backup/files.ts'
import { launchdPlist } from './templates.ts'

const LABEL = 'com.openguardrails.afw.daemon'
// Pre-rename labels we still know how to clean up.
const LEGACY_LABELS = ['com.afw.daemon', 'com.wireafw.daemon']
const PLIST_DIR = join(homedir(), 'Library', 'LaunchAgents')
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`)

function serviceTarget(label = LABEL): string {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('launchd: process.getuid() unavailable')
  return `gui/${uid}/${label}`
}

function userDomain(): string {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('launchd: process.getuid() unavailable')
  return `gui/${uid}`
}

export async function installLaunchd(args: { programArguments: string[] }): Promise<void> {
  const plist = launchdPlist({
    label: LABEL,
    programArguments: args.programArguments,
    afwHome: paths.home,
    logPath: paths.logs.daemon,
    errPath: paths.logs.daemonErr,
  })
  await mkdir(PLIST_DIR, { recursive: true })

  // Clean up any pre-rename labels before installing the canonical one,
  // so we don't end up with two daemons racing on port 9877.
  await removeLegacyLabels()

  // Inspect current state before touching anything so re-running wire on an
  // already-installed daemon doesn't tear it down (launchctl bootout is
  // asynchronous and a follow-up bootstrap races, returning exit 5 / EIO,
  // which previously left the user with no daemon).
  const existing = (await fileExists(PLIST_PATH)) ? await readFile(PLIST_PATH, 'utf8') : null
  const plistChanged = existing !== plist
  const loaded = (await probeLaunchd()).installed

  await atomicWrite(PLIST_PATH, plist)

  if (loaded && !plistChanged) {
    // Already correct; just kickstart to ensure it's running.
    await runIgnore('launchctl', ['kickstart', serviceTarget()])
    return
  }

  if (loaded) {
    // Plist changed → unload, wait for launchd to actually finish, reload.
    await runIgnore('launchctl', ['bootout', serviceTarget()])
    await waitUntilNotLoaded(serviceTarget(), 3000)
  }

  const r = await run('launchctl', ['bootstrap', userDomain(), PLIST_PATH])
  if (r.exit !== 0) {
    throw new Error(`launchctl bootstrap failed (exit ${r.exit}): ${r.stderr.trim()}`)
  }
  await runIgnore('launchctl', ['kickstart', serviceTarget()])
}

async function removeLegacyLabels(): Promise<void> {
  for (const legacy of LEGACY_LABELS) {
    const target = serviceTarget(legacy)
    const probe = await run('launchctl', ['print', target])
    if (probe.exit === 0) {
      await runIgnore('launchctl', ['bootout', target])
      await waitUntilNotLoaded(target, 3000)
    }
    const legacyPlist = join(PLIST_DIR, `${legacy}.plist`)
    await rm(legacyPlist, { force: true })
  }
}

async function waitUntilNotLoaded(target: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await run('launchctl', ['print', target])
    if (r.exit !== 0) return
    await new Promise((res) => setTimeout(res, 100))
  }
}

export async function uninstallLaunchd(): Promise<void> {
  await runIgnore('launchctl', ['bootout', serviceTarget()])
  await rm(PLIST_PATH, { force: true })
  // Also clean any legacy labels lurking from older installs.
  await removeLegacyLabels()
}

export async function restartLaunchd(): Promise<void> {
  // kickstart -k kills the running instance and starts a fresh one — so it
  // works whether called by the CLI or by the daemon restarting itself.
  const r = await run('launchctl', ['kickstart', '-k', serviceTarget()])
  if (r.exit !== 0) {
    throw new Error(`launchctl kickstart -k failed (exit ${r.exit}): ${r.stderr.trim()}`)
  }
}

export async function probeLaunchd(): Promise<{ installed: boolean; pid?: number }> {
  const r = await run('launchctl', ['print', serviceTarget()])
  if (r.exit === 0) {
    const m = r.stdout.match(/pid\s*=\s*(\d+)/)
    if (m?.[1]) return { installed: true, pid: Number.parseInt(m[1], 10) }
    return { installed: true }
  }
  // Fall back to legacy labels (one-time migration path for users still on
  // the pre-rename daemon). Installation will replace them on next wire.
  for (const legacy of LEGACY_LABELS) {
    const legacyR = await run('launchctl', ['print', serviceTarget(legacy)])
    if (legacyR.exit !== 0) continue
    const m = legacyR.stdout.match(/pid\s*=\s*(\d+)/)
    if (m?.[1]) return { installed: true, pid: Number.parseInt(m[1], 10) }
    return { installed: true }
  }
  return { installed: false }
}

type RunResult = { exit: number; stdout: string; stderr: string }

async function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    p.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    p.on('exit', (code) => resolve({ exit: code ?? 1, stdout, stderr }))
    p.on('error', () => resolve({ exit: 127, stdout, stderr }))
  })
}

async function runIgnore(cmd: string, args: string[]): Promise<void> {
  await run(cmd, args).catch(() => {})
}
