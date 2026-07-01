# afw — project context

> The local firewall for AI agents: route and repair them, and keep your
> secrets off the model, the API relay, and the supply chain.

`afw` is a **local firewall for AI agents**: a small local proxy that
taps the wire between your coding agents and the model providers they
call. From that one vantage point it does **practical** work and
**security** work at once — no agent switch, no framework, no cloud. You
don't rewrite anything: afw detects what you already run (Claude Code,
OpenClaw, Hermes, Codex, Claude Desktop — anything that calls an LLM or
speaks MCP) and wraps it on the fly (launched per-process for CLI agents;
pointed at the wire for app/daemon agents).

In the code it still does the same three jobs on the wire: it **sees**
every request and response, **routes** each one to the model you pick
(failover chains and capability companions), and **guards** the traffic.
Guard is now two layers: credential **masking** — swapping real API keys,
wallet keys, and tokens for fixed fakes before they reach the provider or
an API relay, then restoring them in the response — and a
detector pipeline over the untrusted content tool calls pull in.

The firewall framing is load-bearing because an agent has two dangerous
moments. One: it reads something it didn't write — untrusted `tool_result`
content flows back into the model context, where an attacker can plant
instructions that hijack it (indirect prompt injection). Two: it talks to
a middleman it can't see — a cheap API relay terminates TLS, reads the
plaintext, and re-encrypts to the next hop, so every pasted secret and
every command the model returns is exposed and *modifiable* (the 2026 UCSB
study *Your Agent Is Mine* found relays exfiltrating keys, draining a real
wallet, and rewriting `pip install requests` into a typosquat). `afw`
sits between the agent and both. The masking pass lives in
`src/core/masking.ts` + `src/daemon/proxy/credential-mask.ts`; the detector
pipeline in `src/daemon/risk/` (`pipeline.ts` registers them; the
tool-result `prompt-injection.ts` detector is kept but gated — paid).

This file orients Claude Code (and other AI assistants) to the project.

> **Heads-up — recent fork.** `afw` was carved out of an earlier
> cost-saver project ("OpenThomas") by porting its firewall core (wire
> proxy, decoders, model-routing engine, `wire`/`unwire`/`detect` CLI)
> and dropping the cost-saver/metric surfaces. The original tree is
> frozen under `references/openthomas/` (gitignored) as a porting
> reference. The private `.strategy/` docs still describe the old
> cost-saver product and are **stale** pending a firewall rewrite — read
> them for architecture mechanics, not positioning.

## Status

v0.2 — the firewall cut, now with credential masking. Built on the proven
capture → decode → route → detect pipeline ported from the prior project.
The wire tap, protocol decoders, model-routing engine (failover chains,
capabilities), and the Claude Code subagent classifier are live and tested.
The headline security layer is **credential masking** (`core/masking.ts`,
`daemon/proxy/credential-mask.ts`) — opt-in, per-upstream de-identify /
re-identify on the wire — plus the detector pipeline (`risk/`): secret-leak
and dangerous-shell today. The tool-result indirect-prompt-injection
detector is kept but **gated (paid)** — unregistered from `risk/pipeline.ts`.
One-command repair of a broken agent setup (the format-preserving config
editors + per-edit backups are the foundation), inline blocking, and relay
command-tampering / supply-chain checks are roadmap.

## Naming

| Thing | Name |
|---|---|
| Project / brand | afw (by OpenGuardrails) |
| GitHub repo | `openafw/openafw` |
| npm scope | `@openguardrails` |
| npm package | `@openafw/openafw` |
| Main binary | `afw` |
| MCP stdio wrapper bin | `afw-tap` |
| MCP tools server bin | `afw-tools` |
| Daemon subcommand | `afw daemon start` / `stop` / `restart` |
| Config dir | `~/.afw/` |
| Trace dir | `~/.afw/wire/traces/` |
| Backups dir | `~/.afw/backups/` |
| Logs dir | `~/.afw/logs/` |
| Env overrides | `AFW_HOME`, `AFW_PORT`, `AFW_LOG_LEVEL` |
| Default UI URL | `http://localhost:9877` |
| macOS launchd label | `com.openguardrails.afw` |
| Editions | One — free, MIT, fully open source |

