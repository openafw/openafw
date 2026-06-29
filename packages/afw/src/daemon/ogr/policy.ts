import { readFileSync } from 'node:fs'
import { type ParseError, parse as parseJsonc } from 'jsonc-parser'
import { logger } from '../../core/logger.ts'
import { paths } from '../../core/paths.ts'
import type { Decision } from './types.ts'

// The deployer-owned OGR gateway policy: how vendor verdicts compose, and what
// each reference detector enforces. The SAME policy model is used at the
// agent-hook and sandbox altitudes; only the bindings differ. Mirrors the
// reference gateway's policy.json.

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
  return mergeWithDefault(parsed as Partial<OgrPolicy>)
}

// A user file may set only the slots it cares about; fill the rest from default
// so a partial policy never drops a detector.
function mergeWithDefault(p: Partial<OgrPolicy>): OgrPolicy {
  return {
    composition: p.composition ?? DEFAULT_POLICY.composition,
    contentRules: { ...DEFAULT_POLICY.contentRules, ...(p.contentRules ?? {}) },
    configRules: {
      secretEnvMarkers:
        p.configRules?.secretEnvMarkers ?? DEFAULT_POLICY.configRules.secretEnvMarkers,
      commandRules: p.configRules?.commandRules ?? DEFAULT_POLICY.configRules.commandRules,
    },
  }
}
