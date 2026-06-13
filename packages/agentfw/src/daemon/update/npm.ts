import { spawn } from 'node:child_process'

/**
 * Run `npm install -g <spec>`. Resolves on success; rejects with the tail of
 * stderr on failure. This is the one command that actually changes the
 * installed agentfw version — used for both updates and rollbacks.
 */
export function npmInstallGlobal(spec: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('npm', ['install', '-g', spec], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let err = ''
    p.stderr.on('data', (d) => {
      err += d.toString()
    })
    p.on('error', (e) => reject(e))
    p.on('exit', (code) => {
      if (code === 0) resolve()
      else
        reject(
          new Error(
            `npm install -g ${spec} failed (exit ${code}): ${err.trim().slice(-500)}`,
          ),
        )
    })
  })
}
