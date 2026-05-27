# ADR 0007: Borrow Flue's algorithm-level patterns, not the framework

**Status:** Accepted, 2026-05-21

## Context

[ADR 0004](0004-managed-agents-rest-sse-surface-as-north-star.md) rejected Flue (`withastro/flue`) as a *framework* choice — its filesystem-based agents, build artifacts, and `init()`/`harness()`/`session()` factory conventions conflict with our persisted-API-object model.

A subsequent reviewer pass cloned Flue at commit `3b2a55f` and validated the runtime independently: **42/42 runtime tests passed, 6/6 SDK tests passed, runtime/SDK/CLI builds + typechecks succeeded.** With Flue's runtime confirmed as functional, the reviewer curated specific algorithm-level patterns worth lifting — separate from the framework shape we explicitly don't want.

This ADR records what we accept from that curation, what we modify, and what we explicitly decline.

## Decision

Lift four well-bounded algorithm-level patterns from Flue's runtime, with attribution. Do not lift Flue's framework, event vocabulary, session-history model, or filesystem-based agent definition (those remain rejected per ADR 0004).

## Patterns we lift

### 1. Replay-then-tail SSE algorithm

Subscribe a live-event listener to the broadcaster **before** replaying durable history from the event store. Replay is **paginated** via a cursor (the last yielded ID), so reconnects that miss more than one page of events recover the full history. Live events arriving during replay are buffered in a **bounded** queue; on overflow, the queue is dropped and the subscriber refetches from the store using the last-yielded ID as the cursor. After replay, the subscriber tails live events, deduping any overlap via `id <= lastYieldedId`.

The pattern eliminates the "gap during reconnect" failure mode that pure live-broadcast SSE has, while keeping memory bounded against slow consumers / long publish bursts.

- **Source:** `packages/runtime/src/runtime/handle-run-routes.ts:73`
- **Adaptation:** Flue uses a numeric `eventIndex` cursor; we use stable UUIDv7 `sevt_…` IDs. Both implementations include paginated replay, bounded live buffer, refetch-on-overflow, and dedup-on-drain. Empirically verified in `scratch/05-event-store.ts` Parts 1–5 — round-trip, full-history replay, replay-then-tail under concurrent publishes, 1500-event pagination, 15K-event overflow recovery; all pass with `0` duplicates and strict ID ordering.

### 2. Persist-before-publish fanout

Persist non-terminal events to durable storage *before* broadcasting to live subscribers. A subscriber that misses the live broadcast can still recover the event via `events.list`. This invariant is already present in our `architecture.md` § Event log; Flue's implementation validates the pattern.

- **Source:** `packages/runtime/src/runtime/handle-agent.ts:553`

### 3. Lifecycle-separation for sandbox adapters (with one nuance)

Flue separates `SandboxApi` (file/shell primitives) from `SessionEnv` (cwd/path resolution, abort checks). The *principle* — sandbox provisioning lifecycle is owned by a different object than the per-call exec adapter — is correct and worth adopting.

**Nuance:** we do NOT introduce a parallel `SandboxApi` interface alongside Pi's typed `*Operations` interfaces (`BashOperations`, `ReadOperations`, `WriteOperations`, etc.). Pi already exposes the file/shell primitives layer; introducing a duplicate would be abstraction-on-abstraction. We borrow only the lifecycle-separation principle:

```
ManagedSandbox  (our wrapper — owns provisioning lifecycle)
├── provision()    → starts a Modal sandbox
├── destroy()      → stops it
├── mount(r)       → file/repo mounts
├── outputs()      → reads /mnt/session/outputs/
└── tools(cwd)     → returns AgentTool records for Pi's active tool list,
                     built by feeding OUR Operations impls into Pi's
                     create*Tool(cwd, {operations: ...}) factories
```

