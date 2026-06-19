import { Command } from 'commander'
import { runSupervisor } from '../../daemon/update/supervisor.ts'

// Hidden, internal. The daemon spawns this (detached) during an update to
// health-gate the new version and roll back if it fails. Not for direct use.
export const updateSupervisorCommand = new Command('__supervise-update')
  .description('internal: health-gate an in-progress update, roll back on failure')
  .action(async () => {
    await runSupervisor()
  })
