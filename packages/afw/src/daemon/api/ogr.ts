import type { Context } from 'hono'
import { paths } from '../../core/paths.ts'
import {
  type CommandRule,
  type ContentRules,
  approveProposal,
  getPolicyStatus,
  patchContentRules,
  rejectProposal,
  removeCommandRule,
  upsertCommandRule,
} from '../ogr/policy.ts'
import type { Decision } from '../ogr/types.ts'

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

const DECISIONS: readonly Decision[] = ['allow', 'modify', 'redact', 'require_approval', 'block']
const isDecision = (v: unknown): v is Decision =>
  typeof v === 'string' && (DECISIONS as readonly string[]).includes(v)

function buildResponse() {
  const status = getPolicyStatus()
  return {
    altitude: 'gateway',
    policyPath: paths.ogrPolicy,
    proposedPath: paths.ogrProposed,
    usingDefault: status.usingDefault,
    pending: status.pending,
    decisions: DECISIONS,
    detectors: DETECTORS,
    // `policy` is the LIVE (enforced) policy; `proposed` is the staged, not-yet-
    // approved edit (null when none is pending).
    policy: status.live,
    proposed: status.proposed ?? null,
  }
}

/** GET /api/ogr/policy — the live (enforced) policy, the composed detectors, and
 *  any pending proposal awaiting approval. */
export async function handleGetOgrPolicy(c: Context): Promise<Response> {
  return c.json(buildResponse())
}

/** POST /api/ogr/content — patch the content-rule decisions. The operator (a
 *  human) edits the policy here; per OGR's gate it is the AGENT, not the
 *  operator, that may not silently change a live policy. */
export async function handlePostOgrContent(c: Context): Promise<Response> {
  const b = (await c.req.json().catch(() => ({}))) as Partial<{
    redactSecrets: unknown
    injectionFromUntrusted: unknown
    injectionFromUnverified: unknown
  }>
  const patch: Partial<ContentRules> = {}
  if (b.redactSecrets !== undefined) {
    if (typeof b.redactSecrets !== 'boolean') {
      return c.json({ error: 'ogr: redactSecrets must be a boolean' }, 400)
    }
    patch.redactSecrets = b.redactSecrets
  }
  if (b.injectionFromUntrusted !== undefined) {
    if (!isDecision(b.injectionFromUntrusted)) {
      return c.json(
        { error: `ogr: injectionFromUntrusted must be one of ${DECISIONS.join(', ')}` },
        400,
      )
    }
    patch.injectionFromUntrusted = b.injectionFromUntrusted
  }
  if (b.injectionFromUnverified !== undefined) {
    if (!isDecision(b.injectionFromUnverified)) {
      return c.json(
        { error: `ogr: injectionFromUnverified must be one of ${DECISIONS.join(', ')}` },
        400,
      )
    }
    patch.injectionFromUnverified = b.injectionFromUnverified
  }
  await patchContentRules(patch)
  return c.json(buildResponse())
}

/** POST /api/ogr/command-rule — add or replace a command rule (by id). */
export async function handlePostOgrCommandRule(c: Context): Promise<Response> {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  if (typeof b.regex !== 'string' || b.regex.length === 0) {
    return c.json({ error: 'ogr: a non-empty regex is required' }, 400)
  }
  try {
    new RegExp(b.regex)
  } catch {
    return c.json({ error: 'ogr: regex does not compile' }, 400)
  }
  if (!isDecision(b.decision)) {
    return c.json({ error: `ogr: decision must be one of ${DECISIONS.join(', ')}` }, 400)
  }
  const rule: CommandRule = {
    id: typeof b.id === 'string' && b.id ? b.id : b.regex,
    regex: b.regex,
    category: typeof b.category === 'string' && b.category ? b.category : 'security.unspecified',
    domain: b.domain === 'safety' ? 'safety' : 'security',
    decision: b.decision,
    score: typeof b.score === 'number' && b.score >= 0 && b.score <= 1 ? b.score : 0.5,
    why: typeof b.why === 'string' ? b.why : '',
  }
  await upsertCommandRule(rule)
  return c.json(buildResponse())
}

/** DELETE /api/ogr/command-rule?id=… — remove a command rule. */
export async function handleDeleteOgrCommandRule(c: Context): Promise<Response> {
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'ogr: missing id' }, 400)
  await removeCommandRule(id)
  return c.json(buildResponse())
}

/** POST /api/ogr/approve — promote the pending proposal to the live policy. The
 *  dashboard operator (a human) approves here; the agent reaches afw only on the
 *  wire, not this control API. */
export async function handlePostOgrApprove(c: Context): Promise<Response> {
  try {
    await approveProposal()
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400)
  }
  return c.json(buildResponse())
}

/** POST /api/ogr/reject — discard the pending proposal. */
export async function handlePostOgrReject(c: Context): Promise<Response> {
  await rejectProposal()
  return c.json(buildResponse())
}
