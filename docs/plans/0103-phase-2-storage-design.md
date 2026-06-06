# 0103 Phase 2 - Single-Node Durable Storage Design

Parent plan: [0103 - Deployment Hardening](0103-deployment-hardening.md)

## Purpose

Phase 2 is the load-bearing deployment-hardening slice. It should make the
single-node deployment durable enough to restart without losing control-plane
state, and it should create the transactional substrate required before any
admission-control or worker-pool work.

This is a design pass before code. It deliberately excludes admission controls
and worker extraction.

## Current Code Facts

- `createDeploymentControlPlaneApp` currently opens independent stores:
  `SqliteAgentStore.open(":memory:")`,
  `SqliteEnvironmentStore.open(":memory:")`,
  `SqliteSessionStore.open(":memory:")`, and
  `EventStore.open(":memory:")`.
- The SQLite-backed stores already accept an injected `DatabaseSync` in their
  constructors. The app composition is the main issue, not every store class.
- `EventStore.appendBatchWithRuntimeChanges` already commits events and
  pending-runtime changes in one SQLite transaction, but only inside the event
  store's own database.
- `SqliteSessionStore` uses its own SQLite transaction for session/resource and
  internal-snapshot metadata changes.
- `InMemoryFileStorage` owns file metadata and bytes in memory. Session output
  replacement, internal snapshots, and uploaded bytes are not durable today.
- No SQLite WAL, `busy_timeout`, `foreign_keys`, or `synchronous` pragmas are
  configured today.

## Target for Phase 2

Add a **single-node durable deployment store**:

- one file-backed SQLite database for agent, environment, session, event, and
  runtime metadata;
- one local object-storage directory for file bytes;
- one process still owns live Pi runtime handles and Docker-local containers;
- one process has exclusive access to the SQLite/object-root pair while it is
  running;
- no worker process extraction;
- no admission controls yet.

The durable mode should be opt-in through deployment config. The existing
in-memory helpers should remain available for isolated tests and cheap scratch
probes.

The exclusive-access rule is load-bearing. The deployment factory should take a
lock derived from the SQLite database path and persist the object-root binding
inside that database. A second process must fail closed if it tries to reuse the
same database concurrently, or if it tries to reopen the same database with a
different object root. Rolling-overlap restarts against the same durable root
are not supported in Phase 2; stop the old process before starting the new one,
or move to a future worker/coordinator design.

## Storage Composition

Add a deployment storage factory, roughly:

```ts
interface DeploymentStorageConfig {
  sqlitePath?: string;
  objectRoot?: string;
}

interface DeploymentStores {
  agents: SqliteAgentStore;
  environments: SqliteEnvironmentStore;
  sessions: SqliteSessionStore;
  events: EventStore;
  files: FileStorage;
  close(): void;
}
```

Behavior:

- If no durable storage env is provided, keep current trusted local/demo
  behavior: separate in-memory stores and `InMemoryFileStorage`.
- If durable storage env is provided, open one shared `DatabaseSync` and inject
  it into all SQLite-backed stores.
- File bytes in durable mode should use a local object directory, not memory.
- The factory owns closing the shared DB connection.

Candidate env names:

- `OMA_SQLITE_PATH`
- `OMA_FILE_STORAGE_ROOT`

If only one of these durable env vars is set, fail config validation. A durable
deployment with durable metadata but memory-only bytes is too easy to
misrepresent.

## SQLite Pragmas