`wire` is preserved as **architectural terminology** (URL paths under
`/wire/`, storage under `~/.afw/wire/`, the `wire` / `unwire`
commands) — it's load-bearing in the code, not a brand asset. `proxy` is
an architecture word only, never positioning.

## Repo layout

```
afw/                       (repo: openafw/openafw)
├── CLAUDE.md                  (this file)
├── README.md                  (public face — firewall story)
├── PRIVACY.md                 (data handling contract)
├── LICENSE                    (MIT)
├── docs/
│   └── cli.md                 (every CLI command — user-facing reference)
├── .strategy/                 (PRIVATE, gitignored — STALE cost-saver design)
├── references/                (third-party projects studied — gitignored)
│   └── openthomas/            (frozen pre-fork tree; port reference, do not import)
└── packages/afw/          (the npm package: @openafw/openafw)
    └── src/
        ├── bin/               (afw, tap, tools entrypoints)
        ├── core/              (config, paths, packet, routing-policy, …)
        ├── cli/               (wire / unwire / detect / route / status / daemon)
        └── daemon/
            ├── proxy/         (the wire tap — /wire/<agent>/<provider>/...)
            ├── decoders/      (anthropic / openai protocol decoders → AgentPacket)
            ├── translate/     (cross-protocol IR for model swaps)
            ├── routing/       (model registry + routing policy)
            ├── orchestrator/  (model swap, subagent classifier, exec)
            ├── risk/          (the security detector pipeline)  ← firewall guard
            └── store/         (minimal SQLite trace store)
```

## Tech stack (locked)

| Layer | Choice |
|---|---|
| Runtime | Node.js 22+ LTS (the published package must run on stock Node — not Bun) |
| Language | TypeScript 5+ |
| HTTP | Hono + `@hono/node-server` |
| CLI parsing | commander |
| Error handling | `@praha/byethrow` (Result type) |
| Schemas | Valibot |
| Storage | better-sqlite3 + Drizzle ORM |
| Build | tsdown |
| JSON / JSON5 edit | `jsonc-parser` (Microsoft) |
| YAML edit | `yaml` (eemeli) — Document API to preserve comments |
| Test | vitest |

## Conventions

- **Language**: All code, comments, commits, and docs → **English**.
- **Style**: Default to no comments. Add `// why:` comments only when the
  intent is non-obvious. Never narrate WHAT code does.
- **Files**: kebab-case filenames; camelCase TS identifiers; PascalCase types.
- **Commits**: Conventional Commits.

## Mental model

`afw` is an **AI agent firewall**. It taps the wire and does three
jobs on every call: **see → route → guard**.

- **See.** The proxy (`daemon/proxy/`) captures each request/response;
  decoders (`daemon/decoders/`) normalize it into an `AgentPacket`
  (`core/packet.ts`); a minimal store (`daemon/store/`) persists the trace.
- **Route.** The routing engine (`core/routing-policy.ts`,
  `daemon/routing/`, `daemon/orchestrator/`) sends each request to the
  model you configured. The flagship automatic case is the Claude Code
  subagent classifier: the planner always carries the orchestrator-only
  `Agent` tool, subagents never do — presence ⇒ planner (untouched),
  absence ⇒ subagent (routable). Lives in
  `daemon/orchestrator/subagent.ts`, configured via
  `~/.afw/routing.json`.
- **Guard.** Two layers. **Credential masking** (`core/masking.ts`,
  `daemon/proxy/credential-mask.ts`) swaps real secrets for fixed fakes on
  the outbound request — keyed per upstream host, opt-in, default off — and
  restores them in the response, so neither the model nor an API relay sees
  the real value. And a **detector pipeline** (`daemon/risk/pipeline.ts`) of
  pure `(packet) => RiskTag[]` functions over every decoded packet:
  secret-leak and dangerous-shell today. The tool-result
  indirect-prompt-injection detector is kept but unregistered (gated/paid).

Local-first, zero accounts, no telemetry. Capture → decode → route →
detect is the pipeline underneath.

