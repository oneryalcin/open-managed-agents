# Handoff

This repository rewards conservative systems engineering.

Think:
- John Carmack on invariants, restart behavior, and concrete failure modes
- Martin Fowler on explicit boundaries and refactoring toward clarity
- Robert C. Martin on readable intent and small surfaces
- Gang of Four only when an abstraction clearly earns its keep

Do not optimize for cleverness. Optimize for correctness, legibility, and stable contracts.

## Current State

_Last updated 2026-07-19 (`dev/alpha-onboarding-hardening`; alpha onboarding
hardening in progress)._

- `main` is the integration branch. Feature/code slices use a short-lived
  `arc-*` or `issue-*` branch → PR → squash-merge. Docs and probe artifacts may
  land with the implementation slice when they are part of its evidence.
- [PARITY.md](PARITY.md) is the product-status source of truth. Do not duplicate
  its full backlog here.
- The synchronous single-agent core is substantially shipped: agents, sessions,
  Docker/microsandbox providers, tools, skills, MCP, vault credentials, SSE,
  CMA `glob`, CMA `grep`, immutable agent versioning, multi-provider model
  selection, and bidirectional session pagination. Sandbox and egress controls
  intentionally exceed the hosted self-hosted baseline in several areas.
- PR #184 shipped provider-owned, bounded, cancellable CMA `glob`; PR #188
  shipped provider-owned CMA `grep`.
- PR #185 shipped session-specific `{data,next_page,prev_page}` pagination with
  signed, workspace-bound cursors and preserved ascending/descending order.
- Probe 67 established hosted agent update/version behavior. Plan 0133 shipped
  immutable revisions, optimistic updates, authenticated version history,
  exact-version runtime pinning, and shared model-catalog admission in PR #186.
- Plan 0139 shipped Pi-backed multi-provider models in PR #195: durable
  `{provider,id}` identity, one shared Pi catalog/auth owner, secret-safe
  CLI/API/console discovery, and local-compatible smoke coverage.
- Standing follow-ups remain `#103`, `#118`, and `#119`; consult GitHub rather
  than this file for their current status.

Treat lifecycle, restart recovery, storage ordering, idempotency, sandbox
provider boundaries, and hosted parity as sharp edges, not routine CRUD.

## Pre-v1 Compatibility Posture

The repository is not public yet and currently has zero users. Until this
changes, backward compatibility with earlier OMA builds is **not** a product
requirement.

- Prefer the cleanest correct schema, API boundary, and runtime invariant over
  compatibility shims for unreleased behavior.
- It is acceptable to reset development databases or make a deliberately
  breaking internal migration when that materially simplifies the design.
- Do not preserve obsolete constructors, optional capabilities, response
  fields, or storage layouts solely because they existed on an earlier branch.
- Add migration/backfill code only when it protects valuable test/development
  data at low complexity or exercises a future production invariant; label it
  as convenience rather than user compatibility.
- This does **not** relax CMA wire-parity, security, durability, or atomicity
  requirements. It only means old unreleased OMA behavior need not be carried
  forward.

Revisit this section before the first public release or external deployment;
at that point compatibility and migration policy must become explicit.

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

## What Landed Recently

Full history belongs in git, plans, and [PARITY.md](PARITY.md). The current
load-bearing additions are:

