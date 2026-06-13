# CLI

The `agentfw` binary, installed by `npm install -g @openguardrails/agentfw`.

agentfw never rewrites an agent's shared config. How you connect an agent
depends on its **runtime form**:

- **CLI agents** (Claude Code, Codex) — *launch* them through agentfw:
  `agentfw claude`, `agentfw codex`. Per-instance, per-directory, no global change.
- **App / daemon agents** (Claude Desktop, OpenClaw, Hermes) — run the matching
  command to print **setup instructions**; you point their model base URL at the
  wire yourself.
- **Models** — register the upstreams agentfw can route to with `agentfw model add`.

## Commands at a glance

```
LAUNCH (CLI agents)
  agentfw claude [-- <args>]      Launch Claude Code through agentfw (this instance).
  agentfw codex  [-- <args>]      Launch Codex through agentfw (this instance).
  agentfw run -- <cmd> [args…]    Explicit per-instance launcher (advanced).

CONNECT (app / daemon agents — prints instructions, edits nothing)
  agentfw claude-desktop          How to point Claude Desktop at the wire.
  agentfw openclaw                How to point OpenClaw at the wire.
  agentfw hermes                  How to point Hermes at the wire.

CONFIGURE
  agentfw model add               Add model providers (interactive, validated).
  agentfw model list              List registered providers and models.
  agentfw route                   Per-agent model routing, failover, subagent saver.

INSPECT
  agentfw                         Open the UI (default subcommand).
  agentfw status                  Daemon + tap health.

UPDATE
  agentfw update                  Update agentfw to the latest version.

INTERNAL  (users don't call these directly)
  agentfw daemon                  Run the daemon in foreground (launchd target).
  agentfw tap --agent X --server Y -- <cmd> [args…]   stdio MCP wrapper.
```

The default subcommand when `agentfw` is called with no args is `ui`.

---

## `agentfw claude` / `agentfw codex` (CLI launchers)

Launch one instance of a CLI agent pointed at agentfw, **for that process only** —
the agent's global config is never touched (it's done via a per-process override:
Claude Code's `--settings`, Codex's `-c` flags). The first launch in a project is
remembered, so a later bare `agentfw claude` in the same directory reuses it.

```
USAGE
  agentfw claude [options] [-- <agent args>]
  agentfw codex  [options] [-- <agent args>]

OPTIONS
  --model <id>   Route this instance to a single model (remembered for this dir).
  --monitor      Capture but never reroute.
  --raw          Bypass agentfw entirely for this launch.
  --as <label>   Instance label (defaults to a per-directory id).
  --ephemeral    Forget the instance routing policy when it exits.
```

On launch agentfw: starts the daemon if it isn't running, registers the
firewall-side route + credentials for the agent (so the proxy can forward and
authenticate), applies/persists this directory's routing choice, then spawns the
agent. Anything after `--` is passed straight to the agent.

```
agentfw claude --model claude-sonnet-4-6 -- -p "summarize CHANGELOG.md"
agentfw claude                       # reuse this dir's remembered choice
agentfw codex --monitor              # capture, never reroute
```

---

## `agentfw claude-desktop` / `agentfw openclaw` / `agentfw hermes` (connect)

These print step-by-step instructions and change nothing. App and daemon agents
are configured from their own UI / config file; agentfw only tells you the wire
URL (`http://localhost:9877/wire/<agent>`) and the `model add` / `route set`
commands to run. Cursor and Gemini have the same instruction form.

---

## `agentfw model add`

Interactively register one or more model providers agentfw can route to. For each
provider it prompts for the base URL, API compatibility (`auto` / `openai-chat` /
`openai-responses` / `anthropic`), API key, model id(s), and image support, then
**validates with a live probe** before registering. Repeats until you're done.

```
USAGE
  agentfw model add                  # interactive, multi-provider (live-probed)
  agentfw model list                 # show registered providers + models
  agentfw model rm <id>              # remove a model

PROVIDERS  (scriptable)
  agentfw model provider add <id> --base-url <url> --api <api>
                  [--auth passthrough|bearer|api-key] [--header <name>] [--label <text>] [--key <value>]
  agentfw model provider rm|list

SECRETS  (write-only — values never read back)
  agentfw model secret set|rm|list <ref>
```

`--api` is the wire format: `anthropic-messages`, `openai-chat`, or
`openai-responses`. agentfw translates between all three. Provider registration
has the scriptable `agentfw model provider add` form above; adding a model is
interactive only (the wizard asks whether it accepts image input — answer yes
for a multimodal model). API keys go to `~/.agentfw/secrets.json` (mode `0600`)
and are only ever sent to the upstream you configured.

---

## `agentfw route`

Reconfigure which model(s) an agent's traffic reaches — without touching the
agent's config. Talks to the running daemon. A route is keyed
`<agent>/<sourceModel>` (or the wildcard `<agent>/*`); every route is plain
passthrough until you opt it in.

```
ROUTES
  agentfw route list
  agentfw route show <routeKey>
  agentfw route set  <routeKey> --model <id> | --chain <id> [--chain <id>…] | --passthrough
  agentfw route unset <routeKey>
  agentfw route vision <routeKey> [--companion <id> [--provider <id>] | --off]

SUBAGENT COST-SAVER  (Claude Code dynamic workflows)
  agentfw route subagent [--on|--off] [--model <id>] [--floor <maxTokens>]
```

Providers, models, and secrets are registered under `agentfw model` (see above);
`agentfw route` only decides where a registered model's traffic goes. `--chain`
builds an error-failover chain (each member but the last advances on upstream
error).

`route vision` pairs a **text-only routed model with a multimodal companion**.
When the routed model can't see images, agentfw side-calls the companion to
describe them first, then runs the routed model on the request with those
descriptions spliced in. Register the companion with image input (`agentfw
model add`, answer yes to image input), then pin it onto the route — e.g.
`agentfw route set claude-code/* --model glm-4.6` followed by `agentfw route
vision claude-code/* --companion gpt-4o-mini`.

---

## `agentfw status`

Shows daemon + tap health, recent activity, and any config drift from a prior
setup. Exits non-zero if the daemon isn't responding.

---

## `agentfw update`

Update agentfw to the latest published version: the trace DB is snapshotted, the
new version is health-checked after restart, and a failed update auto-rolls-back.

```
OPTIONS
  --check    Only report whether a new version exists.
  --force    Restart immediately instead of waiting for an idle window.
```

The daemon also checks once a day against the public npm registry — no data about
you is sent (see [`PRIVACY.md`](../PRIVACY.md)); disable with `updateCheck: false`
in `~/.agentfw/config.json`.

---

## `agentfw daemon` (internal)

Run the daemon in the foreground. Auto-started by the launchers; also called by
launchd / systemd.

```
OPTIONS
  --port <n>       Override default 9877 (or set AGENTFW_PORT).
  --log-level <l>  'debug' | 'info' | 'warn' | 'error'
```

## `agentfw tap` (internal)

Spawned by wired MCP servers to wrap stdio transports. Bridges stdin/stdout,
parses JSON-RPC frames, ships them to the daemon, and fails open on error.

## User-extensible model pricing

agentfw ships a bundled price table for Anthropic and OpenAI models. Add prices
for custom models by dropping a JSON file at `~/.agentfw/pricing.json`:

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
- [`../PRIVACY.md`](../PRIVACY.md) — exactly what agentfw writes and where it sends data
