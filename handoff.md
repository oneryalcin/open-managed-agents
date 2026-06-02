# Handoff

This repository rewards conservative systems engineering.

Think:
- John Carmack on invariants, restart behavior, and concrete failure modes
- Martin Fowler on explicit boundaries and refactoring toward clarity
- Robert C. Martin on readable intent and small surfaces
- Gang of Four only when an abstraction clearly earns its keep

Do not optimize for cleverness. Optimize for correctness, legibility, and stable contracts.

## Current State

- `main` is the integration branch.
- `#69` landed durable runtime waits and recovery on `main`.
- `#14` is closed and reconciled to `#69`.
- The next queued issues are:
  - `#51` snapshot orphan-sweep / delete ordering before any durable file backend
  - `#13` request-level idempotency for custom-tool results

Treat lifecycle, restart recovery, storage ordering, and hosted parity as sharp edges, not routine CRUD.

## How We Work

### 1. Read before proposing

Before changing code:
- read the issue or PR directly
- check branch and worktree state
- read the relevant code paths
- identify the real boundary being changed

Do not infer repo behavior from summaries alone.

### 2. Probe external contracts before freezing them

If a behavior depends on the hosted API or an external engine, probe it first if the probe is cheap.

We have repeatedly found real bugs by probing:
- interrupt semantics
- archive semantics
- requires-action archive behavior
- beta-header behavior
- file-resource mount behavior

If the contract depends on Pi, read the upstream Pi SDK docs first, then inspect the installed package source. This is a standing rule.

Start with:
- [docs/adrs/0001-use-pi-agent-sdk-as-engine.md](docs/adrs/0001-use-pi-agent-sdk-as-engine.md)
- [docs/adrs/0005-custom-tools-as-blocking-async-functions.md](docs/adrs/0005-custom-tools-as-blocking-async-functions.md)
- [docs/adrs/0012-session-continuity-before-c3-live.md](docs/adrs/0012-session-continuity-before-c3-live.md)

### 3. Plan before coding when the slice has teeth

Use a written plan for work involving:
- lifecycle transitions
- concurrency
- runtime recovery
- storage ordering
- hosted parity
- cross-store atomicity

A good plan states:
- scope
- non-goals
- invariants
- failure model
- acceptance criteria

Examples:
- [docs/plans/0013-0014-0051-durable-runtime-and-storage.md](docs/plans/0013-0014-0051-durable-runtime-and-storage.md)
- [docs/plans/0037-archive-running-session-parity.md](docs/plans/0037-archive-running-session-parity.md)
- [docs/plans/0043-session-file-resource-control-plane.md](docs/plans/0043-session-file-resource-control-plane.md)
- [docs/plans/0046-beta-header-enforcement.md](docs/plans/0046-beta-header-enforcement.md)

### 4. Keep the implementation boring

Prefer:
- existing repo patterns
- explicit helpers
- typed records and boundaries
- narrow, obvious control flow

Avoid:
- speculative abstraction
- hidden lifecycle behavior
- “best effort” semantics where durable truth is required
- stringly-typed state leaks when a typed helper can centralize the rule

If a concern depends on composite identity, encode it directly. A recent example: runtime and lifecycle guards had to be keyed by `(workspaceId, sessionId)`, not `sessionId` alone.

### 5. Fight entropy when you see it

When a fix exposes a broader bad assumption, fix the assumption, not only the symptom.

Examples of the kind of entropy worth removing:
- dead context or state
- inconsistent keying rules
- duplicate lifecycle logic
- implicit cross-store ordering assumptions
- silent divergence from hosted behavior without a named non-goal

This codebase improves when hidden assumptions become explicit helpers, explicit tests, or explicit tickets.

### 6. Re-read the load-bearing code after coding

Do not trust the diff shape alone.

After implementing:
- re-read the exact hot path
- re-check the invariant you intended to protect
- confirm negative paths and restart paths

### 7. Test proportionately

For small route or CRUD work:
- focused tests are enough

For lifecycle or recovery work:
- test ordering
- test duplicate delivery
- test restart behavior
- test cross-workspace isolation
- test negative paths

Use [docs/adrs/0008-contract-test-patterns.md](docs/adrs/0008-contract-test-patterns.md) as the standard for contract coverage, and keep [docs/adrs/0009-sse-stream-reconnect-invariants.md](docs/adrs/0009-sse-stream-reconnect-invariants.md) in mind when touching event delivery or recovery.

## Review Cadence

Review intensity should match risk.

### Light review

Use for contained CRUD or simple route changes:
- source read
- focused validation
- maybe one adversarial pass

### Heavy review

Use for:
- concurrency
- restart recovery
- runtime ownership
- storage/materialization
- lifecycle transitions
- cross-store ordering
- hosted parity decisions

