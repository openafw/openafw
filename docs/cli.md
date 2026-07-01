# CLI

The `afw` binary, installed by `npm install -g @openafw/openafw`.

The first time you run `afw` it walks first-run setup: register a model
provider, map afw's three model names to your models, then mint an API key
for a generic agent. After that, how you connect an agent depends on its
**runtime form**:

- **CLI agents** (Claude Code, Codex) — *launch* them through afw:
  `afw claude`, `afw codex`. Per-instance, per-directory, no global change,
  no key needed.
- **App / daemon agents** (OpenClaw, Hermes, anything OpenAI/Anthropic-compatible)
  — run `afw openclaw` / `afw hermes` to list and create an API key, then
  point the agent's base URL at the afw `/v1` endpoint with that key and
  request one of the three model names.
- **Models** — register the upstreams afw can route to with `afw model add`.

An **API key** is a *short local identifier* — `afw_xxxxxx` — that tells afw
which agent (or session) is talking, so it can track and manage them separately.
It is not a security secret (everything is local). Claude Code / Codex auto-mint
one key per directory session on `afw claude` / `codex`; OpenClaw / Hermes
get keys from `afw openclaw` / `afw hermes`.

afw exposes exactly **three model names**, named after Starbucks cup sizes
from low to high: **Tall**, **Grande**, **Venti**. You map each to one of your
own models with `afw tier`; the request's model name selects the tier.
(Model-name matching is case-insensitive.)

## Commands at a glance

```
LAUNCH (CLI agents)
  afw claude [-- <args>]      Launch Claude Code through afw (this instance).
  afw codex  [-- <args>]      Launch Codex through afw (this instance).
  afw run -- <cmd> [args…]    Explicit per-instance launcher (advanced).

CONNECT (app / daemon agents — point them at /v1 with an API key)
  afw tier                    Map Tall / Grande / Venti to your models (interactive).
  afw tier set <tier> --model <id>   Map one tier (or --fusion <comboId>).
  afw tier list               Show the three tiers and what each maps to.
  afw openclaw                List + create OpenClaw API keys (--new to add).
  afw hermes                  List + create Hermes API keys (--new to add).
  afw key list [--agent X]    List issued keys (short local identifiers).
  afw key show <id>           Print connection details (URL, key, model names).
  afw key rm <id>             Revoke a key.

CONFIGURE
  afw onboard                 Re-run first-run setup (provider + tiers + key).
  afw model add               Add model providers (interactive, validated).
  afw model list              List registered providers and models.
  afw route                   Per-agent model routing, failover, subagent saver.

INSPECT
  afw                         First-run setup, or a one-glance overview.
  afw ui                      Open the dashboard in your browser.
  afw status                  Daemon + tap health.
  afw daemon start            Start the daemon in the background.
  afw daemon stop             Stop the daemon.
  afw daemon restart          Restart the daemon.

UPDATE
  afw update                  Update afw to the latest version.

INTERNAL  (users don't call these directly)
  afw daemon run              Run the daemon in foreground (service target).
  afw tap --agent X --server Y -- <cmd> [args…]   stdio MCP wrapper.
```

Bare `afw` runs first-run setup on a fresh install, then prints a one-glance
overview on later runs, including common commands such as `afw ui` and
`afw daemon start|stop|restart`. Open the dashboard with `afw ui`; it starts
the daemon automatically when needed.

---

## `afw claude` / `afw codex` (CLI launchers)

Launch one instance of a CLI agent pointed at afw, **for that process only** —
the agent's global config is never touched (it's done via a per-process override:
Claude Code's `--settings`, Codex's `-c` flags). The first launch in a project is
remembered, so a later bare `afw claude` in the same directory reuses it.

```
USAGE
  afw claude [options] [-- <agent args>]
  afw codex  [options] [-- <agent args>]

OPTIONS
  --model <id>   Route this instance to a single model (remembered for this dir).
  --monitor      Capture but never reroute.
  --raw          Bypass afw entirely for this launch.
  --as <label>   Instance label (defaults to a per-directory id).
  --ephemeral    Forget the instance routing policy when it exits.
```

On launch afw: starts the daemon if it isn't running, registers the
firewall-side route + credentials for the agent (so the proxy can forward and
authenticate), applies/persists this directory's routing choice, then spawns the
agent. Anything after `--` is passed straight to the agent.

```
afw claude --model claude-sonnet-4-6 -- -p "summarize CHANGELOG.md"
afw claude                       # reuse this dir's remembered choice
afw codex --monitor              # capture, never reroute
```

---

## `afw tier` + `afw key` (connect app / daemon agents)

App and daemon agents (OpenClaw, Hermes, anything that speaks the OpenAI or
Anthropic wire format) connect with an **afw API key** instead of a launcher.
There are two pieces:

**Tiers — the three model names.** afw exposes exactly three model names,
named after Starbucks cup sizes low → high: **Tall**, **Grande**, **Venti**. Map
each to one of your configured models — a single model, a token-limit failover
chain, or an existing Fusion combo. This mapping is global (it's the model menu
every key sees).

```
USAGE
  afw tier                         # interactive: map all three
  afw tier set <tier> --model <id> [--provider <id>]
  afw tier set <tier> --fusion <comboId>
  afw tier list
  afw tier unset <tier>
```

`<tier>` is `Tall` / `Grande` / `Venti` (or `tall` / `grande` / `venti`).

**Keys — short agent identifiers.** A key is a short local id (`afw_xxxxxx`)
that tells afw which agent is talking; the request's model name picks the
tier. Each app/daemon agent has its own command that lists its keys and creates
new ones:

