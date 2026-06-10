# POST /v1/sessions Idempotency Plan

Date: 2026-06-10

## Implementation Status

Implemented in `dev/session-create-idempotency`:

- shared request-idempotency helpers and ledger contract;
- `POST /v1/sessions` route integration;
- session-store create plus idempotency completion in one transaction for
  single-database SQLite deployments;
- best-effort in-memory parity;
- delete cleanup by created session ID;
- user-facing cookbook at
  [Retry-safe `sessions.create`](../cookbooks/retry-safe-session-create.md).

## Purpose

Plan the second request-idempotency endpoint before implementation:

```text
POST /v1/sessions
```

This is the rule-of-two point from ADR 0015. `events.send` proved the ledger
shape for one endpoint; `sessions.create` should extract the shared primitive
only where a second endpoint proves the need.

This plan is intentionally not code. It records the create-path audit, upstream
positioning, decisions to pin, and acceptance tests for the implementation PR.

## Upstream Positioning

Anthropic's public Managed Agents docs currently describe session creation as a
two-step lifecycle: first create a session to provision the sandbox, then send a
user event to start work:

- https://platform.claude.com/docs/en/managed-agents/sessions

The public API overview lists the Sessions API as beta and documents required
headers, response headers, request-size limits, SDK retries, and rate limits:

- https://platform.claude.com/docs/en/api/overview

The Managed Agents session pages and API overview do not currently document an
`Idempotency-Key` request header for `POST /v1/sessions`. Search results on the
official docs only surface idempotency language for read-style polling such as
Message Batch retrieval, not Managed Agents session creation.

Conclusion: adding `Idempotency-Key` for `POST /v1/sessions` would be an OMA
reliability edge over the currently documented Anthropic Managed Agents surface,
while remaining compatible because the header is optional and requests without
it keep normal behavior.

Do not overstate this as proof Anthropic lacks private/backend idempotency. The
correct claim is narrower: it is not documented publicly for Managed Agents
session creation as of this plan.

## Local Create-Path Audit

Current route shape:

- `src/control-plane/sessions/routes.ts` parses JSON and calls
  `service.create(...)`.
- It does not read raw request bytes or look at `Idempotency-Key`.

Current service create path:

1. parse and validate the request body;
2. resolve and validate agent;
3. resolve and validate environment;
4. generate `sessionId`;
5. if resources are present, validate each resource and read uploaded file
   bytes;
6. generate resource IDs and internal snapshot file IDs;
7. record pending internal-snapshot create-rollback rows;
8. create internal session-scoped snapshots in file storage;
9. optionally call `runtime.prepareSession(...)` with file mounts;
10. persist the session row, session resources, and snapshot rows in one
    `SessionStore.create(...)` transaction;
11. clear pending create-rollback rows for that session in the same store
    transaction;
12. on failure after snapshots or runtime preparation, close runtime
    best-effort and sweep pending create-rollbacks.

Important existing durability facts:

- session row persistence is transactional inside `SqliteSessionStore.create`;
- snapshot object writes happen before the session row exists;
- runtime preparation can happen before the session row exists;
- pending create-rollback rows are the durability backstop for snapshot objects
  created before session persistence;
- resource-free session create has no runtime preparation and no snapshot object
  side effects.

## Risk

The duplicate-side-effect risk differs from `events.send`.

For resource-free session creation, a timeout after commit can cause a retry to
create a second visible session with a distinct `sesn_*` ID.

For resource-backed session creation, a timeout can duplicate more than the row:

- a second `sesn_*` ID,
- second `sesrsc_*` resource IDs,
- second internal snapshot objects,
- possibly second runtime preparation.

The implementation must not solve this with route-level middleware that stores a
response after `service.create(...)` returns. That reopens ADR 0015's crash
window: the session row can commit while the idempotency row remains
`in_progress`, and a retry cannot safely know whether to re-execute.

## Recommended Contract

Support the same optional header as `events.send`:

```text
Idempotency-Key: <client-generated-key>
```

Scope:

```text
workspace_id + POST + /v1/sessions + idempotency_key
```

Fingerprint:

```text
sha256("POST\n/v1/sessions\n" + raw_request_body_bytes)
```

Behavior:

- no header: existing non-idempotent behavior;
- same key + same raw body: replay the original session create response;
- same key + different raw body: `400 invalid_request_error`;
- same key + same body while fresh `in_progress`: `409 invalid_request_error`
  with `Retry-After`;
