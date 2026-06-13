import { TaskList } from './TaskList'
import { AgentsTab } from './see/AgentsTab'
import { McpTab } from './see/McpTab'
import { SkillsTab } from './see/SkillsTab'

type Tab = 'agents' | 'mcp' | 'skills' | 'tasks'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'agents', label: 'Agents' },
  { key: 'mcp', label: 'MCP' },
  { key: 'skills', label: 'Skills' },
  { key: 'tasks', label: 'Tasks' },
]

function tabFromHash(hash: string): Tab {
  const m = /^#\/see\/(agents|mcp|skills|tasks)/.exec(hash)?.[1]
  return (m as Tab) ?? 'agents'
}

// The See section: captured activity viewed from four angles. Agents pivots by
// running instance (which MCP/skills/tools it used); MCP/Skills aggregate those
// across instances; Tasks is the conversation list. Sub-tab is hash-driven
// (#/see/<tab>) so it deep-links and survives back-from-detail.
export function See({ hash }: { hash: string }) {
  const tab = tabFromHash(hash)
  return (
    <div className="routing">
      <div className="subtabs">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            className={`subtab ${tab === t.key ? 'active' : ''}`}
            onClick={() => {
              window.location.hash = `#/see/${t.key}`
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'agents' ? (
        <AgentsTab />
      ) : tab === 'mcp' ? (
        <McpTab />
      ) : tab === 'skills' ? (
        <SkillsTab />
      ) : (
        <TaskList />
      )}
    </div>
  )
}
