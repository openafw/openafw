#!/usr/bin/env node
// Smoke test: does the built artifact actually boot and serve?
//
// Spawns the built daemon against a throwaway AFW_HOME and a random
// port (never touches the user's real ~/.afw or daemon on 9877),
// asserts the core endpoints respond, then tears everything down.
//
// Run after `npm run build`, before every publish. See .strategy/releasing.md.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const DAEMON = fileURLToPath(new URL('../dist/bin/afw.js', import.meta.url))
const PORT = 30000 + Math.floor(Math.random() * 20000)
const BASE = `http://localhost:${PORT}`

const log = (s) => process.stdout.write(`  ${s}\n`)
const fail = (s) => {
  process.stderr.write(`✗ smoke: ${s}\n`)
  process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(DAEMON)) {
  fail(`built daemon not found at ${DAEMON} — run \`npm run build\` first`)
  process.exit(1)
}

const home = await mkdtemp(join(tmpdir(), 'afw-smoke-'))
const stderr = []
let proc
let exited = false

async function main() {
  log(`AFW_HOME=${home}`)
  log(`port=${PORT}`)

  proc = spawn(process.execPath, [DAEMON, 'daemon'], {
    env: { ...process.env, AFW_HOME: home, AFW_PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  proc.stderr.on('data', (d) => stderr.push(d.toString()))
  proc.on('exit', (code) => {
    exited = true
    if (code) stderr.push(`daemon exited early with code ${code}\n`)
  })

  // Wait for /health.
  const deadline = Date.now() + 20000
  let healthy = false
  while (Date.now() < deadline && !exited) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) {
        healthy = true
        break
      }
    } catch {
      // not up yet
    }
    await sleep(400)
  }
  if (!healthy) {
    fail('daemon did not become healthy within 20s')
    return
  }
  log('/health → ok')

  // Dashboard.
  const idx = await fetch(`${BASE}/`)
  if (!idx.ok) {
    fail(`/ returned HTTP ${idx.status}`)
    return
  }
  if (!(await idx.text()).includes('afw')) {
    fail('/ did not render the dashboard')
    return
  }
  log('/ → dashboard serves')

  // Core API.
  const api = await fetch(`${BASE}/api/afw?period=24h`)
  if (!api.ok) {
    fail(`/api/afw returned HTTP ${api.status}`)
    return
  }
  await api.json()
  log('/api/afw → serves JSON')

  // Routing API — the model registry and routing policy auto-seed on first
  // boot, so both must serve a valid (possibly empty) payload.
  const registry = await fetch(`${BASE}/api/routing/registry`)
  if (!registry.ok) {
    fail(`/api/routing/registry returned HTTP ${registry.status}`)
    return
  }
  const reg = await registry.json()
  if (!Array.isArray(reg?.providers) || !Array.isArray(reg?.models)) {
    fail('/api/routing/registry did not return a model registry')
    return
  }
  log('/api/routing/registry → serves model registry')

  const policy = await fetch(`${BASE}/api/routing/policy`)
  if (!policy.ok) {
    fail(`/api/routing/policy returned HTTP ${policy.status}`)
    return
  }
  await policy.json()
  log('/api/routing/policy → serves routing policy')

  log('✓ smoke test passed')
}

try {
  await main()
} catch (e) {
  fail(e?.message ?? String(e))
} finally {
  if (proc && !proc.killed) proc.kill('SIGKILL')
  await rm(home, { recursive: true, force: true }).catch(() => {})
  if (process.exitCode) {
    process.stderr.write(`\n--- daemon stderr ---\n${stderr.join('') || '(none)'}\n`)
  }
}