The `ManagedSandbox` wrapper owns lifecycle; the `*Operations` interfaces (Pi's types) handle per-call file/shell adaptation. Two layers, each doing one thing.

- **Sources:** `packages/runtime/src/sandbox.ts:167`, `docs/sandbox-connector-spec.md:31`
- **Updates [ADR 0003](0003-pluggable-sandbox-interface-modal-first.md)** — see its Findings (post code-review) section, which already pre-empted this with the same shape.

### 4. Structured error taxonomy (caller-safe vs developer-only)

Public error fields (`type`, `message`) are safe to send to API clients; developer detail (stack traces, internal paths, file system layout) stays in server logs. Adapt to Anthropic's error envelope shape per ADR 0004 Tier 1: `{ type: "invalid_request_error" | "rate_limit_error" | ..., message: "..." }`. Local-only fields (stack, cause chain, internal context) on a separate object that the API serializer drops.

- **Source:** `packages/runtime/src/errors.ts:23`

### Implementation prior art (cited, not architecture)

These aren't separate patterns — they're concrete recipes worth following when we implement the corresponding component:

- **Modal connector recipe.** `sandbox.exec(['bash','-lc', cmd])`, read stdout/stderr concurrently with `wait()`, translate seconds to `timeoutMs`, shell-out for `stat`/`readdir`/`mkdir`/`rm`/`exists` when Modal's JS SDK lacks native FS methods.
  - **Sources:** `connectors/sandbox--modal.md:20, :216`
  - **Caveat:** verify against Modal's current JS SDK during implementation; their connector spec may have drifted.
- **Local-env allowlist.** Whitelist shell-essential env vars (`PATH`, `HOME`, locale); require explicit opt-in for secrets. Belongs in `threat-model.md` § 4 and the local-dev sandbox impl.
  - **Source:** `packages/runtime/src/node/local-env.ts:19`

### Deferred (interesting, post-MVP)

- **`CallHandle` cancellation primitive.** Structured cancellation type for prompt/shell/task. We already have AbortSignal-based cancellation working end-to-end (Probe 02). Reach for `CallHandle` if our cancellation glue gets messy across many call sites.
  - **Source:** `packages/runtime/src/abort.ts:24`
- **`finish` / `give_up` result tools.** Schema-validated terminal tools for internal workflows. Useful for future Outcomes (rubric-graded iterate-revise loops) or internal eval harnesses; not MVP Managed Agents compatibility.
  - **Source:** `packages/runtime/src/result.ts:113`

## What we explicitly don't lift

Cross-checked against the reviewer's "Do Not Copy" list:

| Item | Why |
|---|---|
| Framework shape (filesystem agents, triggers, build artifacts, `init()`/`harness()`/`session()`) | Conflicts with our persisted-API-object model. Already rejected in [ADR 0004](0004-managed-agents-rest-sse-surface-as-north-star.md). |
| Session history tree / compaction | Pi owns loop + history per [ADR 0001](0001-use-pi-agent-sdk-as-engine.md). Copying Flue's history model would violate that boundary. |
| Event vocabulary | Anthropic's names are Tier 1 wire-compatible (ADR 0004). Flue's names (`run.event`, `run.tool_call`, etc.) would break SDK client portability. |
| Connector-as-markdown runtime dependency | Community-recipe-as-data is a nice pattern; not MVP. Modal stays first-class TypeScript code. |

## Implementation order

Per the reviewer's recommendation:

1. **`EventStore` + `SessionEventBroadcaster`** — Pattern 1 + 2 above. Smallest unit that proves the platform shape.
2. **`ManagedSandbox` interface + lifecycle** — Pattern 3 principle.
3. **`ModalSandboxOperations`** — Pattern 3 + Modal connector recipe.
4. **`ApiError` classes** — Pattern 4 (structured errors).

Each step is independently testable. The order minimizes blast radius: events + errors land before sandbox work, so we don't expand into infra/Modal complexity before the platform shape is solid.

## Attribution & licensing

Flue is licensed **Apache-2.0** (confirmed at commit `3b2a55f`, `LICENSE` file). Apache-2.0 is compatible with most license choices we'd plausibly pick for this project (MIT, Apache-2.0, BSD-style). This ADR lifts algorithms (uncopyrightable as such) and architectural ideas (same), not source code. Where any function structure is recognizably derived from Flue, the source file/line is cited inline so an attribution audit is straightforward. If we ever copy a non-trivial code fragment verbatim, we'll attach Flue's copyright notice + license terms to the file per Apache-2.0 §4.
