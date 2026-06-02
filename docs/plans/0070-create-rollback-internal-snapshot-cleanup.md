# #70 Create-Rollback Internal Snapshot Cleanup

## Context

Issue #51 made hard-delete snapshot byte cleanup durable by copying committed
`session_file_mount_snapshots` rows into a pending delete ledger before deleting
session metadata.

Issue #70 is a different boundary. During `sessions.create`, internal snapshot
bytes are created before the session row and snapshot metadata commit. If
session persistence or runtime materialization fails, the current rollback path
deletes those bytes best-effort. With a durable `FileStorage` backend, a failed
rollback delete can leave internal snapshot bytes and quota behind with no
committed session metadata to find them.

ADR 0013 requires session creation to block until resources are mounted and to
avoid visible partially-created sessions. Plan 0043 intentionally created
snapshot bytes before the synchronous session-store transaction, then used
best-effort cleanup on failure. #70 hardens that rollback path.

## Decision

Use a strict write-ahead rollback ledger for internal snapshots created during
session creation.

Before internal snapshot bytes can exist, the control plane must already have a
durable cleanup record that can find and delete those bytes after crash or
restart.

This requires caller-chosen internal snapshot IDs:

1. `DefaultSessionService.create` generates the `sessionId` before preparing
   file resources.
2. For each file resource, the service generates `resourceId` and
   `snapshotFileId` before writing bytes.
3. The service inserts a rollback ledger row for
   `(workspaceId, sessionId, resourceId, snapshotFileId)` before calling
   `FileStorage.createInternalSnapshot`.
4. `FileStorage.createInternalSnapshot` writes the snapshot using the
   caller-provided `fileId`.
5. `SessionStore.create` inserts session/resource/snapshot metadata and clears
   rollback rows for `(workspaceId, sessionId)` in the same SQLite transaction.

## Why Strict Write-Ahead

The smaller alternative is to insert the rollback ledger after
`createInternalSnapshot` returns, when the storage-generated ID is known. That
handles thrown rollback deletes, but leaves a crash window:

1. storage writes durable bytes;
2. process dies before the ledger row is inserted;
3. session metadata never commits;
4. no durable record can find the bytes.

Because #70 exists specifically because create rollback has no committed
metadata anchor, this plan closes the crash window instead of only making
exceptions recoverable.

## Rejected Alternatives

### Post-write ledger

Rejected because it leaves bytes-without-ledger possible after a crash between
storage write and ledger insert.

### Reachability reaper

A reaper could delete internal snapshots whose resource IDs are absent from
committed `session_file_mount_snapshots`. That avoids caller-chosen snapshot IDs
but introduces a time-of-check/time-of-use hazard: a reaper running during a
legitimate in-flight create can see an uncommitted snapshot as unreachable and
delete it. Avoiding that needs grace periods or leases. The write-ahead ledger
is more explicit and testable.

### Reuse #51 hard-delete ledger

Rejected because #51 rows mean "delete bytes for a once-committed session."
#70 rows mean "roll back an uncommitted create." Mixing them risks deleting
in-flight create snapshots from a hard-delete workspace sweep.

## Invariants

- No internal snapshot byte write may start before a rollback cleanup record
  exists.
- A rollback sweep may delete only rows from the create-rollback ledger.
- Successful session commit must clear all rollback rows for
  `(workspaceId, sessionId)` in the same transaction that inserts session,
  resource, and snapshot metadata.
- After successful create, a rollback sweep for the same session must be a
  no-op and must not delete live session snapshot bytes.
- Storage delete returning `false` means already absent and clears the rollback
  row. Retryable storage failures must throw and keep the row.
- Public Files API behavior is unchanged; internal snapshots remain unlistable.

## Implementation Shape

Add a table beside the #51 pending-delete ledger:

```sql
CREATE TABLE IF NOT EXISTS pending_internal_snapshot_create_rollbacks (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  mount_path TEXT NOT NULL,
  snapshot_file_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_attempt_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (workspace_id, session_id, resource_id)
);
```

Extend `InternalFileSnapshotInput` with a required caller-provided `fileId`.
`FileStorage.createInternalSnapshot` must persist exactly that ID or throw before
writing bytes. `DefaultSessionService` should assert that the returned metadata
ID matches the requested ID so incompatible backends fail loudly before session
metadata commits. `InMemoryFileStorage` should honor the ID for internal
snapshot creation and reject duplicates through the same atomic create boundary.

Add `SessionStore` methods to:

- record create-rollback rows;
- clear create-rollback rows for a committed session;
- list/get rows for startup and explicit sweeps;
- record failed cleanup attempts;
- clear individual rows after successful or already-absent storage delete.

Add `DefaultSessionService` create-rollback sweep behavior parallel to #51:

- run at startup for rows older than this service instance's startup timestamp;
- run on create failure for the affected `(workspaceId, sessionId)`;
- retry failed rows during uptime with the existing retry-delay pattern.

The startup age fence prevents an unfiltered constructor sweep from deleting a
snapshot for an in-flight create whose write-ahead row is legitimately present
but whose session metadata has not committed yet. Multi-instance ownership or
lease fencing for one instance sweeping another instance's in-flight create is a
future durable-deployment concern and is not solved in this PR.

## Tests

Required focused tests:

- successful session create clears rollback rows in the same commit that writes
  session/resource/snapshot metadata;
- after successful create, running the rollback sweeper is a no-op and live
  snapshot bytes remain readable;
- storage backends that return a different internal snapshot ID fail loudly and
  do not commit session metadata;
- startup sweep ignores rollback rows newer than the service startup fence;
- injected `store.create` transaction failure leaves no visible session, no
  normal snapshot metadata, and rollback rows for created snapshots;
- storage delete failure during create rollback leaves rollback rows, records
  attempt metadata, and preserves bytes/quota until retry;
- uptime retry after transient rollback delete failure clears rows and releases
  quota without restart;
- startup sweep after simulated crash deletes rollback snapshots and clears
  rows;
- crash-before-byte-write simulation: a rollback row whose snapshot is already
  absent is cleared by sweep;
- two-resource partial cleanup: successful sibling clears while failed sibling
  remains queued;
- cross-workspace sweep isolation;
- `InMemoryFileStorage.createInternalSnapshot` honors caller-provided
  `fileId`.

## Non-Goals

- Do not define dead-letter/backoff policy for poison rows; #71 owns that.
- Do not add event delete fences or session tombstones.
- Do not change public Files API list/retrieve/download behavior.
- Do not make session creation lazy; ADR 0013 keeps file-resource session
  creation blocking.
- Do not solve multi-instance ownership/leasing for one instance's startup sweep
  racing another instance's in-flight create; this PR only age-fences the
  single-process startup sweep.
