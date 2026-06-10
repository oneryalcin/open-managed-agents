# ADR 0014: Storage engine strategy for managed SaaS

**Status:** Accepted, 2026-06-09

## Context

The product direction is managed SaaS, with SQLite retained for local and
single-node deployments. This is the product premise for this ADR; it is the
explicit answer to tracking issue #108, not an inference from the current MVP
implementation.

PR #109 added the first single-node durable deployment store:

- one shared file-backed SQLite connection for agent, environment, session,
  event, runtime, and file metadata;
- local object storage for uploaded files, internal snapshots, and session
  outputs;
- SQLite WAL, `busy_timeout`, `foreign_keys`, and `synchronous=NORMAL`;
- SQLite-path locking and a persisted SQLite/object-root binding;
- metadata-first file deletes and startup orphan cleanup;
- in-transaction runtime ownership and session-output liveness fences.

That was the right foundation for a self-hosted single-node target. It also made
the tradeoff clear: the current durable correctness model is intentionally
single-process and synchronous. Several guarantees rely on there being one OMA
process with one shared `DatabaseSync` connection:

- "no await inside the commit path" is part of the current atomicity story;
- lifecycle guards such as `closedSessions` and `deletedSessions` are
  process-local;
- the SQLite lock exists because the backend is not a multi-process deployment
  coordinator;
- runtime workers are still live in-process handles, not independently leased
  workers.

That product direction changes the storage decision. The question is no longer
whether SQLite can carry hundreds of active sessions on one node. It probably
can. The question is whether OMA should deepen a synchronous, single-process
storage model before work that actually needs managed-SaaS properties:
multiple API/runtime processes, authenticated workspaces, admission control,
high availability, backups, and operational recovery.

This ADR records the storage-engine direction and the migration gate. It does
not require every near-term feature to wait for Postgres. It requires
Postgres/async-storage design before multi-process runtime workers,
auth-enforced admission controls, or other managed-SaaS infrastructure depends
on shared durable coordination.

## Decision

### 1. Keep SQLite as the local and single-node durable backend

SQLite remains the correct backend for:

- local development;
- deterministic tests;
- workshop and demo runs;
- one-process self-hosted deployments;
- debugging the control-plane semantics without external infrastructure.

The existing durable SQLite mode should remain useful and maintained. It is the
fastest way to validate OMA end to end, and it gives contributors a simple
single-binary-plus-files setup.

But SQLite durable mode is not the managed-SaaS production target.

### 2. Choose Postgres as the managed-SaaS metadata store

For managed SaaS, OMA should use Postgres for durable metadata:

- agents;
- environments;
- sessions;
- events;
- pending runtime turns;
- runtime owner/generation leases;
- file metadata and quotas;
- session resources and internal snapshot ledgers;
- future auth/workspace/admission state.

Postgres is the target because it directly removes the current single-process
coordination tax:

- multiple API/runtime processes can share one durable state boundary;
- row locks, advisory locks, isolation levels, and unique constraints replace
  process-local lock files;
- transactions can include session liveness, owner/generation checks, event
  appends, and file metadata changes without relying on JavaScript synchrony;
- operational tooling for backups, restore, replication, migrations, and
  observability is standard for managed SaaS.

The exact hosting provider is not part of this ADR. The decision is the engine
class and the storage semantics, not Supabase vs RDS vs Neon vs self-managed
Postgres.

### 3. Keep object bytes outside the metadata database

Do not move uploaded files, internal snapshots, or session outputs into
Postgres rows.

For managed SaaS, bytes should live in object storage such as S3, R2, GCS, or a
compatible provider. Postgres stores metadata, quotas, hashes, visibility,
scope, and cleanup ledgers. The byte/metadata failure model remains:

1. write bytes to a temporary or content-addressable object key;
2. commit metadata transactionally;
3. expose only committed metadata;
4. treat unreferenced bytes as cleanup/GC work;
5. never leave visible metadata pointing at missing bytes when a safer
   metadata-first path exists.

This is the same invariant PR #109 established for local object storage. The
backend changes; the failure direction does not.

### 4. Make deployment composition the replacement seam

