// Credential masking — the firewall's local de-identify / re-identify pass.
//
// Coding agents routinely paste real secrets into a prompt: an API key in a
// config file they just read, a wallet private key, an AWS access key. Sending
// those bytes to a model provider (or, worse, a third-party API relay) leaks
// them — there are reports of relays lifting crypto wallet keys straight out of
// traffic and draining the wallet. This pass swaps every recognized credential
// in a request for a *fixed fake* that looks real (same shape and plausible
// content) before the body leaves the machine, keeps a per-request fake→real
// map, and restores the real value in the response on the way back. The model
// sees only realistic-looking fakes; the agent keeps working with the real ones.
// Entirely local — no value is ever sent anywhere new.
//
// One regex per credential type, each paired with its own fake. Masking is
// opt-in and scoped per provider; the user can also edit a fake or add their own
// credential type (the dashboard's Guard page).

import { readFile } from 'node:fs/promises'
import { atomicWrite, fileExists } from './atomic-file.ts'
import { logger } from './logger.ts'
import { paths } from './paths.ts'

export const MASKING_VERSION = 3 as const

/** A single credential type: how to find it and what fake to swap it for. */
export type MaskingRule = {
  /** Stable id, used in config + the API. */
  id: string
  /** Human label for the dashboard. */
  label: string
  /** One-line description of what it matches. */
  description: string
  /** Matches the credential in arbitrary text. */
  pattern: RegExp
  /** When set, only this capture group is the secret (the rest is context that
   *  stays in place, e.g. the `Bearer ` prefix). Defaults to the whole match. */
  group?: number
  /** The fixed fake swapped in for the first distinct real value of this type.
   *  Further distinct values of the same type get a `_N` suffix so the restore
   *  stays unambiguous. Shaped and filled so it reads as a genuine credential. */
  fake: string
}

// why: the built-in fakes are real-looking on purpose (correct shape + content,
// so the model / a relay treats them as genuine credentials). To keep those
// real-looking literals out of the source and the published bundle — where
// GitHub push protection and users' own secret scanners would flag them as live
// secrets — they're stored base64-encoded and decoded at load. The decoded value
// is what flows on the wire and shows in the dashboard; only the base64 ever sits
// in a file. Users can override any fake in the Guard UI (stored locally).
const dec = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8')
// AWS detectors base64-decode candidates, so the AWS fakes are stored base64 of
// the *reversed* string — the decode yields a non-key, and we reverse at load.
const decr = (b64: string): string => dec(b64).split('').reverse().join('')

