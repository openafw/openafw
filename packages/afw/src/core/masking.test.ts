import { describe, expect, it } from 'vitest'
import {
  BUILTIN_RULES,
  type MaskingConfig,
  compileCustomRule,
  effectiveRules,
  enabledRuleIds,
  enabledRulesForProvider,
  maskCredentials,
  normalizeMaskingConfig,
  ruleCatalog,
} from './masking.ts'

const emptyCfg = (providers: Record<string, string[]> = {}): MaskingConfig => ({
  version: 3,
  providers,
  fakes: {},
  custom: [],
})

const ruleById = (id: string) => {
  const r = BUILTIN_RULES.find((x) => x.id === id)
  if (!r) throw new Error(`no rule ${id}`)
  return r
}

describe('maskCredentials', () => {
  it('swaps an OpenAI key for its fixed fake and records the reverse map', () => {
    const real = 'sk-proj-AbCdEf0123456789AbCdEf0123456789AbCdEf'
    const { masked, restore, hits } = maskCredentials(`key=${real}`, [ruleById('openai-key')])
    expect(masked).not.toContain(real)
    expect(masked).toContain(ruleById('openai-key').fake)
    expect(restore.get(ruleById('openai-key').fake)).toBe(real)
    expect(hits['openai-key']).toBe(1)
  })

  it('round-trips: replacing every fake with its real value restores the input', () => {
    const text = [
      'openai sk-AbCdEf0123456789AbCdEf0123456789AbCdEfGh',
      'anthropic sk-ant-api03-AbCdEf0123456789AbCdEf0123456789',
      `wallet 0x${'a'.repeat(64)}`,
      // assembled so the literal AKID never sits in source (GitHub push protection)
      `aws ${'AKIA'}${'ABCDEFGHIJKLMNOP'}`,
    ].join('\n')
    const { masked, restore } = maskCredentials(text, [...BUILTIN_RULES])
    let restored = masked
    for (const [fake, realValue] of restore) restored = restored.split(fake).join(realValue)
    expect(restored).toBe(text)
  })

  it('does not confuse an anthropic key for an OpenAI key', () => {
    const anth = 'sk-ant-api03-AbCdEf0123456789AbCdEf0123456789'
    const { restore } = maskCredentials(anth, [...BUILTIN_RULES])
    expect(restore.get(ruleById('anthropic-key').fake)).toBe(anth)
    // the OpenAI fake must not appear — its negative lookahead skips sk-ant-
    expect([...restore.keys()]).not.toContain(ruleById('openai-key').fake)
  })

  it('gives distinct real values of the same type distinct fakes', () => {
    const a = 'sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const b = 'sk-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    const { masked, restore } = maskCredentials(`${a} and ${b}`, [ruleById('openai-key')])
    expect(restore.size).toBe(2)
    const fakes = [...restore.keys()]
    expect(new Set(fakes).size).toBe(2)
    for (const f of fakes) expect(masked).toContain(f)
  })

  it('reuses one fake when the same real value appears twice', () => {
    const real = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const { restore, hits } = maskCredentials(`${real} ${real}`, [ruleById('github-pat')])
    expect(restore.size).toBe(1)
    expect(hits['github-pat']).toBe(2)
  })

  it('masks only the token of a group rule, keeping its context', () => {
    const tok = 'AbCdEf0123456789AbCdEf0123456789'
    const { masked, restore } = maskCredentials(`Authorization: Bearer ${tok}`, [
      ruleById('bearer-token'),
    ])
    expect(masked).toBe(`Authorization: Bearer ${ruleById('bearer-token').fake}`)
    expect(restore.get(ruleById('bearer-token').fake)).toBe(tok)
  })

  it('extracts the secret from an aws_secret_access_key assignment', () => {
    // assembled so no 40-char secret literal sits in source (push protection)
    const sk = `${'abcdEFGH1234567890'}${'abcdEFGH1234567890abcd'}`
    const { masked, restore } = maskCredentials(`aws_secret_access_key = "${sk}"`, [
      ruleById('aws-secret-access-key'),
    ])
    expect(masked).not.toContain(sk)
    expect(restore.get(ruleById('aws-secret-access-key').fake)).toBe(sk)
  })

  it('returns the original text and an empty map when nothing matches', () => {
    const { masked, restore } = maskCredentials('nothing secret here', [...BUILTIN_RULES])
    expect(masked).toBe('nothing secret here')
    expect(restore.size).toBe(0)
  })

  it('does not re-mask a fake it just inserted', () => {
    // The OpenAI fake itself matches the OpenAI pattern shape; a second rule
    // pass must not pick it up.
    const real = 'sk-AbCdEf0123456789AbCdEf0123456789AbCdEfGh'
    const { restore } = maskCredentials(real, [...BUILTIN_RULES])
    // exactly one mapping, and the value is the real key (not a fake)
    expect(restore.size).toBe(1)
    expect([...restore.values()][0]).toBe(real)
  })
})