For file-backed durable mode, configure:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
```

Rationale:

- `WAL` lets readers proceed while a writer is active.
- `busy_timeout` prevents avoidable lock errors under normal local concurrent
  API traffic.
- `foreign_keys` makes existing declared constraints meaningful.
- `synchronous=NORMAL` is the usual WAL tradeoff for local durability without
  excessive fsync cost.

Do not apply WAL to `:memory:` stores. Keep test helpers deterministic unless a
test explicitly asks for file-backed behavior.

Concurrency posture for Phase 2: single process, single SQLite writer at a
time. WAL/busy_timeout make this usable for local readers and short writes; they
do not make this a distributed database.

## Transactional Invariants

Phase 2 should name and test the invariants that become possible with one
shared DB. It does not need to solve every future worker invariant yet.

Required invariants:

1. **Runtime event commit with session liveness.**
   Appending runtime events or closing a runtime turn must be able to check that
   the session still exists and is not archived/deleted in the same
   `BEGIN...COMMIT` as the event/runtime mutation.
2. **Runtime event commit with owner/generation.**
   Existing owner/generation checks remain inside the event/runtime mutation,
   and later cross-store checks can share the same DB transaction.
3. **Output metadata commit with session liveness and owner.**
   Committing session-output metadata must not resurrect files after
   delete/archive, and it must be checkable against the runtime owner/generation
   in the same DB transaction once output metadata is in SQLite.
4. **Snapshot metadata and session resource metadata remain paired.**
   Session creation/deletion should keep resource rows, internal snapshot
   metadata, and rollback ledgers transactionally consistent.

Implementation implication:

- A shared DB alone is not enough. Some service paths still call separate store
  methods that each start their own transaction. Phase 2 should introduce the
  smallest transaction coordinator or shared-store method needed for the
  specific cross-store invariants being claimed.
- Do not claim "cross-store atomicity" until the code path actually performs
  the relevant reads/writes inside one transaction.

## File Byte Durability

Phase 2 should include local file-byte durability, but it must be honest about
the metadata/bytes split:

- SQLite stores file metadata, scope, visibility, hashes, quotas, and storage
  keys.
- A local object directory stores bytes.
- Metadata and bytes cannot be committed in one SQLite transaction because the
  filesystem is a separate system.

Use a write-order that fails safely:

1. Validate quota and names before writing bytes where possible.
2. Write bytes to a temporary file under the object root.
3. Hash/size-check the temp file.
4. Commit SQLite metadata pointing at the final storage key.
5. Atomically rename temp bytes into place after or immediately before the
   metadata commit, with a startup/sweep path for temp or orphaned files.

The exact order should be chosen in implementation, but the PR must document the
failure windows it accepts:

- metadata committed but bytes missing;
- bytes present but metadata missing;
- delete/archive racing byte writes;
- process crash between temp write and final rename.

For Phase 2, it is acceptable to preserve current in-memory file storage for
test helpers. Durable deployment mode should not use it.

Phase 2's local-object implementation is durable enough for a single-node
developer/operator deployment, not a power-loss-perfect object store. With
SQLite WAL `synchronous=NORMAL`, the most recent metadata transaction can be
lost during host power loss. File bytes are also outside SQLite, so startup
reconciliation must treat temp files and unreferenced object files as cleanup
targets, and tests should pin that public APIs do not expose temp/orphan bytes.
Do not describe this as distributed or crash-perfect storage.

## Tests That Matter

The storage PR should include focused tests, not only broad API coverage.

Required tests:

1. **Restart persistence.**
   Create agent/environment/session/events/files through one app instance,
   close it, recreate the app with the same `OMA_SQLITE_PATH` and
   `OMA_FILE_STORAGE_ROOT`, and verify all durable metadata and downloadable
   bytes survive.
2. **Shared DB transaction proof.**
   Exercise at least one path that combines session liveness and event/runtime
   mutation in one transaction. The test should fail if the session row is
   archived/deleted before the commit.
3. **Exclusive process access.**
   Open one durable store against a SQLite/object-root pair, then verify a
   second deployment store for the same pair fails with a deliberate lock error.
   Close the first store and verify a restart succeeds. This pins the Phase 2
   concurrency posture instead of implying rolling-overlap or multi-process
   support.
4. **Byte/metadata crash-window guard.**
   Simulate a failure after writing temp bytes but before metadata commit, or
   after metadata commit but before final byte placement, and verify startup or
   explicit sweep leaves the public API consistent.

Non-goals for tests:

- Do not prove worker-pool recovery.
- Do not add auth/admission limit behavior.
- Do not require Docker/model calls for the storage unit tests.

## Review Focus for the Storage Commit

The storage commit should be independently reviewable inside
`feat/deployment-hardening-foundation`.

Reviewers should focus on:

- whether all SQLite stores in durable deployment mode share the same
  `DatabaseSync`;
- whether WAL/busy_timeout/foreign_keys/synchronous are applied only where
  intended;
- whether claimed cross-store invariants are actually one transaction;
- whether local file bytes have a clear orphan/temp cleanup story;
- whether in-memory test helpers remain simple and isolated;
- whether no admission-control or worker-extraction scope slipped in.
