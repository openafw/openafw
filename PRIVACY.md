# Privacy & data handling

afw is local-first. Everything you capture stays on your own
machine under `~/.afw/`. The published package does **not** collect
telemetry, does **not** report crashes, and does **not** send any data
**about you or your usage** anywhere. There is no `openguardrails.com` /
afw / Anthropic host wired into the package.

From v0.4 the daemon makes one outbound request of its own: a daily
**version check** against the public npm registry — see the v0.4
section. It carries no user data, contacts only the registry npm
itself uses, and can be switched off. From v0.5 an **opt-in** daily
**pricing-catalog refresh** (off by default) can fetch a public price
list from models.dev — see the v0.5 section.

From v1, when you route an agent onto a managed **subscription**
provider, afw may refresh that subscription's OAuth token against
the agent's own identity provider — see the v1 section. It is
request-driven, stays within the agent's existing upstream, sends only
the token the agent already holds, and never contacts us.

This file is updated **every release** with the exact behaviour of
the version it ships with. If a future release sends any data **about
you or your usage** anywhere, it will be:
1. Strictly opt-in.
2. Documented here under that version's section with what is sent,
   to where, and why.
3. Documented in the release notes.

(A version check against the public package registry is not in that
category — it reveals nothing about you — but it is documented in full
below and is disableable all the same.)

Audit the claims yourself by reading the source — `git grep https://`
finds every URL the package can talk to.

---

## v1

v1 adds **model routing & combos** (`afw route` and the Control ·
Routing pages) — you can reconfigure which model(s) a wired agent's
traffic reaches. This changes where your agent traffic goes, so here is
exactly what it does.

### Where your traffic goes

By default every route is plain **passthrough**: traffic reaches the
same upstream your agent already chose, unchanged. Nothing about routing
takes effect until you explicitly opt a route in.

When you do route an agent to a different model or a combo, its requests
go to the upstream **you configured for that model's provider** — a URL
you typed in yourself, via the UI or `afw route provider add`. afw
still opens no outbound surface of its own: it only ever talks to
upstreams you named. There is no afw/Anthropic host in this path.

### `secrets.json` — your API keys

Cross-agent routing and the vision companion may need API keys for
providers your agent never authenticates to itself. Those keys are
stored **locally** in `~/.afw/secrets.json`, written with file mode
`0600` (readable only by your user account).

* The keys are sent **only** to the upstream URLs you configured for
  their providers — nowhere else, never to us.
* The secret store is **write-only** across the CLI and the daemon API:
  you can set and remove keys, but a value can never be read back out.
  The UI shows only which key *refs* exist, never their contents.
* Removing a provider removes its stored key.

### Captured credentials & subscription token refresh

So one agent can use another agent's model, afw manages every
agent's credentials itself. `afw wire` reads each agent's existing
credential from its **own config** and handles it one of two ways.

**Static API keys** — Claude Code's `ANTHROPIC_API_KEY`, Codex's
`OPENAI_API_KEY`, Hermes / OpenClaw provider keys — are copied into
`~/.afw/secrets.json` (mode `0600`, see above) under a
`provider:<agent>/<provider>` ref. They are read from files already on
your machine and only ever sent to the same upstream that agent
already calls.

**Subscription logins** — Claude Code's Claude.ai login, Codex's
ChatGPT login — use OAuth tokens that expire. afw does **not** copy
these into `secrets.json`. It reads them, only when a managed route
needs them, from the agent's own credential store: the macOS Keychain
item `Claude Code-credentials` (fallback `~/.claude/.credentials.json`)
and `~/.codex/auth.json`.

#### The refresh call

A subscription access token expires. When a managed subscription route
is used and the token is within five minutes of expiry, afw
refreshes it:

* **Request:** an HTTPS `POST` to the agent's **own** OAuth provider —
  `https://platform.claude.com/v1/oauth/token` for Claude Code,
  `https://auth.openai.com/oauth/token` for Codex. These are the exact
  endpoints the agent itself calls to refresh the exact same token.