- handled post-reservation failures that do not commit metadata delete the
  reservation row so a retry can re-execute immediately;
- completed rows expire after the same 24-hour TTL used by `events.send`;
- abandoned `in_progress` rows use the same conservative threshold as
  `events.send`.

Response replay should include the original `ManagedAgentsSession` body exactly
as originally returned, including the same `id`, resource IDs, timestamps, and
mounted resource metadata.

## Implementation Shape

### 1. Extract A Shared Idempotency Ledger Primitive

Today the idempotency table and operations live in `EventStore` because the
first endpoint was `events.send`.

For this second endpoint, extract the generic pieces into a shared ledger
interface before adding session-create integration:

- reservation;
- replay/fingerprint mismatch/in-progress handling;
- completion inside a caller-owned transaction;
- key validation;
- raw-byte fingerprinting helper;
- TTL and abandoned-row policy constants.
- shared `409` response shaping, including `Retry-After`.

Keep extraction mechanical. Do not introduce a broad service layer with endpoint
business logic. The ledger primitive should know nothing about sessions or
events beyond:

```text
workspace_id, method, concrete_path, key, route_label, fingerprint, response
```

The existing `EventStore` can keep owning its SQLite table in the first
implementation if that is the smallest diff, but the extracted interface should
make the ownership honest:

- endpoint code depends on a request-idempotency ledger contract;
- `events.send` and `sessions.create` both call that contract;
- durable deployment wiring provides one SQLite-backed implementation.

If extraction makes table ownership awkward, prefer a small
`SqliteRequestIdempotencyLedger` over continuing to expose idempotency methods
from `EventStore` to the session service. `EventStore` can compose the ledger
for `events.send` rather than own the generic concept forever.

Extraction must also normalize the in-progress conflict response for both
endpoints. `sessions.create` should not introduce a subtly different `409`
shape. If the shared contract includes `Retry-After`, add it to the existing
`events.send` path in the same implementation PR.

### 2. Reserve Before Side Effects

For `POST /v1/sessions`, reservation must happen before generating durable side
effects:

1. validate key shape;
2. parse raw body and compute fingerprint;
3. reserve `in_progress`;
4. only then run the create path.

This means abandoned-row reacquisition remains safe: if a process dies before
the session row commit, the retry can re-execute. If the session row commit and
idempotency completion commit together, the retry replays.

Handled failures are different from crashes. If create code catches a
post-reservation failure, performs its cleanup, and knows the metadata
transaction did not commit, it should delete/release the reservation row before
returning the error. Leaving the row `in_progress` would force the client to wait
for the abandoned threshold even though immediate re-execution is safe.

### 3. Commit Session Row And Ledger Completion Together

Add a durable create method that persists these in one SQLite transaction:

- session row;
- session resources;
- session file-mount snapshot rows;
- pending create-rollback cleanup for that session;
- idempotency completion row with status/body.

This is the `sessions.create` equivalent of
`appendBatchWithRuntimeChangesAndCompleteIdempotency(...)`.

The session service should receive a commit target when it is running
idempotently, then call the store method that completes the ledger inside the
same transaction.

### 4. Keep External Object Writes Outside The Metadata Transaction

Do not try to put file bytes or runtime preparation in the metadata transaction.
They are external side effects.

Use the existing pending-create-rollback rows as the durability backstop:

- snapshot rollback rows are recorded before snapshot object creation;
- session-store commit clears rollback rows only if the session row and
  idempotency completion both commit;
- if the process dies after snapshot creation but before metadata commit, startup
  sweep removes orphaned internal snapshots;
- if runtime preparation happened but metadata commit failed, current best-effort
  close remains the immediate cleanup and runtime-provider reaping remains the
  backstop.

The implementation PR should not widen this into a new storage-seam project.

### 5. Generate IDs After Reservation

Generate `sessionId`, `resourceId`, and snapshot file IDs after a reservation is
acquired.

Do not try to derive IDs from the idempotency key. Replays should use the stored
response from the completed ledger row, not deterministic ID generation.

### 6. Delete Cleanup

When a session is hard-deleted, delete completed `POST /v1/sessions`
idempotency rows whose completed response created that session.

This requires adding a way to associate a completed idempotency row with the
created resource ID. The current `events.send` cleanup can delete by concrete
path (`/v1/sessions/{id}/events`), but `POST /v1/sessions` has a shared path, so
path-based cleanup is not enough.

