import { useState } from 'react'
import { ModelProvidersTab } from './routing/ModelProvidersTab'
import { ModelsTab } from './routing/ModelsTab'
import { RoutesTab } from './routing/RoutesTab'
import { ToolsTab } from './routing/ToolsTab'

type Tab = 'routes' | 'models' | 'model-providers' | 'tools'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'routes', label: 'Routes' },
  { key: 'models', label: 'Models' },
  { key: 'model-providers', label: 'Model providers' },
  { key: 'tools', label: 'Tool providers' },
]

export function Routing() {
  const [tab, setTab] = useState<Tab>('routes')
  return (
    <div className="routing">
      <div className="subtabs">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            className={`subtab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'routes' ? (
        <RoutesTab />
      ) : tab === 'models' ? (
        <ModelsTab />
      ) : tab === 'model-providers' ? (
        <ModelProvidersTab />
      ) : (
        <ToolsTab />
      )}
    </div>
  )
}