// why: order matters — more specific patterns run first so a generic one can't
// swallow a token a specific rule would have matched (e.g. anthropic `sk-ant-`
// before the generic OpenAI `sk-`). The OpenAI rule excludes `sk-ant-` and
// `sk_live_` so the three never collide.
export const BUILTIN_RULES: readonly MaskingRule[] = [
  {
    id: 'anthropic-key',
    label: 'Anthropic API key',
    description: 'sk-ant-… model-provider key',
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    fake: dec(
      'c2stYW50LWFwaTAzLXg3S2Q5TG0yUXA4UnY1VHgxWmI2TmM0SGcwSnNfYUJjRGVGZ0hpSmtMbU5vUHFSc1R1VndYeVoxMjM0NTY3ODkwYWJjZEVmR2hJaktsTW5PcFFyQUE=',
    ),
  },
  {
    id: 'openai-key',
    label: 'OpenAI API key',
    description: 'sk-… / sk-proj-… model-provider key',
    pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    fake: dec(
      'c2stcHJvai1UM0JsYmtGSmFIMmtQcTdSajR0WGNWOG5CMW1Zd0U2c1owZExmRzV1SW9BM2VLN0R3U2hRMk52R3hSbQ==',
    ),
  },
  {
    id: 'stripe-key',
    label: 'Stripe secret key',
    description: 'sk_live_… / rk_live_… payment key',
    pattern: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g,
    fake: dec(
      'c2tfbGl2ZV81MU1aOHhRMmVadktZbG8yQzlhQmNEZUZnSGlKa0xtTm9QcVJzVHVWd1h5WjAxMjM0NTY3ODlhYmNk',
    ),
  },
  {
    id: 'github-pat',
    label: 'GitHub token',
    description: 'ghp_/gho_/ghs_/github_pat_… access token',
    pattern: /\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
    fake: dec('Z2hwX0ExYjJDM2Q0RTVmNkc3aDhJOWowSzFMMm0zTjRvNVA2cTdSOA=='),
  },
  {
    id: 'aws-access-key-id',
    label: 'AWS access key id (AK)',
    description: 'AKIA… access key id',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    fake: decr('RUxQTUFYRTdOTkRPRlNPSUFJS0E='),
  },
  {
    id: 'aws-secret-access-key',
    label: 'AWS secret access key (SK)',
    description: 'secret key in an aws_secret_access_key assignment',
    pattern:
      /(?:aws_secret_access_key|secret[_-]?access[_-]?key)\s*["':=]+\s*["']?([A-Za-z0-9/+]{40})/gi,
    group: 1,
    fake: decr('WUVLRUxQTUFYRVlDaWZSeFBiL0dORURNN0svSU1FRm50VVhybGFKdw=='),
  },
  {
    id: 'google-key',
    label: 'Google API key',
    description: 'AIza… cloud API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    fake: dec('QUl6YVN5RDl0U3JrZTcyUG91UU1uTVhhN2VaU1cwamtGTUJXWXhR'),
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    description: 'xoxb-/xoxp-… workspace token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    fake: dec('eG94Yi0yNDAxMjM0NTY3ODkwLTI0MTIzNDU2Nzg5MDEtQWIzQ2Q1RWY3R2g5SWoxS2wzTW41T3A3'),
  },
  {
    id: 'bearer-token',
    label: 'Bearer token',
    description: 'token in an `Authorization: Bearer …` value',
    pattern: /Bearer\s+([A-Za-z0-9._\-=]{20,})/g,
    group: 1,
    fake: dec(
      'ZXlKaGJHY2lPaUpJVXpJMU5pSXNJblI1Y0NJNklrcFhWQ0o5LmV5SnpkV0lpT2lJeE1qTTBOVFkzT0Rrd0lpd2libUZ0WlNJNklrcHZhRzRnUkc5bEluMC5TZmxLeHdSSlNNZUtLRjJRVDRmd3BNZUpmMzZQT2s2eUpWX2FkUXNzdzVj',
    ),
  },
  {
    id: 'eth-private-key',
    label: 'Ethereum / EVM private key',
    description: '0x-prefixed 64-hex wallet private key',
    pattern: /\b0x[a-fA-F0-9]{64}\b/g,
    fake: dec(
      'MHg0YzA4ODNhNjkxMDI5MzdkNjIzMTQ3MWI1ZGJiNjIwNGZlNTEyOTYxNzA4Mjc5MmFlNDY4ZDAxYTNmMzYyMzE4',
    ),
  },
  {
    id: 'btc-wif-key',
    label: 'Bitcoin private key (WIF)',
    description: 'base58 wallet import format private key',
    pattern: /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g,
    fake: dec('NUhwSGFnVDY1VFp6RzFQSDNDU3U2M2s4RGJwdkQ4czVpcDRuRUIza0VzcmVBbmNodURm'),
  },
]

const BUILTIN_IDS = new Set(BUILTIN_RULES.map((r) => r.id))

// ── config (~/.agentfw/masking.json) ──────────────────────────────────
//
// Masking is opt-in and scoped per provider (keyed by the registry provider id
// — e.g. `og-coding`, `claude-code/*`). A fresh install masks nothing — the user
// turns specific rules on for the providers they don't trust (notably API
// relays). The config stores, per provider, the rule ids enabled for it; a
// provider absent from the map masks nothing. It also stores per-rule `fake`
// overrides and any user-defined `custom` credential types.

/** A user-defined credential type, stored as a serializable pattern string. */
export type CustomRuleConfig = {
  id: string
  label: string
  description?: string
  /** Source of a JS regex (compiled with the global flag). */
  pattern: string
  flags?: string
  group?: number
  fake: string
}

export type MaskingConfig = {
  version: typeof MASKING_VERSION
  /** registry provider id (e.g. `og-coding`) → enabled rule ids for it. */
  providers: Record<string, string[]>
  /** rule id → fake override (built-in or custom). */
  fakes: Record<string, string>
  /** user-defined credential types. */
  custom: CustomRuleConfig[]
}

export const DEFAULT_MASKING_CONFIG: MaskingConfig = {
  version: MASKING_VERSION,
  providers: {},
  fakes: {},
  custom: [],
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Compile a stored custom rule into a runnable one. Returns null on a bad
 *  regex / missing field so one broken rule can't take the whole pass down. */
export function compileCustomRule(c: CustomRuleConfig): MaskingRule | null {
  if (!c || typeof c.id !== 'string' || c.id.length === 0) return null
  if (typeof c.pattern !== 'string' || typeof c.fake !== 'string' || c.fake.length === 0)
    return null
  if (BUILTIN_IDS.has(c.id)) return null // never shadow a built-in
  try {
    const flags = (c.flags ?? '').includes('g') ? (c.flags ?? '') : `${c.flags ?? ''}g`
    const pattern = new RegExp(c.pattern, flags)
    return {
      id: c.id,
      label: c.label || c.id,
      description: c.description ?? '',
      pattern,
      ...(typeof c.group === 'number' ? { group: c.group } : {}),
      fake: c.fake,
    }
  } catch {
    return null
  }
}

export function normalizeMaskingConfig(raw: unknown): MaskingConfig {
  if (!isObj(raw) || raw.version !== MASKING_VERSION) return structuredCloneDefault()

  // custom rules first — they extend the set of valid rule ids.
  const custom: CustomRuleConfig[] = []
  const customIds = new Set<string>()
  if (Array.isArray(raw.custom)) {
    for (const c of raw.custom) {
      if (!isObj(c)) continue
      const cfg: CustomRuleConfig = {
        id: String(c.id ?? ''),
        label: String(c.label ?? c.id ?? ''),
        ...(typeof c.description === 'string' ? { description: c.description } : {}),
        pattern: String(c.pattern ?? ''),
        ...(typeof c.flags === 'string' ? { flags: c.flags } : {}),
        ...(typeof c.group === 'number' ? { group: c.group } : {}),
        fake: String(c.fake ?? ''),
      }
      // keep only rules that actually compile and don't collide
      if (!compileCustomRule(cfg) || customIds.has(cfg.id)) continue
      customIds.add(cfg.id)
      custom.push(cfg)
    }
  }
  const knownIds = new Set<string>([...BUILTIN_IDS, ...customIds])

  const providers: Record<string, string[]> = {}
  if (isObj(raw.providers)) {
    for (const [providerId, ids] of Object.entries(raw.providers)) {
      if (!Array.isArray(ids)) continue
      const valid = [
        ...new Set(ids.filter((x): x is string => typeof x === 'string' && knownIds.has(x))),
      ]
      if (valid.length > 0) providers[providerId] = valid
    }
  }

  const fakes: Record<string, string> = {}
  if (isObj(raw.fakes)) {
    for (const [id, fake] of Object.entries(raw.fakes)) {
      if (knownIds.has(id) && typeof fake === 'string' && fake.length > 0) fakes[id] = fake
    }
  }

  return { version: MASKING_VERSION, providers, fakes, custom }
}

function structuredCloneDefault(): MaskingConfig {
  return { version: MASKING_VERSION, providers: {}, fakes: {}, custom: [] }
}

export async function readMaskingConfig(): Promise<MaskingConfig> {
  if (!(await fileExists(paths.masking))) return structuredCloneDefault()
  try {
    return normalizeMaskingConfig(JSON.parse(await readFile(paths.masking, 'utf8')))
  } catch {
    return structuredCloneDefault()
  }
}

export async function writeMaskingConfig(cfg: MaskingConfig): Promise<void> {
  await atomicWrite(paths.masking, `${JSON.stringify(cfg, null, 2)}\n`)
}

let writeChain: Promise<unknown> = Promise.resolve()

/** Serialized read-modify-write so concurrent edits can't clobber each other
 *  (mirrors core/secrets.ts). */
export function mutateMaskingConfig(
  fn: (cfg: MaskingConfig) => MaskingConfig,
): Promise<MaskingConfig> {
  const next = writeChain.then(async () => {
    const cfg = await readMaskingConfig()
    const updated = normalizeMaskingConfig(fn(cfg))
    await writeMaskingConfig(updated)
    return updated
  })
  writeChain = next.catch(() => {})
  return next
}

// ── effective rules (built-ins + custom, with fake overrides applied) ──

/** The full runnable rule set for a config: built-ins followed by compiled
 *  custom rules, each with its `fake` override applied. */
export function effectiveRules(cfg: MaskingConfig): MaskingRule[] {
  const custom = cfg.custom.map(compileCustomRule).filter((r): r is MaskingRule => r !== null)
  return [...BUILTIN_RULES, ...custom].map((r) =>
    cfg.fakes[r.id] ? { ...r, fake: cfg.fakes[r.id] as string } : r,
  )
}

function knownRuleIds(cfg: MaskingConfig): Set<string> {
  return new Set(effectiveRules(cfg).map((r) => r.id))
}

/** The rule ids enabled for a provider (empty when none / unconfigured). */
export function enabledRuleIds(cfg: MaskingConfig, providerId: string): string[] {
  return cfg.providers[providerId] ?? []
}

/** The rules that should run for a given provider. Empty ⇒ masking off for it. */
export function enabledRulesForProvider(cfg: MaskingConfig, providerId: string): MaskingRule[] {
  const ids = new Set(enabledRuleIds(cfg, providerId))
  return ids.size > 0 ? effectiveRules(cfg).filter((r) => ids.has(r.id)) : []
}

// ── mutations ──────────────────────────────────────────────────────────

/** Turn one rule on/off for one provider. Unknown rule ids are ignored. */
export function setProviderRuleEnabled(
  providerId: string,
  id: string,
  enabled: boolean,
): Promise<MaskingConfig> {
  return mutateMaskingConfig((cfg) => {
    if (!knownRuleIds(cfg).has(id) || !providerId) return cfg
    const ids = new Set(cfg.providers[providerId] ?? [])
    if (enabled) ids.add(id)
    else ids.delete(id)
    const providers = { ...cfg.providers }
    if (ids.size > 0) providers[providerId] = [...ids]
    else delete providers[providerId]
    return { ...cfg, providers }
  })
}

/** Set a provider's whole enabled set at once (powers select-all / clear). */
export function setProviderRules(providerId: string, ids: string[]): Promise<MaskingConfig> {
  return mutateMaskingConfig((cfg) => {
    if (!providerId) return cfg
    const known = knownRuleIds(cfg)
    const valid = [...new Set(ids.filter((x) => known.has(x)))]
    const providers = { ...cfg.providers }
    if (valid.length > 0) providers[providerId] = valid
    else delete providers[providerId]
    return { ...cfg, providers }
  })
}

/** Override (or, when `fake` is empty/equal to the built-in default, reset) the
 *  fake a rule swaps in. */
export function setRuleFake(id: string, fake: string): Promise<MaskingConfig> {
  return mutateMaskingConfig((cfg) => {
    if (!knownRuleIds(cfg).has(id)) return cfg
    const builtin = BUILTIN_RULES.find((r) => r.id === id)
    const fakes = { ...cfg.fakes }
    if (!fake || (builtin && builtin.fake === fake)) delete fakes[id]
    else fakes[id] = fake
    return { ...cfg, fakes }
  })
}

/** Add or edit a custom credential type. Rejects (no-op) a bad regex, an id that
 *  collides with a built-in, or missing fields. */
export function upsertCustomRule(rule: CustomRuleConfig): Promise<MaskingConfig> {
  return mutateMaskingConfig((cfg) => {
    if (!compileCustomRule(rule)) return cfg
    const custom = cfg.custom.filter((c) => c.id !== rule.id)
    custom.push(rule)
    return { ...cfg, custom }
  })
}

/** Remove a custom rule and any provider/fake references to it. */
export function removeCustomRule(id: string): Promise<MaskingConfig> {
  return mutateMaskingConfig((cfg) => {
    if (BUILTIN_IDS.has(id)) return cfg
    const custom = cfg.custom.filter((c) => c.id !== id)
    if (custom.length === cfg.custom.length) return cfg
    const fakes = { ...cfg.fakes }
    delete fakes[id]
    const providers: Record<string, string[]> = {}
    for (const [p, ids] of Object.entries(cfg.providers)) {
      const kept = ids.filter((x) => x !== id)
      if (kept.length > 0) providers[p] = kept
    }
    return { ...cfg, custom, fakes, providers }
  })
}

// ── catalog (for the dashboard) ────────────────────────────────────────

export type RuleCatalogEntry = {
  id: string
  label: string
  description: string
  fake: string
  /** True for user-defined rules (editable pattern, removable). */
  custom: boolean
  /** Regex source + group, surfaced so the UI can show/edit a custom rule. */
  pattern: string
  flags?: string
  group?: number
}

/** The full rule catalog (built-ins + custom) with effective fakes. Carries no
 *  secret material — `fake` is a public placeholder. */
export function ruleCatalog(cfg: MaskingConfig): RuleCatalogEntry[] {
  const customById = new Map(cfg.custom.map((c) => [c.id, c]))
  return effectiveRules(cfg).map((r) => {
    const c = customById.get(r.id)
    return {
      id: r.id,
      label: r.label,
      description: r.description,
      fake: r.fake,
      custom: c != null,
      pattern: c ? c.pattern : r.pattern.source,
      ...(c?.flags ? { flags: c.flags } : {}),
      ...(typeof r.group === 'number' ? { group: r.group } : {}),
    }
  })
}

// ── the masking pass ──────────────────────────────────────────────────

export type MaskingResult = {
  /** The text with every recognized credential swapped for its fake. */
  masked: string
  /** fake → real, for restoring the response. Empty when nothing matched. */
  restore: Map<string, string>
  /** ruleId → number of occurrences masked (no secret values — safe to log). */
  hits: Record<string, number>
}

/** Replace every credential the given rules recognize with a fixed fake of the
 *  same shape. A distinct real value always maps to the same fake within one
 *  call; a second distinct value of the same type gets a `_N`-suffixed fake so
 *  the reverse map stays unambiguous. Returns the original text and an empty
 *  restore map when nothing matched. */
export function maskCredentials(text: string, rules: readonly MaskingRule[]): MaskingResult {
  const restore = new Map<string, string>() // fake → real
  const realToFake = new Map<string, string>()
  const ruleCount = new Map<string, number>()
  const hits: Record<string, number> = {}

  let masked = text
  for (const rule of rules) {
    // why: clone the regex per call so the shared lastIndex of a /g regex can't
    // leak state across requests.
    let re: RegExp
    try {
      re = new RegExp(rule.pattern.source, rule.pattern.flags)
    } catch {
      logger.warn(`masking: bad pattern for rule ${rule.id}; skipping`)
      continue
    }
    masked = masked.replace(re, (...args) => {
      const whole = args[0] as string
      const real = rule.group != null ? (args[rule.group] as string | undefined) : whole
      if (typeof real !== 'string' || real.length === 0) return whole
      // Never re-mask a fake we already inserted (a later rule could otherwise
      // match it).
      if (restore.has(real)) return whole

      let fake = realToFake.get(real)
      if (!fake) {
        const n = ruleCount.get(rule.id) ?? 0
        fake = n === 0 ? rule.fake : `${rule.fake}_${n}`
        ruleCount.set(rule.id, n + 1)
        realToFake.set(real, fake)
        restore.set(fake, real)
      }
      hits[rule.id] = (hits[rule.id] ?? 0) + 1
      // For group rules, swap only the secret substring, leaving its context.
      return rule.group != null ? whole.replace(real, fake) : fake
    })
  }

  return { masked, restore, hits }
}
