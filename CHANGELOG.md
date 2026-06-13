# Changelog

All notable changes to `@openguardrails/agentfw`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely; dates are
local to where the release was cut.

## [0.1.0] — unreleased

The firewall cut. `agentfw` is forked from an earlier cost-saver project by
porting its firewall core and dropping the cost-saver/metric surfaces.

### Added

- **Wire tap + live visibility.** Reverse proxy at
  `/wire/<agent>/<provider>/...` that captures and decodes every model call
  (Anthropic, OpenAI chat & responses, Codex) and MCP frame into a common
  `AgentPacket`, persisted to a minimal local SQLite trace store.
- **Per-route model routing.** Point any agent's traffic at any model, with
  failover chains and capability rules. Includes the Claude Code subagent
  classifier — the planner carries the orchestrator-only `Agent` tool,
  subagents never do — so the workers in a Dynamic Workflow can be routed to
  a cheaper model while the planner stays untouched.
- **Security detector pipeline** (`daemon/risk/`). Detectors are pure
  `(packet) => RiskTag[]` functions run over every decoded packet:
  - `secret-leak` — credential shapes in any captured text.
  - `shell-pattern` — dangerous shell commands in tool calls.
  - `prompt-injection` — **indirect prompt injection in untrusted
    `tool_result` content** (instruction-override, role-injection,
    exfiltration, hidden/zero-width characters). The headline agent-firewall
    check and the documented extension point for richer detection.

### Removed (relative to the pre-fork project)

- The "Thomas (T)" outcome-per-token metric and its spec, API route, and
  dashboard view.
- The outcomes/value-detection subsystem and cost-per-task framing.
- The React dashboard and the reporting CLI commands (`list`, `show`,
  `report`, `tail`, `replay`, `tool`, `prune`, `archive`, `rollback`).
