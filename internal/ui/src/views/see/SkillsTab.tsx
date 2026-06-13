import { useEffect, useState } from 'react'
import { fetchSkills } from '../../api'
import { Time } from '../../components/Format'
import type { SkillItem } from '../../types'

export function SkillsTab() {
  const [rows, setRows] = useState<SkillItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchSkills()
      .then((r) => !cancelled && setRows(r))
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [])

  if (error && !rows) return <div className="error">Error: {error}</div>
  if (!rows) return <div className="loading">Loading…</div>
  if (rows.length === 0) {
    return (
      <div className="empty">
        <p>No skills used yet.</p>
        <p className="hint">
          Populated from new traffic. When an agent invokes a skill (the <code>Skill</code> tool),
          it shows up here aggregated across instances.
        </p>
      </div>
    )
  }

  return (
    <div className="run-list-wrap">
      <table className="runs">
        <thead>
          <tr>
            <th>Skill</th>
            <th>Uses</th>
            <th>Instances</th>
            <th>Tasks</th>
            <th>Last used</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.skill}>
              <td>
                <code>{s.skill}</code>
              </td>
              <td>{s.useCount}</td>
              <td>{s.instanceCount}</td>
              <td>{s.taskCount}</td>
              <td>
                <Time ms={s.lastActive} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
