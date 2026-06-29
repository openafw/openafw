import { readFileSync } from 'node:fs'
import { type ParseError, parse as parseJsonc } from 'jsonc-parser'
import { logger } from '../../core/logger.ts'
import { paths } from '../../core/paths.ts'
import type { Decision } from './types.ts'

// The deployer-owned OGR gateway policy: how vendor verdicts compose, and what
// each reference detector enforces. The SAME policy model is used at the
// agent-hook and sandbox altitudes; only the bindings differ.
//
// On disk the file is the canonical OGR snake_case shape (composition /
// content_rules / config_rules), so a user can copy openguardrails.com/skill's
// policy.template.json verbatim. We normalize it into these camelCase internal
// types on read (camelCase keys are also accepted as a fallback).

export type CompositionRule = {
  strategy: 'deny-wins' | 'quorum'
  quorum?: { count: number; minScore: number }
  onAllFailed?: Decision
}

export type CommandRule = {
  id: string
  regex: string
  category: string
  domain: 'safety' | 'security'
  decision: Decision
  score: number
  why: string
}

export type ContentRules = {
  redactSecrets: boolean
  injectionFromUntrusted: Decision
  injectionFromUnverified: Decision
}

export type ConfigRules = {
  secretEnvMarkers?: string[]
  commandRules: CommandRule[]
}

export type OgrPolicy = {
  composition: Record<string, CompositionRule>
  contentRules: ContentRules
  configRules: ConfigRules
}

export const DEFAULT_POLICY: OgrPolicy = {
  composition: {
    'security.*': { strategy: 'deny-wins', onAllFailed: 'block' },
    'safety.*': { strategy: 'deny-wins', onAllFailed: 'allow' },
    default: { strategy: 'deny-wins' },
  },
  contentRules: {
    redactSecrets: true,
    injectionFromUntrusted: 'block',
    injectionFromUnverified: 'require_approval',
  },
  configRules: {
    secretEnvMarkers: ['SECRET', 'TOKEN', 'AWS_', 'PASSWORD', 'PRIVATE_KEY'],
    commandRules: [
      {
        id: 'pipe-to-shell',
        regex: '(curl|wget)\\b.*\\|\\s*(ba)?sh',
        category: 'security.malicious_command',
        domain: 'security',
        decision: 'require_approval',
        score: 0.85,
        why: 'remote script fetched and piped directly into a shell',
      },
      {
        id: 'rm-rf-root',
        regex: 'rm\\s+-rf\\s+/(\\s|$)',
        category: 'security.malicious_command',
        domain: 'security',
        decision: 'block',
        score: 1.0,
        why: 'destructive recursive delete of filesystem root',
      },
      {
        id: 'secret-file-access',
        regex: '(\\.env\\b|/\\.aws/credentials|/\\.ssh/id_|auth\\.json)',
        category: 'security.secret_leak',
        domain: 'security',
        decision: 'block',
        score: 0.95,
        why: 'command references a credential file — independent of the reader',
      },
    ],
  },
}

let cached: OgrPolicy | undefined

/** Load `~/.afw/ogr.policy.json` (JSONC), falling back to the bundled default
 *  on absence or any parse error. Cached after first read. */
export function loadOgrPolicy(): OgrPolicy {
  if (cached) return cached
  cached = readPolicy()
  return cached
}

/** Drop the cache so the next load re-reads from disk (used by the watcher). */
export function resetOgrPolicyCache(): void {
  cached = undefined
}

function readPolicy(): OgrPolicy {
  let raw: string
  try {
    raw = readFileSync(paths.ogrPolicy, 'utf8')
  } catch {
    return DEFAULT_POLICY
  }
  const errors: ParseError[] = []
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true })
  if (errors.length > 0 || parsed == null || typeof parsed !== 'object') {
    logger.warn(`ogr: ${paths.ogrPolicy} is unparseable; using the default policy`)
    return DEFAULT_POLICY
  }
  return normalizePolicy(parsed)
}

