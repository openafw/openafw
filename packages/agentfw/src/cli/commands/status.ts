import { statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Command } from 'commander'
import { logger } from '../../core/logger.ts'
import { DAEMON_BASE_URL, paths } from '../../core/paths.ts'
import { readManifest } from '../backup/manifest.ts'
import { probeService } from '../service/index.ts'

type HealthBody = {
  status: string
  uptime: number
  version: string
}

export const statusCommand = new Command('status')
  .description('Show daemon and tap health.')
  .action(async () => {
    // Service state
    const sState = await probeService()
    if (sState.state === 'unsupported') {
      logger.print(`Service:   unsupported on ${sState.platform}`)
    } else if (sState.state === 'not-installed') {
      logger.print('Service:   not installed')
    } else {
      logger.print(`Service:   installed${sState.pid ? ` (pid ${sState.pid})` : ''}`)
    }

    // Daemon health
    try {
      const res = await fetch(`${DAEMON_BASE_URL}/health`, {
        signal: AbortSignal.timeout(1500),
      })
      if (!res.ok) {
        logger.print(`Daemon:    unhealthy (HTTP ${res.status})`)
        process.exitCode = 1
      } else {
        const body = (await res.json()) as HealthBody
        logger.print(
          `Daemon:    ${body.status} (up ${Math.round(body.uptime)}s, v${body.version})`,
        )
        logger.print(`UI:        ${DAEMON_BASE_URL}`)
      }
    } catch {
      logger.print('Daemon:    not responding on /health')
      if (sState.state === 'not-installed') {
        logger.print('  Start it with `agentfw daemon`, or just launch an agent (e.g. `agentfw claude`).')
      }
      process.exitCode = 1
    }

    // Wired agents
    try {
      const manifest = await readManifest()
      if (manifest.entries.length === 0) {
        logger.print('Wired:     (nothing)')
      } else {
        const byAgent = new Map<string, number>()
        for (const e of manifest.entries) {
          byAgent.set(e.agent, (byAgent.get(e.agent) ?? 0) + 1)
        }
        const parts = [...byAgent.entries()].map(([a, n]) => `${a} (${n})`)
        logger.print(`Wired:     ${parts.join(', ')}`)
      }
    } catch (err) {
      logger.print(`Wired:     (manifest read failed: ${(err as Error).message})`)
    }

    // Drift status
    try {
      const r = await fetch(`${DAEMON_BASE_URL}/api/wire/status`, {
        signal: AbortSignal.timeout(1500),
      })
      if (r.ok) {
        const body = (await r.json()) as {
          driftedCount: number
          entries: Array<{ path: string; agent: string; drifted: boolean }>
        }
        if (body.driftedCount === 0) {
          logger.print('Drift:     none')
        } else {
          logger.print(`Drift:     ⚠ ${body.driftedCount} file(s) modified since wire:`)
          for (const e of body.entries.filter((x) => x.drifted)) {
            logger.print(`           - ${e.agent}: ${e.path}`)
          }
          logger.print('  These files drifted from a prior agentfw setup.')
        }
      }
    } catch {
      // daemon may not be on the new code yet; silently skip
    }

    // Trace DB size + retention
    try {
      const dbPath = join(paths.wire.traces, 'traces.db')
      const st = statSync(dbPath)
      const size = formatBytes(st.size)
      const retentionRaw = process.env.AGENTFW_RETENTION_DAYS
      const retention =
        retentionRaw === '0'
          ? 'disabled'
          : retentionRaw && Number.isFinite(Number(retentionRaw))
            ? `${retentionRaw}d`
            : '30d (default)'
      logger.print(`Trace DB:  ${size}, auto-prune ${retention}`)
    } catch {
      // db not created yet — daemon hasn't recorded anything
    }
  })

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}
