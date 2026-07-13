# Handoff

This repository rewards conservative systems engineering.

Think:
- John Carmack on invariants, restart behavior, and concrete failure modes
- Martin Fowler on explicit boundaries and refactoring toward clarity
- Robert C. Martin on readable intent and small surfaces
- Gang of Four only when an abstraction clearly earns its keep

Do not optimize for cleverness. Optimize for correctness, legibility, and stable contracts.

## Current State

_Last updated 2026-07-13 (`arc-f-glob-grep-honesty`, probe 64 complete;
validation: focused tests)._

- `main` is the integration branch. Feature/code slices use a short-lived
  `arc-*` or `issue-*` branch → PR → squash-merge. Docs and probe artifacts may
  land in the same reviewable branch when they are part of an active slice.
- The current product-status source is [PARITY.md](PARITY.md): it records the
  CMA comparison, deliberate non-goals, evidence-backed gaps, and the ordered
  pre-v1 worklist.
- The synchronous single-agent core is substantially shipped: agents, sessions,
  Docker/microsandbox providers, tools, skills, MCP, vault credentials, and SSE.
  Sandbox security and egress controls intentionally exceed the hosted
  self-hosted baseline in several areas.
- MCP OAuth and runtime token refresh are shipped (M2/M3, commits `0d96505` and
  `c980b4b`), including validate, wake-loop refresh, live smoke, and secret
  scrubbing. The console vault/MCP surface is also landed.
- Custom skills are shipped (PR #174, `26f754d`): per-file storage and
  validation, version admission, copy-at-create session snapshots, sandbox
  materialization, and Pi 0.80.6 progressive-disclosure delivery.
- Running-session deletion parity is shipped (PR #179, merge `ff2ae54`): the
  hosted 400 contract is probed, and `DefaultSessionService` requires the
  liveness guard at construction before deletion can mutate state.
- The networking parity slice is merged to `main` via PR #180: CMA `limited`
  host lists translate to normalized HTTPS/443 exact or `*.` wildcard allow
  entries; hosted empty lists remain dark; unsupported unrestricted,
  package-manager, and MCP flags are explicit 400s. Environment creation and
  session admission validate before side effects, while legacy malformed rows
  fail closed in the resolver. Native OMA networking remains unchanged.
- Tool-config validation is merged to `main` via PR #181. Probe 63 established
  the hosted builtin vocabulary, accepted policies, duplicate rejection,
  implicit defaults, and validation precedence; OMA now enforces those closed
  sets while keeping MCP names server-defined.
- Multiagent honesty is merged to `main` via PR #182. Non-null
  `multiagent` configurations now reject before persistence with a stable 400;
  the full coordinator runtime remains deferred.
- The glob/grep slice is active on `arc-f-glob-grep-honesty`. Pi 0.80.6 source
  inspection and probe 64 are complete; OMA will reject these names honestly
  until sandboxed Docker/microsandbox search operations exist.
- Issues `#16`, `#107`, `#113`, and `#121` are closed. `#103`, `#118`, and `#119`
  remain open follow-up work; PR #169 / issue #164 is the events-service split.

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

- **Coordinator seams** (ADR 0014; PRs #112/#114). Durable mode remains atomic
  through the shared `DatabaseSync` transaction boundary; in-memory mode is
  explicitly best-effort. *No await in the commit path* remains load-bearing.
- **Request idempotency** (ADR 0015; PRs #116/#120). Completion stays inside the
  domain transaction, with a status-guarded heartbeat for slow async creates.
  Upload and streaming idempotency remain the deliberate `#118/#119` follow-up.
- **Pi runtime and sandbox providers** (PRs #122/#123/#125; plans 0106/0107).
  Interrupt coalescing, microsandbox-local, Docker isolation, explicit durable
  workspace mounts, provider gates, and create-time capability rejection are
  shipped. The runtime rollout policy itself is closed under issue #16.
- **MCP connector and vault credentials** (PRs #167/#171/#172). Static bearer
  and OAuth credentials, refresh coordination, runtime token injection,
  validate, ticker wake-up, live smoke, and secret scrubbing are shipped.
- **Console vault/MCP operations** (PR #173) provide credential browse, health,
  and validation views without exposing secret material.
- **Custom skills execution** (PR #174, `26f754d`). Upload validation, per-file
  storage, attachment/read coupling, immutable session snapshots, sandbox
  delivery, and Pi 0.80.6 resource-loader advertisement are all smoke-tested.
- **Product parity tracker** (`PARITY.md`, `296582b`) is now the standing
  source of truth for CMA gaps and deliberate post-v1 deferrals.
- **Running-session delete parity** (PR #179, `ff2ae54`) is probe-backed and
  constructor-guarded. A direct service caller cannot omit the liveness
  preflight without failing construction/typecheck.
- **CMA networking parity** (plan `0127`, probe 62) is merged via PR #180:
  bounded hosted translation, fail-closed parsing, HTTPS transport enforcement,
  API-400 mapping, and Docker/in-process policy coverage are in place.
- **Tool-config validation** (plan `0128`, probe 63) is merged via PR #181:
  hosted builtin names and permission policies are closed sets, duplicate
  builtin configs are rejected, implicit defaults are materialized, and MCP
  names remain server-defined.
- **Multiagent honesty** (plan `0129`) is merged via PR #182: every non-null
  configuration is rejected before persistence; null/absent values remain
  compatible and legacy rows remain readable.
- **Unsupported builtin honesty boundary** (plan `0130`, probe 64) is
  implemented in the current branch: omitted `glob`, `grep`, `web_fetch`, and
  `web_search` materialize as disabled deployment defaults; explicit configs
  reject only when effectively enabled. Legacy rows remain readable.

## Immediate Next Work

1. **Finish the pre-v1 trust pass** — implement CMA-facing `glob` by adapting
   the safe glob operations already available in Docker and microsandbox.
   Keep `grep` rejected until providers own content search and a deterministic
   search-binary strategy. Use `PARITY.md` for ordering rather than this handoff
   as an independent backlog.
2. **Pagination and agent update/versioning** — probe pagination semantics,
   then add the highest-value missing core workflow: agent update plus
   versioning.
3. **Standing queue (evidence-gated):** `#103` deployment hardening and
   `#118/#119` upload + streaming idempotency. Postgres/async-store work remains
   gated on a concrete multi-process need per ADR 0014; do not merge it
   speculatively. PR #169 / issue #164 (events-service split) is parallelizable.

## Practical Rules for the Next Agent

- Read the issue and the code before proposing the fix.
- If Pi is involved, read the Pi SDK docs first, then inspect installed source.
- If hosted behavior is in scope, probe it before treating it as settled.
- Prefer explicit helpers over ambient conventions.
- If a fix reveals a broader bad assumption, fix the assumption.
- Use reviewers where the risk justifies them.
- Keep the tracker honest when a slice lands.

If you follow those rules here, the codebase tends to get simpler and safer at the same time.