```
USAGE
  afw openclaw [--new] [--label <l>]   # list OpenClaw keys; --new creates one
  afw hermes   [--new] [--label <l>]   # list Hermes keys; --new creates one
  afw key list [--agent <id>]          # all keys (or one agent's)
  afw key show <id>                     # reprint the connection block
  afw key rm <id>                       # revoke
```

Point your agent at the printed values and request one of the three model names:

```
  Base URL (OpenAI-compatible):  http://localhost:9877/v1
  Base URL (Anthropic):          http://localhost:9877
  API key:                       afw_…
  Model name:                    Tall | Grande | Venti
```

The key (sent as `Authorization: Bearer` or `x-api-key`) tells afw which
agent the call belongs to; the model name selects the tier, and afw
translates between wire formats as needed. Claude Code / Codex don't use this —
`afw claude` / `codex` auto-mint one key per directory session. Keys live in
`~/.afw/keys.json`, tier mappings in `~/.afw/tiers.json` (mode `0600`).

---

## `afw model add`

Interactively register one or more model providers afw can route to. For each
provider it prompts for the base URL, API compatibility (`auto` / `openai-chat` /
`openai-responses` / `anthropic`), API key, model id(s), and image support, then
**validates with a live probe** before registering. Repeats until you're done.

```
USAGE
  afw model add                  # interactive, multi-provider (live-probed)
  afw model list                 # show registered providers + models
  afw model rm <id>              # remove a model

PROVIDERS  (scriptable)
  afw model provider add <id> --base-url <url> --api <api>
                  [--auth passthrough|bearer|api-key] [--header <name>] [--label <text>] [--key <value>]
  afw model provider rm|list

SECRETS  (write-only — values never read back)
  afw model secret set|rm|list <ref>
```

`--api` is the wire format: `anthropic-messages`, `openai-chat`, or
`openai-responses`. afw translates between all three. Provider registration
has the scriptable `afw model provider add` form above; adding a model is
interactive only (the wizard asks whether it accepts image input — answer yes
for a multimodal model). API keys go to `~/.afw/secrets.json` (mode `0600`)
and are only ever sent to the upstream you configured.

---

## `afw route`

Reconfigure which model(s) an agent's traffic reaches — without touching the
agent's config. Talks to the running daemon. A route is keyed
`<agent>/<sourceModel>` (or the wildcard `<agent>/*`); every route is plain
passthrough until you opt it in.

```
ROUTES
  afw route list
  afw route show <routeKey>
  afw route set  <routeKey> --model <id> | --chain <id> [--chain <id>…] | --passthrough
  afw route unset <routeKey>
  afw route vision <routeKey> [--companion <id> [--provider <id>] | --off]

SUBAGENT COST-SAVER  (Claude Code dynamic workflows)
  afw route subagent [--on|--off] [--model <id>] [--floor <maxTokens>]
```

Providers, models, and secrets are registered under `afw model` (see above);
`afw route` only decides where a registered model's traffic goes. `--chain`
builds an error-failover chain (each member but the last advances on upstream
error).

`route vision` pairs a **text-only routed model with a multimodal companion**.
When the routed model can't see images, afw side-calls the companion to
describe them first, then runs the routed model on the request with those
descriptions spliced in. Register the companion with image input (`afw
model add`, answer yes to image input), then pin it onto the route — e.g.
`afw route set claude-code/* --model glm-4.6` followed by `afw route
vision claude-code/* --companion gpt-4o-mini`.

---

## `afw status`

Shows daemon + tap health, recent activity, and any config drift from a prior
setup. Exits non-zero if the daemon isn't responding.

---

## `afw update`

Update afw to the latest published version: the trace DB is snapshotted, the
new version is health-checked after restart, and a failed update auto-rolls-back.

```
OPTIONS
  --check    Only report whether a new version exists.
  --force    Restart immediately instead of waiting for an idle window.
```

The daemon also checks once a day against the public npm registry — no data about
you is sent (see [`PRIVACY.md`](../PRIVACY.md)); disable with `updateCheck: false`
in `~/.afw/config.json`.

---

## `afw daemon`

Manage the daemon. Bare `afw daemon` prints the common daemon operations instead
of occupying the terminal.

```
USAGE
  afw daemon
  afw daemon start
  afw daemon stop
  afw daemon restart
```

`afw daemon start` starts the daemon in the background and returns. `afw ui` and
the per-agent launchers also start it automatically when needed.

### `afw daemon run` (internal)

Run the daemon in the foreground. Auto-started by `afw daemon start`, the
launchers, and launchd / systemd.

```
OPTIONS
  --port <n>       Override default 9877 (or set AFW_PORT).
  --log-level <l>  'debug' | 'info' | 'warn' | 'error'
```

## `afw tap` (internal)

Spawned by wired MCP servers to wrap stdio transports. Bridges stdin/stdout,
parses JSON-RPC frames, ships them to the daemon, and fails open on error.

## User-extensible model pricing

afw ships a bundled price table for Anthropic and OpenAI models. Add prices
for custom models by dropping a JSON file at `~/.afw/pricing.json`:

```json
{
  "openai-chat": {
    "my-model": { "inputCostPerToken": 0.0000003, "outputCostPerToken": 0.00000045 }
  },
  "any": {
    "another-model": { "inputCostPerToken": 0.000001, "outputCostPerToken": 0.000002 }
  }
}
```

Top-level keys are decoder kinds (`anthropic`, `openai-chat`, `openai-responses`)
or `any`. User entries override the bundled defaults; the daemon re-reads on mtime
change — no restart needed.

## See also

- [`../README.md`](../README.md) — install, supported agents, what's captured
- [`../PRIVACY.md`](../PRIVACY.md) — exactly what afw writes and where it sends data