Cadence:
1. probe
2. plan
3. adversarial review of the plan
4. implement
5. source verification
6. tests
7. heavier reviewer passes if warranted

Reviewer disagreement is signal. It often means the contract is inferred rather than proven.

## How to Use Reviewers

Use reviewers selectively, not theatrically.

- Codex adversarial: best at concrete failure cases and bad assumptions
- Codex normal: useful second pass on contract/code behavior
- Sonnet: strongest on test completeness and catching “theater tests”
- Opus: strongest on concurrency, lifecycle, and primary-source reasoning
- Simplifier: cleanup once correctness is already settled

Do not run the full constellation on low-risk changes just because it exists.

## Architectural Defaults

### Typed boundaries

Push behavior into typed interfaces and typed persisted records where possible.

Relevant ADRs:
- [docs/adrs/0002-typescript-end-to-end.md](docs/adrs/0002-typescript-end-to-end.md)
- [docs/adrs/0011-tool-correlation-id-model.md](docs/adrs/0011-tool-correlation-id-model.md)

### One source of truth per concern

Examples:
- server `sevt_*` IDs are public correlation truth; internal `toolu_*` IDs stay internal
- accepted runtime turns and pending action state should have one durable ledger
- session continuity is keyed by `sesn_*`

Relevant ADRs:
- [docs/adrs/0005-custom-tools-as-blocking-async-functions.md](docs/adrs/0005-custom-tools-as-blocking-async-functions.md)
- [docs/adrs/0011-tool-correlation-id-model.md](docs/adrs/0011-tool-correlation-id-model.md)
- [docs/adrs/0012-session-continuity-before-c3-live.md](docs/adrs/0012-session-continuity-before-c3-live.md)

### Persist-before-publish

Event and runtime work should respect the event-store invariants already adopted in the repo. If you touch event delivery or recovery, re-read:
- [docs/adrs/0007-flue-patterns-we-are-borrowing.md](docs/adrs/0007-flue-patterns-we-are-borrowing.md)
- [docs/adrs/0009-sse-stream-reconnect-invariants.md](docs/adrs/0009-sse-stream-reconnect-invariants.md)

### No hidden interleaving when correctness depends on ordering

If a correctness rule depends on “nothing can start between these two operations,” keep the critical block synchronous and obvious.

This mattered in archive preflight work and still matters for future storage ordering work.

See:
- [docs/plans/0037-archive-running-session-parity.md](docs/plans/0037-archive-running-session-parity.md)
- [docs/plans/0061-archive-preflight-toc-tou-guard.md](docs/plans/0061-archive-preflight-toc-tou-guard.md)

## Known Failure Modes In This Repo

These have all bitten real work already:

1. Generalizing from one happy-path probe instead of the whole contract surface
2. Assuming hosted behavior instead of probing it
3. Relying on in-memory guards across restart
4. Assuming IDs are globally unique when workspace scoping actually matters
5. Returning success after “best effort” cleanup where durable truth is required
6. Shipping a divergence from hosted behavior without explicitly naming it as a non-goal

The meta-rule:

**Check the whole contract surface, not a representative sample.**

## Definition of Done

A slice is done when:
- the contract is grounded by probe or primary source
- invariants are explicit
- tests pin the real failure mode
- the code was re-read after implementation
- typecheck and relevant tests pass
- issue/PR tracker state matches the code
- deferred work is either fixed now or clearly ticketed

## Immediate Next Work

### `#51` snapshot orphan-sweep / delete ordering

This is a real boundary problem, not a cleanup chore.

Current delete ordering drops snapshot metadata before confirming byte deletion. That is safe with the current in-memory file store, but it becomes wrong once file deletion is real I/O.

Start with:
- [docs/plans/0013-0014-0051-durable-runtime-and-storage.md](docs/plans/0013-0014-0051-durable-runtime-and-storage.md)
- [docs/adrs/0013-file-resources-and-session-mounts.md](docs/adrs/0013-file-resources-and-session-mounts.md)

The point of `#51` is to avoid silent orphaned snapshot bytes and leaked quota once durable file storage exists.

### `#13` request-level idempotency

Do not conflate this with the durable runtime wait work from `#69`.

`#69` handled durable waits, turn recovery, replay safety for in-flight action submissions, and stale-owner fencing.

`#13` is still open because full request-level idempotency for duplicated `user.message` requests remains separate.

## Practical Rules for the Next Agent

- Read the issue and the code before proposing the fix.
- If Pi is involved, read the Pi SDK docs first, then inspect installed source.
- If hosted behavior is in scope, probe it before treating it as settled.
- Prefer explicit helpers over ambient conventions.
- If a fix reveals a broader bad assumption, fix the assumption.
- Use reviewers where the risk justifies them.
- Keep the tracker honest when a slice lands.

If you follow those rules here, the codebase tends to get simpler and safer at the same time.
