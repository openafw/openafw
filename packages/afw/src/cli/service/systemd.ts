import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { paths } from '../../core/paths.ts'
import { atomicWrite } from '../backup/files.ts'
import { systemdUnit } from './templates.ts'

const UNIT_NAME = 'afw.service'
const UNIT_DIR = join(homedir(), '.config', 'systemd', 'user')
const UNIT_PATH = join(UNIT_DIR, UNIT_NAME)

export async function installSystemd(args: { execStart: string[] }): Promise<void> {
  const unit = systemdUnit({
    description: 'afw — the dynamic harness for your agent fleet',
    execStart: args.execStart,
    afwHome: paths.home,
    logPath: paths.logs.daemon,
    errPath: paths.logs.daemonErr,
  })
  await mkdir(UNIT_DIR, { recursive: true })
  await atomicWrite(UNIT_PATH, unit)

  const r1 = await run('systemctl', ['--user', 'daemon-reload'])
  if (r1.exit !== 0) {
    throw new Error(`systemctl daemon-reload failed: ${r1.stderr.trim()}`)
  }
  const r2 = await run('systemctl', ['--user', 'enable', '--now', UNIT_NAME])
  if (r2.exit !== 0) {
    throw new Error(`systemctl enable failed: ${r2.stderr.trim()}`)
  }
}

export async function uninstallSystemd(): Promise<void> {
  await runIgnore('systemctl', ['--user', 'disable', '--now', UNIT_NAME])
  await rm(UNIT_PATH, { force: true })
  await runIgnore('systemctl', ['--user', 'daemon-reload'])
}

export async function restartSystemd(): Promise<void> {
  const r = await run('systemctl', ['--user', 'restart', UNIT_NAME])
  if (r.exit !== 0) {
    throw new Error(`systemctl --user restart failed: ${r.stderr.trim()}`)
  }
}

export async function probeSystemd(): Promise<{ installed: boolean; pid?: number }> {
  const r = await run('systemctl', ['--user', 'is-active', UNIT_NAME])
  if (r.exit !== 0) return { installed: false }

  const pidR = await run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', UNIT_NAME])
  const pid = Number.parseInt(pidR.stdout.trim(), 10)
  return { installed: true, pid: pid > 0 ? pid : undefined }
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
