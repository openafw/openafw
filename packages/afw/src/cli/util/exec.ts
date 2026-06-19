import { spawn } from 'node:child_process'

export type ExecResult = { exit: number; stdout: string; stderr: string }

export function execCapture(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
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
