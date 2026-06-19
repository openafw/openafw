import { useEffect, useState } from 'react'
import type { NavSection } from '../App'
import { fetchWireStatus } from '../api'
import type { WireStatus } from '../types'

function agentCount(status: WireStatus): number {
  return status.wiredAgents.length
}

const TABS: Array<{ key: NavSection; href: string; label: string; verb: string }> = [
  { key: 'see', href: '#/see', label: 'See', verb: 'see' },
  { key: 'routing', href: '#/routing', label: 'Routing', verb: 'route' },
  { key: 'keys', href: '#/keys', label: 'Connect', verb: 'keys' },
  { key: 'guard', href: '#/guard', label: 'Guard', verb: 'guard' },
]

export function Nav({ active }: { active: NavSection }) {
  const [status, setStatus] = useState<WireStatus | null>(null)
  const [healthOk, setHealthOk] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [w, h] = await Promise.all([fetchWireStatus(), fetch('/health')])
        if (!cancelled) {
          setStatus(w)
          setHealthOk(h.ok)
        }
      } catch {
        if (!cancelled) setHealthOk(false)
      }
    }
    void load()
    const t = setInterval(load, 15_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  return (
    <header className="nav">
      <div className="nav-row nav-row-main">
        <a className="nav-brand" href="#/" title="Home">
          <span className="nav-dot" />
          <span>afw</span>
        </a>
        <nav className="nav-pillars" aria-label="Sections">
          {TABS.map((t) => (
            <a
              key={t.key}
              href={t.href}
              className={`nav-pillar ${active === t.key ? 'active' : ''}`}
            >
              <span className="nav-pillar-label">{t.label}</span>
              {t.verb && <span className="nav-pillar-sub">{t.verb}</span>}
            </a>
          ))}
        </nav>
        <div className="nav-meta">
          {status && (
            <span
              className="nav-stat"
              title={
                status.wiredAgents.length > 0
                  ? `Agents the wire accepts traffic for:\n${status.wiredAgents.join('\n')}`
                  : 'No agents wired yet — launch one with `afw claude`'
              }
            >
              ●●● {agentCount(status)} wired
              {status.driftedCount > 0 && (
                <span className="nav-drift"> · {status.driftedCount} drifted</span>
              )}
            </span>
          )}
          <span className={`nav-health ${healthOk ? 'ok' : 'fail'}`}>
            {healthOk == null ? '…' : healthOk ? 'daemon ok' : 'daemon down'}
          </span>
        </div>
      </div>
    </header>
  )
}
