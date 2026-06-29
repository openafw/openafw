import { existsSync } from 'node:fs'
import type { Context } from 'hono'
import { paths } from '../../core/paths.ts'
import { loadOgrPolicy } from '../ogr/policy.ts'

// The gateway-altitude detectors afw composes, in evaluation order. Mirrors the
// reference gateway's `GET /policy`, which lists the composed detectors so an
// operator can see what is actually enforcing.
const DETECTORS = [
  {
    provider: 'afw.gateway.content_guard',
    handles: ['model_input', 'model_output'],
    description: 'prompt injection (provenance-aware) and secret/credential leakage',
  },
  {
    provider: 'afw.gateway.config_rules',
    handles: ['tool_call', 'exec'],
    description: 'deterministic command rules over tool-call arguments',
  },
]

/** GET /api/ogr/policy — the effective OGR gateway policy (composition +
 *  content/config rules) and the composed detectors. Read-only: the policy is
 *  authored in the file below and reloaded; per OGR's approval gate, the UI
 *  does not edit a live policy. */
export async function handleGetOgrPolicy(c: Context): Promise<Response> {
  const policy = loadOgrPolicy()
  return c.json({
    altitude: 'gateway',
    policyPath: paths.ogrPolicy,
    usingDefault: !existsSync(paths.ogrPolicy),
    detectors: DETECTORS,
    policy,
  })
}