describe('config (per-provider, default off)', () => {
  it('normalizes unknown/garbage/old-version into the all-off default', () => {
    expect(normalizeMaskingConfig(null).providers).toEqual({})
    expect(
      normalizeMaskingConfig({ version: 2, providers: { x: ['openai-key'] } }).providers,
    ).toEqual({})
    expect(
      normalizeMaskingConfig({ version: 3, providers: { 'og-coding': ['bogus', 'openai-key'] } })
        .providers,
    ).toEqual({ 'og-coding': ['openai-key'] })
  })

  it('drops a provider whose enabled list is empty', () => {
    expect(
      normalizeMaskingConfig({ version: 3, providers: { 'og-coding': [] } }).providers,
    ).toEqual({})
  })

  it('masks nothing for a provider with no config (opt-in default)', () => {
    const cfg = emptyCfg()
    expect(enabledRuleIds(cfg, 'og-coding')).toEqual([])
    expect(enabledRulesForProvider(cfg, 'og-coding')).toEqual([])
  })

  it('enabledRulesForProvider returns only the rules enabled for that provider', () => {
    const cfg = emptyCfg({ 'og-coding': ['openai-key', 'eth-private-key'] })
    const ids = enabledRulesForProvider(cfg, 'og-coding').map((r) => r.id)
    expect(ids.sort()).toEqual(['eth-private-key', 'openai-key'])
    // a different provider stays off
    expect(enabledRulesForProvider(cfg, 'Qwen3.6')).toEqual([])
  })

  it('ruleCatalog lists every built-in rule with its fake', () => {
    const rows = ruleCatalog(emptyCfg())
    expect(rows).toHaveLength(BUILTIN_RULES.length)
    expect(rows.find((r) => r.id === 'openai-key')).toMatchObject({
      id: 'openai-key',
      custom: false,
    })
  })
})

describe('fake overrides + custom rules', () => {
  it('applies a fake override in effectiveRules and the catalog', () => {
    const cfg: MaskingConfig = { ...emptyCfg(), fakes: { 'openai-key': 'sk-MY-OWN-FAKE-123456' } }
    const rule = effectiveRules(cfg).find((r) => r.id === 'openai-key')
    expect(rule?.fake).toBe('sk-MY-OWN-FAKE-123456')
    const realKey = 'sk-AbCdEf0123456789AbCdEf0123456789AbCdEfGh'
    const { restore } = maskCredentials(realKey, [rule!])
    expect(restore.get('sk-MY-OWN-FAKE-123456')).toBe(realKey)
  })

  it('compiles a custom rule and uses it in effectiveRules', () => {
    const cfg: MaskingConfig = {
      ...emptyCfg(),
      custom: [
        { id: 'internal-token', label: 'Internal', pattern: 'INT-[0-9]{8}', fake: 'INT-00000000' },
      ],
    }
    const rule = effectiveRules(cfg).find((r) => r.id === 'internal-token')
    expect(rule).toBeDefined()
    const { masked, restore } = maskCredentials('token INT-12345678 end', effectiveRules(cfg))
    expect(masked).toBe('token INT-00000000 end')
    expect(restore.get('INT-00000000')).toBe('INT-12345678')
  })

  it('supports regex capture replacements for custom rewrite-style rules', () => {
    const cfg: MaskingConfig = {
      ...emptyCfg(),
      custom: [
        {
          id: 'normalize-date',
          label: 'Normalize date',
          pattern: "Today[^A-Za-z0-9]*s date is (\\d{4})/(\\d{2})/(\\d{2})",
          fake: "Today's date is $1-$2-$3",
        },
      ],
    }
    const { masked, restore, hits } = maskCredentials(
      "Today\u2019s date is 2026/06/30.",
      effectiveRules(cfg),
    )
    expect(masked).toBe("Today's date is 2026-06-30.")
    expect(restore.size).toBe(0)
    expect(hits['normalize-date']).toBe(1)
  })

  it('rejects a custom rule with a bad regex or a built-in id collision', () => {
    expect(compileCustomRule({ id: 'x', label: 'x', pattern: '([', fake: 'F' })).toBeNull()
    expect(
      compileCustomRule({ id: 'openai-key', label: 'x', pattern: 'foo', fake: 'F' }),
    ).toBeNull()
  })
})
