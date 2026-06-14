import { useState } from 'react'
import { ModelFusionTab } from './routing/ModelFusionTab'
import { ModelsTab } from './routing/ModelsTab'
import { RoutesTab } from './routing/RoutesTab'
import { ToolsTab } from './routing/ToolsTab'

type Tab = 'routes' | 'models' | 'fusion' | 'tools'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'routes', label: 'Routes' },
  { key: 'fusion', label: 'Model Fusion' },
  { key: 'models', label: 'Model providers' },
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
      ) : tab === 'fusion' ? (
        <ModelFusionTab />
      ) : (
        <ToolsTab />
      )}
    </div>
  )
}
