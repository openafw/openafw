import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { type ParseError, parse as parseJsonc } from 'jsonc-parser'
import { atomicWrite } from '../../core/atomic-file.ts'
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

// ── approval gate ──────────────────────────────────────────────────
//
// `~/.afw/ogr.policy.json` is the LIVE, human-approved policy that enforces
// (what loadOgrPolicy reads). Edits never touch it directly: they stage a
// PROPOSAL in `ogr.policy.proposed.json`, which a human promotes with
// `afw ogr approve`. Per OGR's non-negotiable rule, an agent may draft and
// propose but may not enforce a policy the operator has not approved.

/** Read the staged proposal, or undefined when none is pending. */
export function readProposed(): OgrPolicy | undefined {
  if (!existsSync(paths.ogrProposed)) return undefined
  try {
    const errors: ParseError[] = []
    const parsed = parseJsonc(readFileSync(paths.ogrProposed, 'utf8'), errors, {
      allowTrailingComma: true,
    })
    if (errors.length > 0) return undefined
    return normalizePolicy(parsed)
  } catch {
    return undefined
  }
}

export function hasPendingProposal(): boolean {
  return existsSync(paths.ogrProposed)
}

export type PolicyStatus = {
  live: OgrPolicy
  proposed?: OgrPolicy
  usingDefault: boolean
  pending: boolean
}

export function getPolicyStatus(): PolicyStatus {
  const proposed = readProposed()
  return {
    live: loadOgrPolicy(),
    ...(proposed ? { proposed } : {}),
    usingDefault: !existsSync(paths.ogrPolicy),
    pending: proposed !== undefined,
  }
}

/** The base an edit builds on: the pending proposal if any, else the live
 *  policy. Always a deep copy, so the shared DEFAULT_POLICY is never mutated. */
function workingPolicy(): OgrPolicy {
  return structuredClone(readProposed() ?? loadOgrPolicy())
}

/** Stage a full policy as the pending proposal (does not enforce it). */
export async function proposePolicy(policy: OgrPolicy): Promise<OgrPolicy> {
  await atomicWrite(paths.ogrProposed, `${JSON.stringify(toCanonical(policy), null, 2)}\n`)
  return policy
}

/** Promote the pending proposal to the live policy (the human approval step).
 *  Returns the now-live policy, or throws when nothing is pending. */
export async function approveProposal(): Promise<OgrPolicy> {
  const proposed = readProposed()
  if (!proposed) throw new Error('no pending proposal to approve')
  await atomicWrite(paths.ogrPolicy, `${JSON.stringify(toCanonical(proposed), null, 2)}\n`)
  await rm(paths.ogrProposed, { force: true })
  resetOgrPolicyCache()
  return proposed
}

/** Discard the pending proposal, leaving the live policy untouched. */
export async function rejectProposal(): Promise<void> {
  await rm(paths.ogrProposed, { force: true })
}

/** Serialize an internal policy to the canonical OGR snake_case file shape, so a
 *  UI write and a hand-edit stay in the same format. */
export function toCanonical(p: OgrPolicy): Record<string, unknown> {
  return {
    composition: Object.fromEntries(
      Object.entries(p.composition).map(([cat, r]) => [
        cat,
        {
          strategy: r.strategy,
          ...(r.quorum ? { quorum: { count: r.quorum.count, min_score: r.quorum.minScore } } : {}),
          ...(r.onAllFailed ? { on_all_failed: r.onAllFailed } : {}),
        },
      ]),
    ),
    content_rules: {
      redact_secrets: p.contentRules.redactSecrets,
      injection_from_untrusted: p.contentRules.injectionFromUntrusted,
      injection_from_unverified: p.contentRules.injectionFromUnverified,
    },
    config_rules: {
      ...(p.configRules.secretEnvMarkers
        ? { secret_env_markers: p.configRules.secretEnvMarkers }
        : {}),
      command_rules: p.configRules.commandRules,
    },
  }
}

// The mutators stage a PROPOSAL (build on the working copy, write the proposed
// file) — they never change what is enforced. Approval is the separate
// `approveProposal` step. Each returns the new proposed policy.

export async function patchContentRules(patch: Partial<ContentRules>): Promise<OgrPolicy> {
  const p = workingPolicy()
  p.contentRules = { ...p.contentRules, ...patch }
  return proposePolicy(p)
}

/** Add a command rule, or replace the one with the same id. */
export async function upsertCommandRule(rule: CommandRule): Promise<OgrPolicy> {
  const p = workingPolicy()
  const i = p.configRules.commandRules.findIndex((r) => r.id === rule.id)
  if (i >= 0) p.configRules.commandRules[i] = rule
  else p.configRules.commandRules.push(rule)
  return proposePolicy(p)
}

export async function removeCommandRule(id: string): Promise<OgrPolicy> {
  const p = workingPolicy()
  p.configRules.commandRules = p.configRules.commandRules.filter((r) => r.id !== id)
  return proposePolicy(p)
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
