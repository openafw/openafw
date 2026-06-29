// `afw ogr` — inspect and configure the OGR gateway policy (the security
// detectors afw runs as the gateway altitude). Edits stage a PROPOSAL; a human
// promotes it with `afw ogr approve`. Per OGR's non-negotiable rule, a drafting
// agent may propose but may not approve — `approve` refuses unless it is run
// interactively in a terminal by a person.

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { Command } from 'commander'
import { parse as parseJsonc } from 'jsonc-parser'
import { paths } from '../../core/paths.ts'
import {
  type CommandRule,
  DEFAULT_POLICY,
  type OgrPolicy,
  approveProposal,
  getPolicyStatus,
  normalizePolicy,
  patchContentRules,
  proposePolicy,
  rejectProposal,
  removeCommandRule,
  toCanonical,
  upsertCommandRule,
} from '../../daemon/ogr/policy.ts'
import type { Decision } from '../../daemon/ogr/types.ts'

const DECISIONS: readonly Decision[] = ['allow', 'modify', 'redact', 'require_approval', 'block']
const isDecision = (v: string): v is Decision => (DECISIONS as readonly string[]).includes(v)

function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function printPolicy(label: string, p: OgrPolicy): void {
  console.log(`\n${label}`)
  const cr = p.contentRules
  console.log(`  content   injection·untrusted=${cr.injectionFromUntrusted}`)
  console.log(`            injection·unverified=${cr.injectionFromUnverified}`)
  console.log(`            secrets=${cr.redactSecrets ? 'redact' : 'block'}`)
  console.log(`  commands  (${p.configRules.commandRules.length})`)
  for (const r of p.configRules.commandRules) {
    console.log(`    [${r.decision}] ${r.id}  /${r.regex}/  ${r.why}`)
  }
}

function showStatus(): void {
  const s = getPolicyStatus()
  printPolicy(s.usingDefault ? 'LIVE (built-in default):' : 'LIVE (enforced):', s.live)
  if (s.proposed) {
    printPolicy('PROPOSED (pending approval — run `afw ogr approve`):', s.proposed)
  } else {
    console.log('\nNo pending proposal.')
  }
}

function afterEdit(): void {
  console.log('✓ Staged a proposal. Review with `afw ogr show`, apply with `afw ogr approve`.')
}

export const ogrCommand = new Command('ogr').description(
  'Inspect and configure the OGR gateway security policy (propose → approve).',
)

ogrCommand
  .command('show')
  .description('Print the live policy, the detectors, and any pending proposal.')
  .action(() => {
    console.log(
      'OGR gateway altitude · detectors: afw.gateway.content_guard, afw.gateway.config_rules',
    )
    showStatus()
  })

ogrCommand
  .command('status')
  .description('Whether a proposal is pending approval.')
  .action(() => {
    const s = getPolicyStatus()
    console.log(s.pending ? 'Pending proposal — run `afw ogr approve`.' : 'No pending proposal.')
  })

ogrCommand
  .command('path')
  .description('Print the live and proposed policy file paths.')
  .action(() => {
    console.log(`live:     ${paths.ogrPolicy}`)
    console.log(`proposed: ${paths.ogrProposed}`)
  })

ogrCommand
  .command('content')
  .description('Stage a change to the content-rule decisions.')
  .option('--injection-untrusted <decision>', `one of ${DECISIONS.join('|')}`)
  .option('--injection-unverified <decision>', `one of ${DECISIONS.join('|')}`)
  .option('--redact-secrets', 'redact secrets (instead of blocking)')
  .option('--no-redact-secrets', 'block on secrets (instead of redacting)')
  .action(
    async (opts: {
      injectionUntrusted?: string
      injectionUnverified?: string
      redactSecrets?: boolean
    }) => {
      const patch: Parameters<typeof patchContentRules>[0] = {}
      if (opts.injectionUntrusted !== undefined) {
        if (!isDecision(opts.injectionUntrusted))
          fail(`--injection-untrusted must be one of ${DECISIONS.join(', ')}`)
        patch.injectionFromUntrusted = opts.injectionUntrusted
      }
      if (opts.injectionUnverified !== undefined) {
        if (!isDecision(opts.injectionUnverified))
          fail(`--injection-unverified must be one of ${DECISIONS.join(', ')}`)
        patch.injectionFromUnverified = opts.injectionUnverified
      }
      if (opts.redactSecrets !== undefined) patch.redactSecrets = opts.redactSecrets
      if (Object.keys(patch).length === 0) fail('nothing to change — pass at least one option')
      await patchContentRules(patch)
      afterEdit()
    },
  )

