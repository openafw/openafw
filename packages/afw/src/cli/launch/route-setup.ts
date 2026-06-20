// ensureWireRoute — the firewall-side half of the old `wire()`: register the
// upstream + decoder + captured credentials so the daemon can forward and
// authenticate this agent's traffic. It does NOT touch the agent's own config
// (that's the launcher's per-process job). Idempotent; safe to call every launch.

import type { AgentId } from '../../core/agent.ts'
import type { DecoderKind, RouteEntry } from '../../core/routes.ts'
import { setSecret } from '../../core/secrets.ts'
import {
  type CapturedCredential,
  buildWireSecrets,
  captureClaudeCodeCredentials,
  captureCodexCredentials,
} from '../detect/credentials.ts'
import { detectorFor } from '../detect/index.ts'
import type { PlannedEndpoint } from '../detect/types.ts'
import { upsertRoutes } from '../wire/routes.ts'
import { routeKeyForModel } from '../wire/url.ts'
import { resolveCodexWireProtocol } from './codex-protocol.ts'

// Per-agent credential capture for the launch-per-task agents the launcher
// supports. (Daemon/app agents are configured via `afw model add`.)
const CAPTURE: Record<
  string,
  (endpoints: PlannedEndpoint[]) => Promise<Map<string, CapturedCredential>>
> = {
  'claude-code': () => captureClaudeCodeCredentials(),
  codex: () => captureCodexCredentials(),
}

// Fallback routes when an agent's config isn't present yet (detect() → null):
// enough for the proxy to forward; credentials resolve via agent-OAuth or are
// added later with `afw model add`.
const FALLBACK: Record<string, { upstream: string; decoder: DecoderKind }> = {
  'claude-code': { upstream: 'https://api.anthropic.com', decoder: 'anthropic' },
  codex: { upstream: 'https://api.openai.com/v1', decoder: 'openai-responses' },
}

export async function ensureWireRoute(
  agent: AgentId,
  opts?: { modelOverride?: string },
): Promise<void> {
  const det = detectorFor(agent)
  const detection = det ? await det.detect() : null

  // codex's wire protocol tracks the routed backend (codex-protocol.ts). The
  // route decoder must match the protocol codex actually speaks, or the proxy
  // mis-parses every request — so override the detector's static
  // openai-responses decoder with the resolved one. Same resolver the launcher
  // uses for codex's `wire_api`, so the decoder and wire_api always agree.
  const codexDecoder =
    agent === 'codex' ? (await resolveCodexWireProtocol(opts?.modelOverride)).decoder : undefined

  const routeUpdates: Record<string, RouteEntry> = {}

  if (detection) {
    for (const ep of detection.endpoints) {
      if (!ep.active) continue
      routeUpdates[routeKeyForModel(agent, ep.modelId)] = {
        upstream: ep.upstream,
        decoder: codexDecoder ?? ep.decoder,
        ...(ep.sourceModelId ? { sourceModelId: ep.sourceModelId } : {}),
        ...(ep.harvest ? { harvest: ep.harvest } : {}),
        ...(ep.auth ? { auth: ep.auth } : {}),
      }
    }
    const capture = CAPTURE[agent]
    if (capture) {
      const captured = await capture(detection.endpoints)
      for (const s of buildWireSecrets(agent, detection.endpoints, captured)) {
        await setSecret(s.ref, s.value)
      }
    }
  }

  // No config or no active endpoint → seed a wildcard fallback so the proxy
  // can still forward this agent's traffic.
  if (Object.keys(routeUpdates).length === 0) {
    const fb = FALLBACK[agent]
    if (fb)
      routeUpdates[routeKeyForModel(agent, '*')] = {
        upstream: fb.upstream,
        decoder: codexDecoder ?? fb.decoder,
      }
  }

  if (Object.keys(routeUpdates).length > 0) await upsertRoutes(routeUpdates)
}
