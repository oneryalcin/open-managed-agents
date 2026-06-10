# ADR 0015: Request idempotency for retry-safe writes

**Status:** Accepted, 2026-06-10

## Context

OMA's REST surface has several retry-sensitive `POST` endpoints. If a client
times out after the server commits a write but before the HTTP response reaches
the client, retrying the request can currently duplicate side effects.

The highest-risk path is `POST /v1/sessions/{id}/events`:

- duplicate `user.message` can append a second user event and start a second
  runtime prompt;
- duplicate `user.custom_tool_result` can race pending tool wait resolution;
- duplicate `user.tool_confirmation` can replay an approval decision with a new
  event ID.

The roadmap already records this as a gap from Cycle B.2 onward. The general
HTTP answer is the `Idempotency-Key` request header: clients reuse the same key
when retrying the same write, and the server either replays the first response
or rejects unsafe key reuse. MDN's `Idempotency-Key` reference and the IETF HTTP
API draft both describe fingerprinting repeated requests, `409 Conflict` for a
same-key request that is still being processed, and explicit key expiry
documentation.

OMA cannot implement this safely as generic middleware. A middleware can reserve
a key before the handler and store the completed response after the handler, but
that leaves a crash window: the domain write can commit while the idempotency
row still says `in_progress`. On retry, the server cannot know whether to
re-execute or replay.

OMA's current durable SQLite mode can do better for `events.send` because the
event log, runtime ledger, and idempotency ledger can share one `DatabaseSync`
transaction. The first implementation should use that property instead of
porting a generic middleware pattern.

## Decision

### 1. Use `Idempotency-Key` on retryable JSON writes

OMA will support the `Idempotency-Key` request header for selected `POST`
endpoints. The first endpoint is:

- `POST /v1/sessions/{session_id}/events`

Do not require the header globally. Requests without the header keep today's
behavior until an endpoint explicitly opts in.

Do not apply this to streaming responses. If a future streaming write endpoint
receives `Idempotency-Key`, reject it until replay semantics are explicitly
designed. Idempotency replay is JSON-response replay only.

### 2. Scope keys to the concrete request path

The idempotency key namespace is:

```text
workspace_id + method + concrete_path + idempotency_key
```

Use the concrete path, for example
`/v1/sessions/sesn_123/events`, not a route pattern such as
`/v1/sessions/:id/events`. This avoids accidental collisions when a client
reuses a key against two different sessions.

Store a request fingerprint as:

```text
sha256(method + "\n" + concrete_path + "\n" + raw_request_body_bytes)
```

For the first `events.send` slice, hash the raw JSON request bytes rather than
canonicalized JSON. A genuine retry should resend the same bytes. Supporting
semantic equivalence between differently formatted JSON is unnecessary
complexity and not required by the HTTP idempotency-key guidance.

If a retry uses the same key namespace but a different fingerprint, return a
client error and do not run the domain operation.

### 3. Put ledger completion inside the domain transaction

For `events.send`, the durable path is:

1. validate the key shape before reserving anything;
2. reserve an `in_progress` idempotency row;
3. execute the event append/runtime mutation and mark the idempotency row
   `completed` with the JSON response body in the same SQLite transaction;
4. publish persisted events only after that transaction commits.

This closes the critical crash window. If the process dies during the domain
transaction, the event append and completed response both roll back, while the
reserved `in_progress` row may remain. A later retry can treat an old
`in_progress` row as abandoned and safely re-execute because the side effect
could not have committed.

In-memory mode may implement the same contract best-effort, matching the
existing deployment coordinator pattern: useful for tests/local operation, not
an atomic cross-store guarantee.

### 4. Use retry-shaped errors for in-flight conflicts

If another request with the same key namespace and fingerprint is still fresh
and `in_progress`, return:

- HTTP status `409`;
- the existing OMA error envelope;
- error type `invalid_request_error`.

The status code carries the retry semantics: clients should wait and retry the
same request later. The error type stays within the API vocabulary OMA already
uses.

If the same key namespace is reused with a different fingerprint, return an
`invalid_request_error` that tells the caller the idempotency key was already
used for a different request.

### 5. Replay completed outcomes, including 4xx

When the original request completes and stores a JSON response, retries with the
same key namespace and fingerprint return the stored status/body rather than
running the handler again.

