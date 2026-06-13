import { useEffect, useState } from 'react'
import { Nav } from './components/Nav'
import { Guard } from './views/Guard'
import { Home } from './views/Home'
import { Routing } from './views/Routing'
import { RunDetail } from './views/RunDetail'
import { See } from './views/See'
import { TaskDetail } from './views/TaskDetail'
import { InstanceDetail } from './views/see/InstanceDetail'

export type NavSection = 'home' | 'see' | 'routing' | 'guard'

export function App() {
  const [hash, setHash] = useState(window.location.hash)

  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  // See hierarchy: agents/mcp/skills/tasks → instance detail / task detail →
  // run detail. All drill-ins live under the "See" pillar.
  const runId = /^#\/run\/(.+)$/.exec(hash)?.[1]
  const taskId = /^#\/task\/(.+)$/.exec(hash)?.[1]
  const instanceKey = /^#\/instance\/(.+)$/.exec(hash)?.[1]

  const active: NavSection =
    runId || taskId || instanceKey || /^#\/(see|tasks)/.test(hash)
      ? 'see'
      : /^#\/routing/.test(hash)
        ? 'routing'
        : /^#\/guard/.test(hash)
          ? 'guard'
          : 'home'

  return (
    <div className="app">
      <Nav active={active} />
      <main>
        {runId ? (
          <RunDetail runId={decodeURIComponent(runId)} />
        ) : taskId ? (
          <TaskDetail taskId={decodeURIComponent(taskId)} />
        ) : instanceKey ? (
          <InstanceDetail instanceKey={instanceKey} />
        ) : active === 'see' ? (
          <See hash={hash} />
        ) : active === 'routing' ? (
          <Routing />
        ) : active === 'guard' ? (
          <Guard />
        ) : (
          <Home />
        )}
      </main>
    </div>
  )
}
