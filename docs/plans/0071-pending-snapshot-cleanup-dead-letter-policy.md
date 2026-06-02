# 0071 Pending Snapshot Cleanup Retry-Cap Policy

## Issue

GitHub issue: `#71` "Follow-up: define dead-letter policy for pending internal
snapshot deletes".

## Context

`#51` added `pending_internal_snapshot_deletes` so hard-delete snapshot byte
cleanup is retryable instead of best-effort after session metadata is removed.
`#70` added `pending_internal_snapshot_create_rollbacks` so snapshots created
during a failed session create are also recoverable. `#73` deduplicated the
shared service-layer sweep/retry mechanics while keeping the two ledgers
separate.

Current production wiring is still in-memory:

- `createManagedAgentsControlPlaneApp(...)` constructs `SqliteSessionStore.open()`
  without a path, so the SQLite store is `:memory:`.
- the current file storage implementation is `InMemoryFileStorage`.

That means #71 is not currently an operator-durable repair system. A process
restart erases both the pending cleanup rows and the in-memory snapshot bytes.
The immediate value of #71 is narrower:

- prevent a permanently failing storage delete from retrying every retry
  interval for the lifetime of a long-running process;
- emit a clear terminal warning when automatic retry stops;
- keep the #51/#70 safety invariant intact while the row exists.

Relevant source:

- `src/control-plane/sessions/store.ts:60-89` defines both pending cleanup
  tables with `attempt_count`, `last_attempt_at`, and `last_error`.
- `src/control-plane/sessions/store.ts:220-263` records failed attempts and
  clears rows.
- `src/control-plane/sessions/service.ts:313-368` performs storage-delete-first,
  then clear-row, and records/schedules retry on failure.
- `src/control-plane/sessions/service.ts:370-393` schedules retries per ledger
  with separate timer maps.
- `docs/plans/0013-0014-0051-durable-runtime-and-storage.md:743-748` states the
  #51 invariant: failed byte cleanup remains queued and observable.
- `docs/plans/0070-create-rollback-internal-snapshot-cleanup.md:171-180` names
  dead-letter/backoff policy as a non-goal owned by #71.

## Decision Drivers

1. Preserve the invariant: retryable storage failures must not clear pending
   rows.
2. Stop indefinite in-process retry loops for poison rows.
3. Keep scope honest for the current in-memory architecture.
4. Avoid schema scaffolding for a durable-store policy that must be revisited
   before durable storage lands.
5. Reuse the #73 shared sweep seam.

## Options

### Option A: Keep retrying forever

Keep current behavior and rely on `attempt_count` / `last_error`.

Pros:

- No change.
- Transient failures keep retrying until they converge.

Cons:

- Poison rows retry forever during normal uptime.
- `attempt_count` remains write-only policy data.
- The issue remains unresolved.

Reject.

### Option B: Retry cap with terminal warning, no schema change

Add a configurable max-attempt threshold. After a failed attempt reaches the
threshold, record the attempt, log a terminal warning, and do not schedule
another in-process retry. Keep the row in memory for inspection until process
exit or a manual/direct sweep call.

Pros:

- Closes the current hot-loop problem.
- No schema churn.
- Keeps successful and already-absent cleanup semantics unchanged.
- Fits the #73 shared helper.
- Avoids pretending current rows are durable operator evidence.

Cons:

- No exponential backoff.
- No persisted dead-letter timestamp.
- No recovery API.
- A later durable store needs a stronger policy.

Choose this for #71.

### Option C: Durable dead-letter state and operator surface

Add `dead_lettered_at`, backoff, manual retry/clear APIs, and metrics.

Pros:

- Closer to a production durable-storage operations model.

Cons:

- Over-scoped for the current in-memory architecture.
- Risks shipping schema that must be reshaped before durable storage anyway.
- Pulls operator API design into a narrow retry-policy follow-up.

Defer.

## Proposed Policy

Use a fixed max-attempt retry cap for both pending snapshot cleanup ledgers.

Default:

- `pendingSnapshotCleanupMaxAttempts = 5`

Configuration:

- expose `pendingSnapshotCleanupMaxAttempts?: number` through
  `DefaultSessionService` options;
- reject values below `1`.

Attempt semantics:

- `attempt_count` counts failed delete attempts.
- The service computes terminal state as `row.attempt_count + 1 >= max`.
- `recordAttempt(...)` remains the single increment point.
- If the next failed attempt is below the max:
  - record the attempt;
  - schedule the normal retry.
- If the next failed attempt reaches or exceeds the max:
  - record the attempt;
  - do not schedule another retry;
  - log a terminal `console.warn` with workspace, session, resource, snapshot ID,
    retry label, attempt count, and error.

Clear semantics stay unchanged:

- successful `deleteInternalSnapshot(...)` clears the row;
- `deleteInternalSnapshot(...) === false` means "already absent" and clears the
  row;
- storage exceptions keep the row.

Manual/direct sweeps:

- A later explicit sweep may still see the row and attempt cleanup again. This is
  acceptable for the current in-memory policy because there is no durable
  operator workflow yet.
- The retry cap only stops automatic in-process rescheduling after the terminal
  warning.

