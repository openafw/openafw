import { existsSync } from 'node:fs'
import type { Context } from 'hono'
import { paths } from '../../core/paths.ts'
import {
  type CommandRule,
  type ContentRules,
  type OgrPolicy,
  loadOgrPolicy,
  patchContentRules,
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

function buildResponse(policy: OgrPolicy) {
  return {
    altitude: 'gateway',
    policyPath: paths.ogrPolicy,
    usingDefault: !existsSync(paths.ogrPolicy),
    decisions: DECISIONS,
    detectors: DETECTORS,
    policy,
  }
}

/** GET /api/ogr/policy — the effective OGR gateway policy (composition +
 *  content/config rules) and the composed detectors. */
export async function handleGetOgrPolicy(c: Context): Promise<Response> {
  return c.json(buildResponse(loadOgrPolicy()))
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
  return c.json(buildResponse(await patchContentRules(patch)))
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
  return c.json(buildResponse(await upsertCommandRule(rule)))
}

/** DELETE /api/ogr/command-rule?id=… — remove a command rule. */
export async function handleDeleteOgrCommandRule(c: Context): Promise<Response> {
  const id = c.req.query('id')
  if (!id) return c.json({ error: 'ogr: missing id' }, 400)
  return c.json(buildResponse(await removeCommandRule(id)))
}