* **What it sends:** your `refresh_token` and the agent's public
  `client_id`. Nothing else — no machine ID, no usage data, nothing
  identifying you beyond the token the agent already holds.
* **Where it does NOT go:** not `openguardrails.com`, not any afw server.
  We never see this request.
* **When:** only when you have opted a route onto a managed
  subscription provider *and* its token is near expiry. A passthrough
  route never triggers it.

#### Rotated tokens are written back

OAuth refresh tokens are single-use — a refresh returns a new one.
afw writes the rotated token back to the agent's own store
(Keychain / `auth.json`, atomically) so the agent picks it up on its
next read instead of failing. afw is a **cooperative co-refresher**
of the same credential, not a competing one.

This stays within afw's contract — data about you goes only to the
upstream your agent already talks to, and an agent's OAuth provider is
part of that upstream — but it is called out here, and in the release
notes, all the same.

#### Request shape on managed subscription routes

Anthropic gates a Claude.ai (subscription) OAuth token behind specific
request-shape requirements — the token is accepted only when the
request claims **Claude Code shape**. When afw routes a call onto a
managed Claude.ai subscription provider, it adjusts the outgoing
request to satisfy those gates:

* Two `anthropic-beta` flags on the request:
  `claude-code-20250219` and `oauth-2025-04-20`.
* A fixed Claude-Code identity prepended to the request's `system`
  block: *"You are Claude Code, Anthropic's official CLI for Claude."*
  Your agent's own system prompt is preserved after it.

This is a **protocol-level concession** to the upstream — the same
shape Claude Code itself sends on every call. No new data about you
leaves the machine, and no new outbound surface is opened. Without
these adjustments, Anthropic rejects subscription tokens used outside
Claude Code with `4xx` errors or aggressive throttling. Disclosed here
for the same reason the refresh call is: afw is shaping a request
on your behalf, and you should know what shape it takes.

### New files on disk

| Path | What |
|---|---|
| `~/.afw/models.json` | The catalog of providers and models afw can route to. Provider base URLs, wire formats, model metadata. No secrets — keys live in `secrets.json`. Seeded from your wire and extended by you. |
| `~/.afw/routing.json` | Per-agent routing decisions and combo definitions. No secrets. |
| `~/.afw/secrets.json` | Provider API keys — typed in by you or captured from an agent's own config by `afw wire`. File mode `0600`. Local-only; see above. |
| `~/.afw/oauth-<agent>.lock` | Transient lock held only while afw refreshes a subscription OAuth token, deleted immediately after. No contents. |

These are local files. Routing uploads nothing; the only outbound call
this version adds is the subscription token refresh described above.

---

## v0.5

v0.5 adds an **opt-in pricing-catalog refresh**. By default afw prices
calls from the catalog bundled inside the package (and your own
`~/.afw/pricing.json` overrides) — entirely offline. If you want prices
to stay fresh without upgrading afw, you can turn on a daily refresh.

### The pricing refresh

* **Off by default.** Enable with `autoRefreshPricing: true` in
  `~/.afw/config.json`. With it off (the default) the daemon makes no
  pricing requests at all.
* **Request:** when on, one plain HTTPS `GET` per day to
  `https://models.dev/api.json` — a public, community-maintained price
  list. The same source the bundled catalog is built from.
* **What it sends:** nothing about you. No user data, no machine ID, no
  model ids you've used, no usage data — just an anonymous GET for the
  public catalog.
* **Where it does NOT go:** not `openguardrails.com`, not any afw or
  Anthropic server, never your captured traffic. We never see this request.
* The result is cached at `~/.afw/pricing-catalog.json` and read locally;
  nothing leaves your machine.

This is the second sanctioned outbound call (after the v0.4 version check),
and like that one it is opt-in here, hits only a public third-party
endpoint, and is fully disableable.

### New files on disk