## Working with this codebase

### Read first
1. `references/openthomas/` only as a *porting reference* — never import from it.
2. `.strategy/architecture.md` — system mechanics (positioning is stale).
3. `src/core/masking.ts` + `src/daemon/proxy/credential-mask.ts` — credential masking (the headline guard).
4. `src/daemon/risk/` — the detector pipeline (`pipeline.ts`); `prompt-injection.ts` is gated/paid.
5. `src/daemon/proxy/` + `src/daemon/orchestrator/subagent.ts` — the wire + classifier.
6. `src/core/packet.ts` — the `AgentPacket` shape detectors and the store see.

### Gotchas (still load-bearing)
- **afw never rewrites an agent's shared config.** Connection is by runtime
  form: **CLI** agents (claude, codex) are *launched* with a per-process override
  — `afw claude` via Claude Code's `--settings`, `afw codex` via `-c`
  flags (`src/cli/launch/`); **app/daemon** agents (claude-desktop, openclaw,
  hermes) get printed `manualInstructions()` and the user points them at the wire.
  There is no `wire`/`unwire` command. The firewall-side route + credentials are
  registered automatically by `ensureWireRoute` (`src/cli/launch/route-setup.ts`),
  which reuses each detector's `detect()` but writes nothing to the agent's config.
- **Per-directory launch memory.** `afw claude` remembers a directory's
  routing choice in `~/.afw/launch/<hash>.json` (`src/cli/launch/per-dir.ts`).
- **Legacy config-rewrite code is dormant, not live.** The old detector
  `wire()`/`unwire()` + `cli/backup/*` + `cli/wire/orchestrate.ts` remain in the
  tree but are no longer reachable from the CLI (pending a cleanup pass). Don't
  build new features on them. Still: never edit a file in place — write to
  `.tmp`, fsync, rename (`core/atomic-file.ts`).
- **Path-based routing.** The proxy receives requests at
  `/wire/<agent>/<provider>/<rest>`. Strip the prefix, look up the upstream
  from `~/.afw/wire/routes.json`. Concatenate as strings — do NOT use
  `new URL(restPath, base)` (an absolute `restPath` clobbers the base path).
- **Format-preserving edits.** Users' config files have comments and
  idiosyncratic formatting. Use AST editors (`jsonc-parser`, `yaml`
  Document API). Never parse-and-restringify.
- **`afw-tap` cold start.** Spawned per MCP server. Keep its bundle
  small — no heavy daemon code loaded.
- **`wire` is architecture, not branding.** URL paths (`/wire/...`),
  storage (`~/.afw/wire/...`), and the `wire`/`unwire` commands all use
  `wire` — don't refactor it away.

### `references/`
Third-party projects studied, plus the frozen pre-fork `openthomas/` tree.
**Not dependencies** — never import from them, never add to package.json,
never refactor them.

## Do not

- Add a Tauri / Electron / native GUI app. afw is CLI + daemon +
  (optional) browser UI.
- Switch the published artifact's runtime to Bun. The npm package must run
  on stock Node.
- Rename the npm package away from `@openafw/openafw` or the binaries
  away from `afw` / `afw-tap` / `afw-tools` — they are the
  user-facing contract.
- Import from `references/` (including `references/openthomas/`).
- Re-grow the old cost-saver metric surfaces (the "Thomas (T)" outcome
  metric, outcomes/T-score pipeline, cost-per-task dashboard). They were
  deliberately dropped in the fork.
- Add features beyond what the current commit needs.
- Write README files or docstrings unless explicitly asked.
- Use `git push --force`, amend already-pushed commits, or skip pre-commit
  hooks without explicit user approval.
- **Send any data about the user or their usage anywhere besides the
  upstream the user's agent already calls.** No telemetry, no crash
  reports, no license checks. The privacy contract in `PRIVACY.md` is
  load-bearing for trust.
  - **One carve-out: the update version check.** A daily plain GET to the
    public npm registry (`registry.npmjs.org`) to see if a newer version
    exists is permitted. It carries no user data and is disableable
    (`updateCheck: false`). It is the *only* sanctioned unsolicited
    outbound call.