## Durable-Store Precondition

Before adding durable `SessionStore` or durable/remote `FileStorage`, revisit
this policy.

With durable rows, count-only terminal retry can permanently stop cleanup after a
transient outage that spans restarts or crash loops. A durable deployment likely
needs at least one of:

- `next_attempt_at` plus backoff/jitter;
- a retry-after-dead-letter path;
- an operator/admin list and retry/clear surface;
- metrics or structured logging hooks;
- ownership/leasing if multiple instances sweep concurrently.

This plan intentionally does not claim to solve that future durable-store
operability problem.

## Implementation Details

No schema changes.

Type/service changes:

- widen the internal `PendingSnapshotCleanupRow` type in
  `src/control-plane/sessions/service.ts` to include `attempt_count`;
- add `pendingSnapshotCleanupMaxAttempts` to the service constructor options;
- validate the value once in the constructor;
- update `sweepPendingSnapshotCleanup(...)` catch handling to gate
  `scheduleRetry(...)` on `row.attempt_count + 1 < max`;
- log once when the failed attempt reaches the max.

Store changes:

- none expected.

The two ledgers remain separate:

- hard-delete rows are copied from committed session snapshot metadata before
  metadata deletion;
- create-rollback rows are written before snapshot bytes are created and cleared
  atomically on successful session commit.

## Non-Goals

- No `dead_lettered_at` column.
- No exponential backoff or jitter.
- No metrics framework integration.
- No public/admin API for listing, retrying, or force-clearing rows.
- No durable multi-instance lease/ownership model.
- No merge of the #51 and #70 ledger tables.
- No change to the storage-delete contract: only success or already-absent
  `false` clears a row.

## Acceptance Criteria

1. A pending hard-delete row that fails below the max threshold remains queued,
   records attempt metadata, and schedules a retry.
2. A pending hard-delete row whose failed attempt reaches the max threshold
   records the attempt, keeps bytes, keeps the row, logs a terminal warning, and
   does not schedule another automatic retry.
3. Successful hard-delete cleanup still clears rows after previous failed
   attempts below the threshold.
4. Already-absent hard-delete storage (`deleteInternalSnapshot` returns `false`)
   still clears rows even when the max is `1`.
5. Create-rollback cleanup follows the same below-threshold retry behavior.
6. Create-rollback cleanup stops automatic retries at the threshold and does not
   delete live committed session bytes.
7. The warning fires once per terminal automatic retry path, not on every timer
   tick after the cap.
8. A restarted service over the same in-memory store object sees accumulated
   `attempt_count` and applies the same cap logic.
9. Cross-workspace isolation remains pinned for both ledgers.
10. The create-rollback startup age fence remains pinned: rows newer than service
    startup are not swept by startup reconciliation.
11. Typecheck and the full test suite pass.

## Test Plan

Add focused tests in
`src/control-plane/sessions/__tests__/service-store.test.ts`, reusing the
existing `FaultyInternalSnapshotDeleteStorage` pattern.

Hard-delete tests:

- below max: with `pendingSnapshotCleanupMaxAttempts: 2`, first failure records
  `attempt_count: 1`, keeps the row queued, and a later successful retry clears
  it.
- at max: with max `1`, first failure records `attempt_count: 1`, keeps bytes,
  keeps the row, logs a terminal warning, and timer advancement does not retry.
- already absent: pending row with absent snapshot clears even when max is `1`.
- cross-restart accumulation: reuse the same store object with a new service and
  confirm the existing `attempt_count` participates in the cap.

Create-rollback tests:

- below max: first failure schedules retry and a later success clears the row.
- at max: failed rollback delete records the terminal attempt, keeps bytes/quota,
  logs once, and does not schedule further retry.
- startup age fence: a newer-than-startup create-rollback row remains untouched
  even when max is `1`.
- successful create guard: a successful session create clears rollback rows
  before any sweep can retry or delete live bytes.

## Review Questions

1. Should #71 apply to both #51 hard-delete rows and #70 create-rollback rows?
   This plan says yes because #73 intentionally made the retry mechanism shared
   and both ledgers can poison.
2. Is stopping automatic retry after max attempts enough for the current
   in-memory architecture? This plan says yes.
3. Is a durable dead-letter column worth adding now? This plan says no, because
   durable storage needs a broader policy anyway.
4. Should manual/direct sweeps ignore terminal rows? This plan says no for now:
   the cap stops automatic rescheduling, while explicit sweeps may be used as a
   simple manual retry mechanism.

## Implementation Order

1. Add `pendingSnapshotCleanupMaxAttempts` option and validation.
2. Widen `PendingSnapshotCleanupRow` to include `attempt_count`.
3. Update the shared sweep helper to compute `nextAttemptCount`.
4. Record every failure through the existing store attempt methods.
5. Schedule retry only when `nextAttemptCount < max`.
6. Log a terminal warning when `nextAttemptCount >= max`.
7. Add hard-delete tests.
8. Add create-rollback tests.
9. Run focused tests, typecheck, then full suite.

## Expected Size

Small:

- one service option;
- one internal row type widening;
- one shared helper policy change;
- focused tests across both ledgers.

No schema or store API changes should be needed.