Do not add a broad, speculative `DbDriver` abstraction across the whole codebase
just to make the current SQLite code look portable.

The useful seam is deployment composition. Today this seam is concrete, not
fully abstract: `DeploymentStores` still exposes `SqliteAgentStore`,
`SqliteEnvironmentStore`, `SqliteSessionStore`, and `EventStore`, and
`createDeploymentControlPlaneApp` still passes those concrete stores into
services, the broadcaster, and runtime helper providers. That is acceptable for
the current SQLite-backed implementation.

The important design direction is where future replacement should happen:

```ts
interface DeploymentStores {
  agents: AgentStore;
  environments: EnvironmentStore;
  sessions: SessionStore;
  events: EventStore;
  files: FileStorage;
  close(): void | Promise<void>;
}
```

That composition point already owns the SQLite/object-root pairing and one
coordinator-shaped operation: session deletion can remove session rows, events,
runtime turns, and session-output metadata in one transaction. A future
Postgres-backed implementation should harden this seam into async store
interfaces plus a transaction coordinator. It should not start by sprinkling a
generic SQL driver through every store.

The important rule for new code: avoid spreading direct `DatabaseSync`
knowledge outside store/deployment modules. Services should depend on store
interfaces and deployment-level operations, not on SQLite handles.

### 5. Design async store contracts before multi-process runtime workers

Postgres is async in practice. The hard migration is not mostly SQL syntax,
though there is real SQL work: `PRAGMA` migrations, `sqlite_master` inspection,
`INSERT OR IGNORE`, positional `?` placeholders, and SQLite-specific migration
helpers all need replacement.

The harder migration is still the execution model:

- synchronous metadata store methods become `Promise`-returning methods;
- `FileStorage` is already Promise-based and should be treated as prior art for
  the async shape, not as a synchronous surface to convert;
- transaction callbacks can contain awaited statements;
- invariants must be enforced with database locks/isolation, not "no await in
  this synchronous tick";
- lifecycle guards such as `closedSessions`, `deletedSessions`, and the
  session-output `canCommit()` callback must move from process-local checks into
  durable predicates where correctness crosses process boundaries.

Therefore the Postgres path should be sequenced before any multi-process
runtime-worker extraction:

1. define async store interfaces for the metadata operations that services use;
2. introduce an explicit transaction/coordinator boundary for cross-store
   invariants;
3. implement SQLite behind that async boundary first if useful for continuity;
4. add Postgres as the managed-SaaS backend;
5. only then add multi-process workers/admission behavior that relies on shared
   durable coordination.

### 6. Do not make multi-backend support a product promise yet

SQLite and Postgres should both be useful internally, but OMA should not promise
arbitrary pluggable databases as a user-facing feature.

The supported targets are:

- SQLite: local/dev/single-node.
- Postgres: managed SaaS/multi-process metadata.

Every additional database multiplies migration, locking, isolation, test, and
operational semantics. That is not where OMA should spend complexity budget.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Treat SQLite as the managed-SaaS production backend | SQLite can likely handle the write volume for hundreds of sessions on one node, but the SaaS requirement is multi-process coordination, HA, restore, auth/admission state, and operational tooling. The current lock/binding machinery is a single-node tax, not a SaaS foundation. |
| Switch everything to Postgres immediately in the current branch | Too much blast radius for the deployment-hardening foundation. PR #109 already delivered useful single-node durability. A rushed port would mix sync-to-async service changes, SQL migration, and correctness rework in one slice. |
| Add a generic DB driver abstraction now | A broad abstraction would hide the real problem. The hard part is transaction semantics and async execution, not swapping `?` placeholders for `$1`. Keep the seam at deployment/store composition until the Postgres implementation forces the right shape. |
| Async-wrap SQLite immediately, before a Postgres implementation or multi-process feature needs it | This adds Promise plumbing while preserving the same single-process SQLite semantics. Do it when it pays down a concrete managed-SaaS dependency, not as architecture theater. |
| Store file bytes in Postgres | File bytes are a quota, streaming, GC, and object-lifecycle concern. Keeping bytes in object storage preserves the architecture from ADR 0013 and avoids large-row/backup bloat. |
| Use SQLite clustering/replication as the SaaS strategy | Tools such as Litestream/LiteFS can improve backup or edge-read stories, but they do not remove the need to rework process-local runtime ownership, liveness, and worker coordination. |
| Support SQLite and Postgres as fully equivalent production modes forever | The semantics are different enough that pretending equivalence would produce weak tests and ambiguous operations. SQLite is a local/single-node backend; Postgres is the managed-SaaS backend. |