- **Tool-surface honesty** (PRs #181–#183): closed builtin/policy validation,
  explicit rejection of inert multiagent configuration, and disabled defaults
  for unsupported provider-owned tools.
- **CMA `glob`** (PR #184; plan 0131; probes 65/65b): NUL-safe enumeration,
  bounded matching/output, cancellation, lifecycle cleanup, and poisoned
  sandbox eviction across Docker and microsandbox.
- **Session bidirectional pagination** (PR #185; plan 0132; probe 66): exact
  session envelope, signed workspace-bound cursors, and order-preserving
  backward traversal.
- **Immutable agent versioning** (PR #186; plan 0133; probe 67): transactional
  revisions, optimistic updates, authenticated history, exact-version session
  and runtime pinning, and shared model-catalog admission are shipped.
- **Provider-owned CMA `grep`** (PR #188; plan 0134; probes 68/68b/68c):
  Docker and microsandbox own content search, limits, cancellation, cleanup,
  accounting, and events. Pi's host-process `rg` path is not exposed.
- **Minimal OMA sandbox image** (PR #193; plan 0138; issue #187):
  multi-architecture Alpine image with pinned Bash and ripgrep has been
  published publicly under an immutable digest and is the shared Docker and
  microsandbox default. Anonymous manifest/layer pulls, real Docker grep, and
  the full live microsandbox smoke pass. Microsandbox initializes upload mounts
  as root-owned/read-only and output mounts as writable by UID 65534 while the
  image itself remains non-root by default.
- **Pi-backed multi-provider models** (PR #195; plan 0139):
  agent revisions persist exact provider/model identity, the runtime and
  admission paths share one Pi catalog/auth owner, and `oma smoke
  --local-compatible` proves a no-paid-API custom compatible provider path.

Older shipped arcs remain documented in their ADRs, plans, and merge history;
they are intentionally no longer repeated here.

## Immediate Next Work

1. **Make the first sandbox useful for coding**
   ([#200](https://github.com/oneryalcin/open-managed-agents/issues/200)). The
   current public image is intentionally only Alpine + Bash + ripgrep and was
   verified to lack Node/npm, Python/uv, Git, curl, jq, and build tools. Ship a
   measured, digest-pinned multi-arch coding image without weakening non-root,
   read-only-root, capability, provenance/SBOM, or provider-smoke gates.
2. **Make safe network access selectable and understandable**
   ([#199](https://github.com/oneryalcin/open-managed-agents/issues/199)). The
   console currently creates only
   `limited` + `allowed_hosts: []`. Preserve that offline default, then add
   reviewed npm/PyPI, GitHub + registries, and custom-allowlist choices plus a
   supported `oma up` egress path. Do not expose unrestricted networking, and
   do not couple tool installation to implicit egress.
3. Alpha onboarding hardening shipped in PR #197. The source-checkout path is
   owned by [Getting Started](docs/getting-started.md):
   `npm ci`, `npm link`, `oma doctor`, `oma smoke --local-compatible`,
   `oma up`, workspace-key console login, create agent/environment/session, and
   send a prompt. Automated CLI, doctor, docs, browser, and Docker gates are
   green; the real-human timing gate remains pending.
4. Preserve the `oma doctor` invariant: it is read-only and secret-safe. It
   must not create `~/.oma`, Pi auth/model files, lock files, databases, or pull
   Docker images.
5. The default provider allowlist is `anthropic,openai,openrouter`; credentials
   still gate session admission, Anthropic remains the default model provider,
   and `OMA_MODEL_PROVIDERS` replaces this allowlist when explicitly set.
6. Run the human onboarding gate in
   [docs/references/alpha-onboarding-observation.md](docs/references/alpha-onboarding-observation.md):
   local-compatible median <=10 minutes, credential-supplied console median
   <=15 minutes, and zero undocumented intervention.
5. Track public npm, `npx`, curl, and Homebrew distribution separately in issue
   #196. It is a release/supply-chain project, not part of source-checkout
   onboarding cleanup.
6. Track publication-pipeline promotion hardening separately in issue #194; it
   does not block the verified digest-pinned alpha image.
7. Standing queue: `#103`, `#118`, and `#119`. Postgres/async-store work remains
   gated on a concrete multi-process requirement per ADR 0014.

## Practical Rules for the Next Agent

- Read the issue and the code before proposing the fix.
- If Pi is involved, read the Pi SDK docs first, then inspect installed source.
- If hosted behavior is in scope, probe it before treating it as settled.
- Prefer explicit helpers over ambient conventions.
- If a fix reveals a broader bad assumption, fix the assumption.
- Use reviewers where the risk justifies them.
- Keep the tracker honest when a slice lands.

If you follow those rules here, the codebase tends to get simpler and safer at the same time.