Store and replay completed handler outcomes including 4xx responses. A retried
validation failure should fail identically instead of flapping based on later
state.

Do not store anything for requests rejected before idempotency reservation, such
as malformed idempotency keys or future auth failures. 5xx crashes leave an
`in_progress` row. If that row becomes stale, a retry may re-execute.

### 6. Expire keys and purge opportunistically

Idempotency rows need bounded lifetime. The first implementation should use:

- `expires_at` on every row;
- a 24-hour default TTL for completed rows;
- opportunistic purge on reservation attempts.

Expired completed rows may be deleted. After deletion, key reuse is treated as a
new request. This is acceptable only because the expiry behavior is documented.

For `in_progress` rows, use a separate abandoned threshold. The first
implementation should choose a conservative default and document it near the
store. Once an `in_progress` row is older than that threshold, a matching retry
may acquire it and re-execute the domain operation.

### 7. Avoid generic abstractions until a second endpoint lands

The first implementation should add the minimal idempotency store/operation
needed for `events.send`. Do not introduce a broad `IdempotencyService`
abstraction yet.

When `sessions.create` is implemented, extract only the common pieces proven by
both endpoints. `sessions.create` has harder side effects, including file
resource snapshots and optional runtime preparation, so it should not shape the
first `events.send` primitive prematurely.

## Implementation sketch for `events.send`

Add an idempotency table to the shared metadata database:

```sql
CREATE TABLE IF NOT EXISTS idempotency_keys (
  workspace_id TEXT NOT NULL,
  method TEXT NOT NULL,
  concrete_path TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  route_label TEXT NOT NULL,
  fingerprint_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, method, concrete_path, idempotency_key)
);
```

Use portable upsert-style SQL where possible. Prefer
`INSERT ... ON CONFLICT DO NOTHING` over SQLite-specific `INSERT OR IGNORE` so
the shape ports cleanly to Postgres.

The `events.send` integration should parse the raw JSON body once, compute the
fingerprint from the exact bytes, reserve the key, then pass both the parsed
input and idempotency commit target into the event service/store path.

The durable commit path must put these in one transaction:

- event rows;
- runtime ownership changes;
- completed idempotency row with response status and JSON response body.

Only after that transaction commits should the service publish persisted events
to SSE subscribers or start runtime prompts.

## First PR acceptance criteria

The first code PR should cover only
`POST /v1/sessions/{session_id}/events`.

Required behavior:

- no `Idempotency-Key` preserves current behavior;
- same key + same concrete path + same raw body returns the same event IDs and
  does not start a second runtime prompt;
- same key + same concrete path + different raw body returns an
  `invalid_request_error`;
- same key + same concrete path while the original request is still fresh
  `in_progress` returns HTTP `409`;
- stale abandoned `in_progress` rows can be retried and re-executed safely;
- completed 4xx outcomes are replayed;
- expired completed keys are purged opportunistically and may be reused.

Required tests:

- duplicate `user.message` retry returns the same response and produces one
  runtime prompt;
- duplicate `user.custom_tool_result` retry does not resolve a pending custom
  tool twice;
- mismatched body for the same key errors without appending events;
- in-flight same-key request returns `409`;
- durable restart after a completed request replays the same response;
- trigger-induced abort inside the event/idempotency transaction proves neither
  event rows nor completed ledger rows persist;
- abandoned `in_progress` retry re-executes without deadlocking on the stale
  row.

## Deferred

- `POST /v1/sessions`
- `POST /v1/files`
- idempotency for multipart request fingerprints
- streaming-response replay semantics
- enforcing idempotency keys as mandatory on any endpoint
- global middleware

## Consequences

- The first slice is more coupled to `events.send` than a generic middleware
  would be, but it is materially safer because the idempotency ledger completes
  in the same transaction as the domain write.
- SQLite durable mode gets a strong retry property for the highest-risk user
  event path.
- In-memory mode remains best-effort, consistent with other deployment seams.
- The same transaction shape can later be re-expressed in Postgres with row
  locks or equivalent transaction semantics.
- Future endpoint support should be added only when its side effects can be
  reasoned about with the same level of specificity.

## References

- [MDN: Idempotency-Key header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Idempotency-Key)
- [IETF HTTPAPI draft: The Idempotency-Key HTTP Header Field](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-00)
