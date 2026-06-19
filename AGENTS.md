# AGENTS.md

This project's agent/contributor instructions live in
[`CLAUDE.md`](./CLAUDE.md). Read that first — it is the single source of
truth for what `afw` is (an AI agent firewall on the wire), the naming
contract, the repo layout, the tech stack, and the load-bearing gotchas.

Quick orientation:

- **What it is:** a local proxy that taps the wire between agents and their
  model providers, to **see** traffic, **route** each request to a chosen
  model, and **guard** it with security detectors over untrusted tool-call
  content.
- **Where the code is:** `packages/afw/src/` — `daemon/proxy/` (wire),
  `daemon/risk/` (the detector pipeline), `daemon/orchestrator/subagent.ts`
  (the Claude Code model-routing classifier).
- **Don't:** import from `references/` (frozen study material, incl. the
  pre-fork `openthomas/` tree); re-grow the dropped cost-saver metric
  surfaces; add telemetry.

See [`CLAUDE.md`](./CLAUDE.md) for the full contract.