Recommended minimal schema extension:

```sql
resource_type TEXT,
resource_id TEXT
```

For `events.send`, leave these null. For `sessions.create`, set:

```text
resource_type = "session"
resource_id = <created session id>
```

Then delete session-create idempotency rows by `(workspace_id, resource_type,
resource_id)` during hard delete.

This preserves the invariant from the delete cleanup cookbook: after delete,
retrying an old key should not replay a response for a session that no longer
exists.

An `in_progress` session-create row cannot be found this way because
`resource_id` is assigned at completion. That is acceptable: an in-progress
create has not produced a deletable session yet.

## In-Memory Mode

Match the existing deployment pattern:

- durable SQLite mode gets the transaction-backed guarantee;
- in-memory mode is best-effort parity for tests/local use.

The in-memory ledger should still prevent duplicate session creation within a
single process, but it should be documented as non-atomic across process crashes.

## Acceptance Tests

### Contract Tests

- no header preserves current behavior and creates distinct sessions on distinct
  requests;
- same key + same raw body replays the same response body and same session ID;
- same key + different raw body returns `invalid_request_error`;
- same key while fresh `in_progress` returns `409` and `Retry-After`;
- `events.send` and `sessions.create` use the same `409`/`Retry-After`
  contract after extraction;
- invalid key is rejected before reservation;
- handled post-reservation failure releases the reservation so immediate retry
  re-executes instead of returning `409`;
- completed key expires after TTL and may create a new session.

### Durable Restart Tests

- after a completed session create, recreating the app against the same SQLite
  files and retrying with the same key replays the original session ID;
- an abandoned `in_progress` row for `POST /v1/sessions` can be reacquired and
  create exactly one visible session.

### Atomicity Tests

- trigger an error inside the session-row/idempotency-completion transaction and
  assert neither session row nor completed idempotency row survives;
- resource-backed create with commit failure leaves no visible session and
  queues/sweeps pending internal snapshot create rollback;
- retry after that failed resource-backed create can succeed with the same key.

### Resource Tests

- retrying a resource-backed create replays the original session resource IDs
  and does not create duplicate internal snapshots;
- deleting the created session removes the session-create idempotency row so a
  retry with the old key returns a fresh create or, if policy chooses stricter
  behavior, does not replay the deleted session body;
- if the referenced uploaded file is deleted before first execution, the 400 is
  completed and replayed for retries with the same key;
- if the referenced uploaded file is deleted after successful create, replay
  still returns the original successful session response until TTL/delete
  cleanup.

## Non-Goals

- Do not make `Idempotency-Key` mandatory.
- Do not support file upload or multipart idempotency in this slice.
- Do not support streaming response replay.
- Do not redesign snapshot cleanup or runtime provider cleanup.
- Do not implement Postgres or async store interfaces here.

## Open Questions For Review

1. Should delete cleanup make old `POST /v1/sessions` keys reusable as a brand
   new create, or should it tombstone them until TTL with a 404/410-style
   response?

   Recommendation: reuse as a brand-new create after delete, matching
   `events.send` delete cleanup. Document that idempotency replay ends when the
   created session is deleted.

2. Should resource-backed validation 4xx responses be completed and replayed?

   Recommendation: yes, if the failure happens after reservation and before any
   side effects. This matches ADR 0015. Invalid key/auth/pre-reservation failures
   still do not reserve.

3. Should runtime preparation happen before or after metadata commit?

   Recommendation for this slice: do not reorder. Preserve today's compatibility
   requirement that `sessions.create` returns only after resources are prepared,
   and rely on existing best-effort runtime close plus provider reaping if the
   later metadata commit fails.

4. What happens to the reservation row on a handled failure after reservation
   but before metadata commit?

   Recommendation: delete/release the reservation before returning the error.
   This covers realistic create-path failures such as runtime preparation
   failure or file read errors after reservation. It is safe because the
   metadata transaction did not commit; if it had committed, the ledger row would
   be `completed`, not still `in_progress`.

## Recommended Implementation Slice

Use a `dev/session-create-idempotency` branch and PR. Keep the first PR limited
to:

1. shared request-idempotency ledger extraction;
2. `POST /v1/sessions` route integration;
3. session-store create-and-complete transaction;
4. delete cleanup by created session ID;
5. tests above;
6. cookbook update once behavior lands.

Do not include file upload/multipart idempotency or Postgres preparation in this
PR.
