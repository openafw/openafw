import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, normalizePolicy, toCanonical } from './policy.ts'

describe('normalizePolicy', () => {
  it('reads the canonical OGR snake_case shape (openguardrails.com policy.template.json)', () => {
    const p = normalizePolicy({
      composition: {
        'security.*': { strategy: 'deny-wins', on_all_failed: 'block' },
        'safety.toxicity': { strategy: 'quorum', quorum: { count: 2, min_score: 0.8 } },
      },
      content_rules: {
        redact_secrets: false,
        injection_from_untrusted: 'block',
        injection_from_unverified: 'require_approval',
      },
      config_rules: {
        secret_env_markers: ['TOKEN'],
        command_rules: [
          {
            id: 'rm-rf-root',
            regex: 'rm\\s+-rf\\s+/',
            category: 'security.malicious_command',
            domain: 'security',
            decision: 'block',
            score: 1.0,
            why: 'destructive delete',
          },
        ],
      },
    })

    expect(p.contentRules.redactSecrets).toBe(false)
    expect(p.contentRules.injectionFromUnverified).toBe('require_approval')
    expect(p.composition['security.*']?.onAllFailed).toBe('block')
    expect(p.composition['safety.toxicity']?.quorum).toEqual({ count: 2, minScore: 0.8 })
    expect(p.configRules.secretEnvMarkers).toEqual(['TOKEN'])
    expect(p.configRules.commandRules[0]?.id).toBe('rm-rf-root')
  })

  it('also accepts camelCase keys', () => {
    const p = normalizePolicy({
      content_rules: { redact_secrets: true, injection_from_untrusted: 'modify' },
      configRules: { commandRules: [] },
    })
    expect(p.contentRules.injectionFromUntrusted).toBe('modify')
    expect(p.configRules.commandRules).toEqual([])
  })

  it('fills omitted slots from the default', () => {
    const p = normalizePolicy({ content_rules: { redact_secrets: false } })
    expect(p.contentRules.redactSecrets).toBe(false)
    // untouched slots fall back to default
    expect(p.contentRules.injectionFromUntrusted).toBe(
      DEFAULT_POLICY.contentRules.injectionFromUntrusted,
    )
    expect(p.configRules.commandRules).toEqual(DEFAULT_POLICY.configRules.commandRules)
  })

  it('drops malformed command rules (bad/absent decision or regex)', () => {
    const p = normalizePolicy({
      config_rules: {
        command_rules: [
          { id: 'ok', regex: 'x', decision: 'block' },
          { id: 'bad-decision', regex: 'y', decision: 'nope' },
          { id: 'no-regex', decision: 'block' },
        ],
      },
    })
    expect(p.configRules.commandRules.map((r) => r.id)).toEqual(['ok'])
  })

  it('falls back to the default on a non-object', () => {
    expect(normalizePolicy(null)).toBe(DEFAULT_POLICY)
    expect(normalizePolicy('nope')).toBe(DEFAULT_POLICY)
  })
})

describe('toCanonical', () => {
  it('emits canonical snake_case that round-trips back through normalizePolicy', () => {
    const canonical = toCanonical(DEFAULT_POLICY)
    // snake_case on the wire
    expect(canonical).toHaveProperty('content_rules')
    expect(canonical).toHaveProperty('config_rules')
    expect((canonical as { content_rules: Record<string, unknown> }).content_rules).toHaveProperty(
      'injection_from_untrusted',
    )
    // and it parses back to the same internal policy
    expect(normalizePolicy(canonical)).toEqual(DEFAULT_POLICY)
  })

  it('round-trips quorum min_score and on_all_failed', () => {
    const p = normalizePolicy({
      composition: {
        'safety.toxicity': { strategy: 'quorum', quorum: { count: 2, min_score: 0.8 } },
      },
    })
    expect(normalizePolicy(toCanonical(p))).toEqual(p)
  })
})