const ruleCommand = ogrCommand.command('rule').description('Add or remove command rules.')

ruleCommand
  .command('add')
  .description('Stage a new command rule (or replace one with the same id).')
  .requiredOption('--regex <pattern>', 'the regular expression to match')
  .requiredOption('--decision <decision>', `one of ${DECISIONS.join('|')}`)
  .option('--id <id>', 'rule id (defaults to the regex)')
  .option('--category <category>', 'risk category', 'security.unspecified')
  .option('--domain <domain>', 'safety | security', 'security')
  .option('--score <score>', 'confidence 0..1', '0.5')
  .option('--why <text>', 'human-readable reason', '')
  .action(
    async (opts: {
      regex: string
      decision: string
      id?: string
      category?: string
      domain?: string
      score?: string
      why?: string
    }) => {
      if (!isDecision(opts.decision)) fail(`--decision must be one of ${DECISIONS.join(', ')}`)
      try {
        new RegExp(opts.regex)
      } catch {
        fail('--regex does not compile')
      }
      const score = Number(opts.score)
      const rule: CommandRule = {
        id: opts.id || opts.regex,
        regex: opts.regex,
        category: opts.category || 'security.unspecified',
        domain: opts.domain === 'safety' ? 'safety' : 'security',
        decision: opts.decision,
        score: Number.isFinite(score) && score >= 0 && score <= 1 ? score : 0.5,
        why: opts.why || '',
      }
      await upsertCommandRule(rule)
      afterEdit()
    },
  )

ruleCommand
  .command('rm <id>')
  .description('Stage removal of a command rule.')
  .action(async (id: string) => {
    await removeCommandRule(id)
    afterEdit()
  })

ogrCommand
  .command('propose')
  .description('Stage a whole policy file as the proposal (for a drafting agent).')
  .requiredOption('--file <path>', 'a policy JSON file to propose')
  .action(async (opts: { file: string }) => {
    let raw: string
    try {
      raw = readFileSync(opts.file, 'utf8')
    } catch {
      fail(`cannot read ${opts.file}`)
    }
    const parsed = parseJsonc(raw, [], { allowTrailingComma: true })
    if (parsed == null || typeof parsed !== 'object') fail(`${opts.file} is not valid JSON`)
    await proposePolicy(normalizePolicy(parsed))
    afterEdit()
  })

ogrCommand
  .command('approve')
  .description('Promote the pending proposal to the live policy (human-only).')
  .action(async () => {
    const s = getPolicyStatus()
    if (!s.proposed) fail('no pending proposal to approve')
    printPolicy('About to make this policy LIVE:', s.proposed)
    if (!process.stdin.isTTY) {
      fail(
        'approval must be confirmed interactively by a human — run `afw ogr approve` in a terminal',
      )
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    let answer: string
    try {
      answer = (await rl.question("\nType 'approve' to confirm: ")).trim()
    } finally {
      rl.close()
    }
    if (answer !== 'approve') fail('not approved')
    await approveProposal()
    console.log('✓ Policy approved and now live. The daemon reloads it automatically.')
  })

ogrCommand
  .command('reject')
  .description('Discard the pending proposal.')
  .action(async () => {
    await rejectProposal()
    console.log('✓ Proposal discarded. The live policy is unchanged.')
  })

// `afw ogr default` — print the bundled default as a starting point to redirect
// into a file and edit (then `afw ogr propose --file`).
ogrCommand
  .command('default')
  .description('Print the bundled default policy (canonical OGR JSON).')
  .action(() => {
    console.log(JSON.stringify(toCanonical(DEFAULT_POLICY), null, 2))
  })