type Raw = Record<string, unknown>

// Read either the canonical OGR snake_case key or its camelCase alias.
function pick(o: Raw, snake: string, camel: string): unknown {
  return o[snake] ?? o[camel]
}

/** Map a parsed policy object (canonical snake_case, or camelCase) into the
 *  internal OgrPolicy, filling any slot the file omits from the default so a
 *  partial policy never silently drops a detector. Exported for testing. */
export function normalizePolicy(parsed: unknown): OgrPolicy {
  if (parsed == null || typeof parsed !== 'object') return DEFAULT_POLICY
  const p = parsed as Raw

  const composition = asObject(p.composition)
  const content = asObject(pick(p, 'content_rules', 'contentRules'))
  const config = asObject(pick(p, 'config_rules', 'configRules'))

  return {
    composition: composition ? normalizeComposition(composition) : DEFAULT_POLICY.composition,
    contentRules: content
      ? {
          redactSecrets:
            asBool(pick(content, 'redact_secrets', 'redactSecrets')) ??
            DEFAULT_POLICY.contentRules.redactSecrets,
          injectionFromUntrusted:
            asDecision(pick(content, 'injection_from_untrusted', 'injectionFromUntrusted')) ??
            DEFAULT_POLICY.contentRules.injectionFromUntrusted,
          injectionFromUnverified:
            asDecision(pick(content, 'injection_from_unverified', 'injectionFromUnverified')) ??
            DEFAULT_POLICY.contentRules.injectionFromUnverified,
        }
      : DEFAULT_POLICY.contentRules,
    configRules: config
      ? {
          secretEnvMarkers:
            asStringArray(pick(config, 'secret_env_markers', 'secretEnvMarkers')) ??
            DEFAULT_POLICY.configRules.secretEnvMarkers,
          commandRules:
            normalizeCommandRules(pick(config, 'command_rules', 'commandRules')) ??
            DEFAULT_POLICY.configRules.commandRules,
        }
      : DEFAULT_POLICY.configRules,
  }
}

function normalizeComposition(o: Raw): Record<string, CompositionRule> {
  const out: Record<string, CompositionRule> = {}
  for (const [key, v] of Object.entries(o)) {
    const r = asObject(v)
    if (!r) continue
    const quorum = asObject(r.quorum)
    out[key] = {
      strategy: r.strategy === 'quorum' ? 'quorum' : 'deny-wins',
      ...(quorum
        ? {
            quorum: {
              count: Number(quorum.count) || 0,
              minScore: Number(pick(quorum, 'min_score', 'minScore')) || 0,
            },
          }
        : {}),
      ...(asDecision(pick(r, 'on_all_failed', 'onAllFailed'))
        ? { onAllFailed: asDecision(pick(r, 'on_all_failed', 'onAllFailed')) }
        : {}),
    }
  }
  return out
}

// command_rules field names are single-word in both styles (id/regex/category/
// domain/decision/score/why) — pass through the well-formed entries.
function normalizeCommandRules(v: unknown): CommandRule[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: CommandRule[] = []
  for (const item of v) {
    const r = asObject(item)
    const decision = asDecision(r?.decision)
    if (!r || typeof r.regex !== 'string' || !decision) continue
    out.push({
      id: typeof r.id === 'string' ? r.id : r.regex,
      regex: r.regex,
      category: typeof r.category === 'string' ? r.category : 'security.unspecified',
      domain: r.domain === 'safety' ? 'safety' : 'security',
      decision,
      score: Number(r.score) || 0,
      why: typeof r.why === 'string' ? r.why : '',
    })
  }
  return out
}

const DECISIONS: readonly Decision[] = ['allow', 'modify', 'redact', 'require_approval', 'block']

function asObject(v: unknown): Raw | undefined {
  return v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : undefined
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}
function asDecision(v: unknown): Decision | undefined {
  return typeof v === 'string' && (DECISIONS as readonly string[]).includes(v)
    ? (v as Decision)
    : undefined
}
function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined
}
