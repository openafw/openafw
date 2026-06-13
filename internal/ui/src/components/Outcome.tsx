import type { RunOutcome } from '../types'

// A run/task that errored but recovered via chain failover is not broken — it
// completed on a sibling model. Badge it amber ("recovered"), distinct from a
// terminal failure (red "error"), so a recovered run doesn't read as failed.
export function OutcomeBadge({ outcome }: { outcome: RunOutcome }) {
  if (outcome === 'failed') return <span className="run-error-badge">error</span>
  if (outcome === 'recovered')
    return (
      <span className="run-recovered-badge" title="An attempt errored but failover succeeded">
        recovered
      </span>
    )
  return null
}

export function outcomeRowClass(outcome: RunOutcome): string | undefined {
  if (outcome === 'failed') return 'run-errored'
  if (outcome === 'recovered') return 'run-recovered'
  return undefined
}