| Path | What |
|---|---|
| `~/.afw/pricing-catalog.json` | Cached price catalog from the last refresh (only when `autoRefreshPricing` is on). |

### Session correlation (opt-in, local-only)

To attribute captured Claude Code calls to the specific window (instance) and
parallel sub-agent that made them — fleet management — afw can correlate
captures with Claude Code's own local transcripts.

* **Off by default.** Enable with `correlateSessions: true` in
  `~/.afw/config.json`.
* **What it reads:** `~/.claude/projects/**/*.jsonl` — Claude Code's session
  transcripts, already on your disk. It joins each captured call to its session
  on the upstream `message.id` (which afw already has in the stored
  response) and records the session id + sub-agent id locally.
* **What it sends:** nothing. No network calls at all. This is a local file
  read; results are written only to your local trace DB. It never contacts
  `openguardrails.com`, Anthropic, or any host.
* Reads stop working gracefully when the files are absent (e.g. the daemon and
  agent run on different machines) — calls simply stay unattributed.

---

## v0.4

v0.4 adds the **update system** — `afw update`, `afw rollback`,
the dashboard update banner, and optional auto-update. This is the
first afw behaviour that contacts a host other than your agent's
own upstream. Here is exactly what it does.

### The version check

The daemon checks once a day whether a newer afw has been
published:

* **Request:** a plain HTTPS `GET` to
  `https://registry.npmjs.org/openafw/latest` — the public
  npm registry, the same one `npm install` used to put afw on your
  machine.
* **What it sends:** the package name, in the URL. Nothing else. No
  user data, no machine ID, no install ID, no usage data, no header
  that identifies you. The registry sees an anonymous GET, exactly
  like `npm view openafw version`.
* **Where it does NOT go:** not `openguardrails.com`, not any afw or
  Anthropic server. We never see this request.
* **On by default**, because it carries nothing about you. Turn it
  off completely with `updateCheck: false` in `~/.afw/config.json`
  — the daemon then makes no version checks at all.
* The result is cached in `~/.afw/update.json` and never leaves
  your machine.

### Installing an update

`afw update`, or "Update now" in the dashboard, runs
`npm install -g openafw@<version>` — exactly what you would
run by hand. Before installing, afw snapshots your trace database
into `~/.afw/backups/`. After installing it restarts the daemon
(waiting for a quiet moment so no in-flight agent call is dropped) and
health-checks the new version; if the new version does not come up
healthy it automatically reinstalls the previous one and restores the
database snapshot. None of this uploads anything.

### Auto-update

Off until you turn it on. After your first manual update, afw asks
once whether to auto-update future releases. If you say yes
(`autoUpdate: true` in `~/.afw/config.json`), the daily check will
install a new version on its own — still backed up, still
health-gated, still auto-rolled-back on failure. Say no and updates
stay manual.

### New files on disk

| Path | What |
|---|---|
| `~/.afw/config.json` | Your preferences: `updateCheck`, `autoUpdate`, `autoUpdateAsked`. |
| `~/.afw/update.json` | Cached result of the last version check. |
| `~/.afw/update-progress.json` | State of the current / last update, for the CLI and dashboard. |
| `~/.afw/backups/db-pre-<version>-<ts>.sqlite` | Database snapshots taken before each update so a rollback can restore them. The most recent 3 are kept. |
| `~/.afw/pending-db-restore` | Transient marker written during a rollback; consumed and deleted at the next daemon boot. |

All of these are local files. Nothing in the update system uploads
anything.

---

## v0.1

### What afw writes to your disk

