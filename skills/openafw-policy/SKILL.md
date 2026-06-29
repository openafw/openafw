---
name: openafw-policy
description: >-
  Propose changes to the openafw (afw) OGR gateway security policy — the
  detectors that guard an agent's traffic on the wire. Use this when the operator
  asks to tighten or loosen afw's guardrails: change how prompt injection or
  secret leakage is handled, or add/remove a command rule (e.g. "block rm -rf",
  "hold curl|bash for approval", "stop redacting secrets"). You DRAFT and PROPOSE;
  a human must APPROVE before anything takes effect.
---

# openafw policy (OGR gateway altitude)

afw is the OGR **gateway** altitude: it taps the wire between an agent and its
model provider, normalizes traffic into OGR GuardEvents, and runs composed
detectors over them per `~/.afw/ogr.policy.json`. This skill is how you change
that policy **safely**.

## The non-negotiable rule

1. **You may propose. You may not approve.** Every edit you make stages a
   *proposal* (`~/.afw/ogr.policy.proposed.json`). It does NOT enforce anything.
   A human promotes it with `afw ogr approve`, which is interactive and refuses
   to run non-interactively — so you cannot approve it yourself, by design.
2. **Never try to route around the gate.** Do not edit `~/.afw/ogr.policy.json`
   directly, do not pipe input into `afw ogr approve`, do not call the daemon's
   approve API. If you are tempted to, stop and tell the operator instead.

If you cannot get a human to approve, the policy does not change. That is correct.

## Flow: inspect → propose → hand off

### 1. Inspect what is enforcing now
```
afw ogr show
```
Shows the live (enforced) policy, the detectors, and any pending proposal.

### 2. Propose the change the operator asked for

Content-rule decisions (how injection / secrets are handled):
```
afw ogr content --injection-untrusted block          # injection in untrusted tool output
afw ogr content --injection-unverified require_approval   # injection in user text
afw ogr content --redact-secrets                     # or --no-redact-secrets to block instead
```

Command rules (deterministic patterns over tool-call arguments):
```
afw ogr rule add --regex 'rm\s+-rf\s+/' --decision block --why "destructive delete"
afw ogr rule add --id pipe-sh --regex '(curl|wget)\b.*\|\s*(ba)?sh' \
                 --decision require_approval --why "remote script piped to shell"
afw ogr rule rm pipe-sh
```

A decision is one of: `allow | modify | redact | require_approval | block`.

To propose a whole policy you drafted as a file:
```
afw ogr propose --file ./ogr.policy.json     # canonical OGR format; see `afw ogr default`
```

### 3. Show the operator and hand off — do NOT approve

Run `afw ogr show` to display the proposal, summarize it in plain language, and
ask the operator to approve:

> I've proposed: <what changes, in one or two lines>. It is staged but NOT
> enforced. To apply it, run `afw ogr approve` (you'll be asked to confirm), or
> approve it in the afw dashboard (Guard tab). To discard it: `afw ogr reject`.

Then stop. Do not claim the policy is in effect until the operator approves it.

## Notes

- The bundled default policy is used when no file exists — `afw ogr default`
  prints it as a canonical starting point.
- Approving reloads the live policy in the running daemon automatically; no
  restart needed.
- Reference: the OGR standard at https://openguardrails.com (this skill is the
  afw-specific binding of its policy/approval flow).