## Consequences

- The current durable SQLite work is still valuable. It validates metadata,
  object-byte, quota, lifecycle, and event-log invariants before adding managed
  infrastructure.
- The next storage-facing implementation should avoid new synchronous
  cross-store assumptions in services. If a feature needs a new cross-store
  invariant, prefer a deployment-level operation that can later become a
  Postgres transaction.
- The Postgres migration should be planned as an async-boundary project, not a
  mechanical SQL port.
- The async-boundary project is not required before ordinary MVP feature work
  that stays within the single-process deployment model.
- Multi-worker runtime extraction must wait until the durable coordination
  backend can support it.
- Auth-enforced admission controls that claim workspace-level security should
  wait for authenticated workspace identity and a managed-SaaS metadata store.
- SQLite scaling readiness remains useful for the local/single-node backend,
  but it should not be mistaken for the managed-SaaS readiness plan.

## Migration sketch

This ADR does not implement Postgres. It gives the next design pass a concrete
shape:

1. Inventory the synchronous store methods used by services.
2. Define async store interfaces only for currently used operations.
3. Preserve existing async `FileStorage` semantics and use them as the baseline
   for metadata-store async shape.
4. Move cross-store operations into deployment-level methods, for example:
   - delete session + events + runtime turns + session-output metadata;
   - append events + runtime ownership changes;
   - commit session outputs only if owner/liveness still holds;
   - create session + internal snapshot metadata.
5. Preserve SQLite behind the async boundary for local/dev.
6. Add Postgres schema/migrations for the metadata store.
7. Implement Postgres transactions with row locks/advisory locks where the
   current SQLite implementation relies on synchronous process exclusivity.
8. Move local-object byte storage toward an object-store provider for managed
   SaaS.
9. Add concurrency tests that use at least two store instances/processes against
   the same Postgres database.

### Current implementation status

As of PRs #111, #112, and #114, the main SQLite-era cross-store invariants are
now named deployment coordinators:

- session deletion: delete the session, event log rows, runtime turns, and
  session-output metadata in one durable operation;
- session output commits: commit output metadata only while the session and
  runtime turn owner/generation still match;
- runtime event commits: append translated runtime transcript rows only while
  the session and runtime turn owner/generation still match.

This completes the prerequisite coordinator-shape work for the current
single-process SQLite backend. It does not start the Postgres migration. Resume
that work only when a concrete managed-SaaS or multi-process dependency needs
it, starting with:

1. async store interfaces for service-used metadata operations;
2. a query-layer decision for explicit Postgres transactions;
3. Postgres schema and migrations;
4. Postgres implementations of the deployment coordinators using row locks,
   advisory locks, or equivalent transaction semantics;
5. multi-instance concurrency tests against a real Postgres database.

Issue #113 tracks the remaining audit of runtime-change call sites that still
use store-level owner/generation checks rather than a deployment coordinator.

## Open questions

- Which Postgres provider should managed OMA use first?
- Do we use raw SQL, Kysely, Drizzle, or another query layer? The answer should
  optimize for explicit transactions and type safety, not ORM convenience.
- What is the first managed object-storage provider?
- What backup/restore and retention policy do we promise in managed SaaS?
- Do runtime workers talk directly to Postgres, or through a control-plane
  coordination service?
- When does the public API expose workspace/auth concepts that are currently
  internal?

## Validation

This ADR is based on:

- the implementation and review of PR #109's single-node durable SQLite store;
- the deployment-hardening plan in
  [0103 - Deployment Hardening](../plans/0103-deployment-hardening.md);
- the Phase 2 storage design in
  [0103 Phase 2 - Single-Node Durable Storage Design](../plans/0103-phase-2-storage-design.md);
- ADR 0013's file-resource storage boundary;
- tracking issues #107 and #108.
