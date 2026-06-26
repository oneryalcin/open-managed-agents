# Handoff

This repository rewards conservative systems engineering.

Think:
- John Carmack on invariants, restart behavior, and concrete failure modes
- Martin Fowler on explicit boundaries and refactoring toward clarity
- Robert C. Martin on readable intent and small surfaces
- Gang of Four only when an abstraction clearly earns its keep

Do not optimize for cleverness. Optimize for correctness, legibility, and stable contracts.

## Current State

_Last updated 2026-06-11 (main @ `cbd3705`). Earlier `#69 / #51 / #13` queue is
landed/closed; superseded below._

- `main` is the integration branch. Docs/scratch slices commit straight to `main`;
  code slices land via `dev/*` branch → PR → squash-merge.
- Since the last handoff, three arcs landed: **coordinator seams** (ADR 0014, PRs
  #112/#114), **request idempotency** (ADR 0015, PRs #116/#120 — closed `#13`),
  and a **sandbox-provider evaluation** (plans 0106/0107, issue #121). `#51` is
  closed. See "What Landed Recently" below.
- **In-flight:** **PR #122** (`dev/interrupt-message-abort-window`, base `main`,
  OPEN) fixes **#59** cross-request interrupt/message abort-window ordering in
  `src/control-plane/sessions/pi/runner.ts`. Runtime hot path → review with the
  full constellation before merge.
- **Next concrete slice:** first `microsandbox-local` sandbox provider, **fully
  scoped in [docs/plans/0107-sandbox-provider-contract-audit.md](docs/plans/0107-sandbox-provider-contract-audit.md)**
  (issue #121).
- Untracked-on-purpose: `scratch/oma-sandbox-provider-landscape.md` (research copy
  behind a gist). Don't commit/delete without asking.

Treat lifecycle, restart recovery, storage ordering, idempotency, sandbox
provider boundaries, and hosted parity as sharp edges, not routine CRUD.

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

### The independent-verification discipline (non-negotiable)

The refinement this period: on a heavy slice, a background engineer ("codex")
implements on a `dev/*` branch and reports; the review constellation runs; **then
the reviewing agent does its own hands-on verification** — re-read the exact hot
path, write throwaway probes, run the suite, and **adjudicate every reviewer
headline against direct evidence** (code trace or empirical probe) before it
enters the verdict. **Nothing ships on a reviewer's say-so.** Finally, verify the
fix commit directly (diff against the agreed fix list, re-run typecheck + suite)
— and diff the **merge** commit, not just the last commit you reviewed.

Reviewer value is genuinely unpredictable: on PR #120 *both* codex headline
findings were refuted under verification while Opus/Sonnet found the real ones; on
PR #116 plain codex found the best issue while adversarial misfired. Run the
constellation for coverage, not for a vote.

Invoke the codex reviewers in the background (the Claude background flag is what
detaches — `--background` alone does not):

```
node "<plugins>/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" \
  review|adversarial-review "--background --base=main"   # via Bash(run_in_background:true)
```

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
7. **Forgetting the `anthropic-beta` gate.** Managed Agents routes 404 without
   `anthropic-beta: managed-agents-2026-04-01` (`MANAGED_AGENTS_BETA`, `app.ts`);
   Files API needs `files-api-2025-04-14`. A probe missing the header sees a 404
   envelope on every route and looks like a routing bug. Add it to every request.
8. **Confounded probes that pass multiple reviewers.** A microsandbox "rootfs
   doesn't survive stop/start" finding passed codex's probe *and* a first
   reproduction — both wrote to `/tmp`, which is mounted **tmpfs**. Caught only by
   reading the config dump skeptically. Verify the actual environment (mount
   table, config) before generalizing a filesystem/environment result.
9. **Probing before searching the upstream tracker.** microsandbox#646 already
   documented the plain-HTTP secret behavior we "discovered". Search upstream
   issues/examples *before* designing a decisive probe.
10. **`await` in a SQLite commit path.** `node:sqlite` `DatabaseSync` is
    synchronous on purpose; the coordinators' atomicity depends on no interleaving
    inside `withSqliteTransaction`. Don't async-ify stores without re-reading ADR 0014.
11. **Editing `~/.npmrc` to probe a new package.** It has a time-gate and
    `ignore-scripts=true`. Use a temp `NPM_CONFIG_USERCONFIG` in a throwaway dir;
    never mutate the user's npmrc. (`tsx --eval` with top-level await also fails —
    use a scrap file with `async main()`.)

The meta-rule:

**Check the whole contract surface, not a representative sample.**

### The capability-injection lesson (bit us three times this period)

Capability selection by **duck-typing / optional-method-presence at call time
silently downgrades guarantees** — first atomicity (twice, in the coordinators),
then secret protection (sandbox). Every fix had the same shape:

> Inject the capability explicitly at composition time; **fail fast at
> construction** if a required capability is absent. Never select correctness-
> bearing behavior by sniffing for an optional method when the call happens.

Generalized as plan 0107 **audit conclusion #8**: *capability mismatches should
fail at session/provider creation time, not when the first tool tries to use the
missing feature.* If you write `if (obj.maybeMethod) {…} else {best-effort}` in a
correctness path, stop — that is this anti-pattern in a new coat.

## Definition of Done

A slice is done when:
- the contract is grounded by probe or primary source
- invariants are explicit
- tests pin the real failure mode
- the code was re-read after implementation
- typecheck and relevant tests pass
- issue/PR tracker state matches the code
- deferred work is either fixed now or clearly ticketed

## What Landed Recently (arcs since the last handoff)

Full detail lives in-repo; this is the index + the one invariant to carry from each.

- **Coordinator seams** (ADR 0014; PRs #112, #114). Real cross-store invariants
  moved behind deployment-level coordinators: durable mode = atomic (shared
  `DatabaseSync`, SAVEPOINT-re-entrant `withSqliteTransaction`), in-memory =
  best-effort. *"No await in the commit path" is load-bearing.* `#113` (open)
  audits remaining seams.
- **Request idempotency** (ADR 0015; PRs #116 events.send, #120 sessions.create —
  closed `#13`). The design insight: **ledger completion happens inside the domain
  transaction**, which turns crash recovery from policy into theorem (a surviving
  `in_progress` row provably means no committed side effect). Async create paths
  use a status-guarded **heartbeat** to keep "abandoned ⟹ dead" true for
  live-but-slow requests. Cookbooks: `retry-safe-events-send.md`,
  `retry-safe-session-create.md`, `client-retry-and-cleanup.md`. `#118/#119` (open)
  defer upload + streaming idempotency.
- **Session lifecycle** (plan 0104; `faab4e9`). Pinned: archive keeps live SSE
  streams open; delete force-closes after terminal `session.deleted`. Cookbook
  `session-lifecycle-flow.md`.
- **Sandbox provider evaluation** (plans 0106/0107; scratch probes 0106–0109;
  issue #121). Landscape + provider-contract audit + hands-on probes of Docker
  Sandboxes, microsandbox, and Anthropic `sandbox-runtime`. Pinned in 0107:
  the **explicit-persistence invariant** (session workspace = explicit durable
  mount/volume/disk; rootfs is disposable), **create-time capability rejection**
  (audit conclusion #8), and **secrets gated out of v1** (substitution only runs
  in the TLS-interception path, which failed locally; upstream
  microsandbox#646/#752/#769/#969 confirm).

## Immediate Next Work

1. **Finish PR #122 (`#59`)** — review the fix commit with the constellation,
   then merge. Interrupt/message abort-window ordering in the runtime hot path.
2. **First `microsandbox-local` provider slice** — fully scoped in plan 0107 and
   issue #121: execution, files, explicit volumes, explicit network policy,
   logs/metrics; **no secret proxy** (rejected at create time, error pointing at
   the gate). This is the bigger bite; everything it needs is pinned.
3. **Standing queue (evidence-gated):** `#113` coordinator seam audit
   (opportunistic); `#107` SQLite scaling (200–400 sessions); `#103` deployment
   hardening; `#16` Pi runtime production rollout policy; `#118/#119` upload +
   streaming idempotency. Postgres / async-store boundary stays gated on a
   concrete multi-process need per ADR 0014 (exploratory `dev/async-store-boundary`
   branch — do not merge speculatively).

## Practical Rules for the Next Agent

- Read the issue and the code before proposing the fix.
- If Pi is involved, read the Pi SDK docs first, then inspect installed source.
- If hosted behavior is in scope, probe it before treating it as settled.
- Prefer explicit helpers over ambient conventions.
- If a fix reveals a broader bad assumption, fix the assumption.
- Use reviewers where the risk justifies them.
- Keep the tracker honest when a slice lands.

If you follow those rules here, the codebase tends to get simpler and safer at the same time.