| Path | What |
|---|---|
| `~/.afw/wire/routes.json` | Mapping from `<agent>/<provider>` route keys to upstream URLs, written by `afw wire`. |
| `~/.afw/wire/traces/traces.db` | SQLite database of every captured action — model calls (prompts, responses, tool_use blocks, tokens, cost), MCP frames (server, method, params/result), durations. |
| `~/.afw/backups/manifest.json` + `~/.afw/backups/<timestamp>/<agent>/<file>` | Byte-exact copies of each agent config afw rewrote, plus a manifest with `sha256` checksums of before and after. `afw unwire` uses these to restore. |
| `~/.afw/logs/daemon.log`, `daemon.err` | Daemon stdout / stderr — info lines for each captured request, errors for parse failures. Plain text. |
| `~/.afw/wire/daemon.sock` (planned) | Unix-domain socket for CLI ↔ daemon. Not yet used in v0.1. |

### What afw sends over the network

**One pattern only:** the HTTP proxy at `http://localhost:9877/wire/...`
forwards your agent's outbound request to whatever upstream is
registered in `routes.json`. Concretely:

* If your agent calls `api.anthropic.com`, afw relays the same
  bytes to `api.anthropic.com`.
* If your agent calls `api.openai.com`, afw relays to `api.openai.com`.
* If your agent calls some internal/private endpoint, afw relays
  there.

The bytes are unchanged — same body, same auth headers. afw
**also** keeps a normalized copy of the request and response on your
disk for `afw list / show / report`.

**Where afw does NOT send data:**

* No `openguardrails.com` host. No `*.openguardrails.com` calls anywhere in
  the source. Grep `packages/afw/src/` to confirm.
* No telemetry endpoint, anonymous or otherwise.
* No auto-update check (`npm update -g openafw` is something
  you run manually).
* No error / crash reporting.
* No license-check ping (no license system exists in v0.1).

### What other tools can read

* `afw report <run-id>` produces markdown or JSON to stdout or a
  file you choose. Nothing is uploaded; you decide where the output
  goes. Pass `--redact` to mask common credential shapes (API keys,
  bearer tokens, GitHub PATs, AWS keys, Google keys, Slack tokens)
  before sharing.
* `afw list --json` and the REST API at `/api/runs` are served on
  `localhost:9877` only. Not bound to external interfaces. Anyone
  with access to your user account on this machine can read them.

### What's intentionally not in v0.1

* Any form of telemetry, opt-in or otherwise.
* Crash reporting.
* Auto-update checks.
* License validation.
* Cloud sync.
* Any cryptographic identifiers (machine IDs, install IDs, etc.).

### Source-code receipts

Confirm the above by reading the package source. Two greps cover
nearly the entire surface:

```bash
# Every URL constant or template literal that starts with http
git grep -E "https?://" packages/afw/src/ | grep -v "node:" | grep -v "//---"

# Every call to fetch(), which is how outbound HTTP happens in Node
git grep -n "fetch(" packages/afw/src/
```

What you should find:
* The proxy forwards to upstream URLs read from `routes.json`.
* `afw-tap` POSTs frames to `http://localhost:9877/api/tap/frame`
  (the local daemon).
* `afw status` and `afw ui` GET `http://localhost:9877/health`
  (the local daemon).
* Decoder selection inspects hostnames (`api.anthropic.com`,
  `api.openai.com`, `openrouter.ai`, `*.googleapis.com`,
  `*.amazonaws.com`) — these are string comparisons, not network calls.

Nothing else.

### What the daemon does on its own

Once started, the daemon performs one background activity that touches
your data without an explicit command:

* **Auto-prune.** Every 24 hours, the daemon deletes captured actions
  older than `AFW_RETENTION_DAYS` (default 30). This only removes
  data **from your local trace database** — nothing leaves your machine
  before, during, or after. In-flight runs (open `ended_at`) are never
  pruned. Disable with `AFW_RETENTION_DAYS=0` in the daemon
  environment. To also reclaim disk space to the OS (slow, pauses
  writes), set `AFW_PRUNE_VACUUM=1`. The same logic is available
  manually via `afw prune`.

### Reporting

If you find any behaviour in afw that contradicts this file,
please open a GitHub issue immediately. We treat it as a security
bug, not a feature gap.
