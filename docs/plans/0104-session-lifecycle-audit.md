# Session Lifecycle Audit

Date: 2026-06-10

## Purpose

Capture the current user-visible lifecycle behavior before changing runtime
session controls again. The audit covers:

- running session archive/delete behavior,
- paused custom tool behavior,
- paused built-in tool confirmation behavior,
- live SSE subscriber behavior,
- hard delete versus archive cleanup.

This is an evidence artifact, not an implementation design.

## Current Behavior

### Running Sessions

Archive rejects an actually running session. The route calls
`archiveSessionRowAfterPreflight(...)` synchronously before the async archive
cleanup, and the preflight rejects active runtime work unless the session is
parked on a pending runtime action. It also rejects persisted `running` and
`rescheduling` rows.

This is covered by `session-lifecycle-api.test.ts`:

- archive while the fake runtime is active returns 400,
- the session row is not archived,
- no `session.status_terminated` event is written,
- runtime close is not called.

Delete is intentionally stronger. It remains allowed while runtime work is
active and performs hard cleanup:

- clears pending custom tool actions,
- clears pending tool confirmations,
- terminalizes pending runtime turns as deleted,
- writes and publishes `session.deleted`,
- closes live stream subscribers,
- best-effort closes the runtime,
- deletes event rows, pending runtime rows/actions, and `events.send`
  idempotency rows for the concrete session path.

### Paused Custom Tool

Archive is allowed when a session is idle on
`stop_reason.type = "requires_action"` for a custom tool. The current behavior
is:

- archive returns 200,
- runtime close is invoked best-effort,
- the event log remains readable,
- `session.status_terminated` is appended once,
- the pending custom tool action is cleared from the in-process service state.

This is covered at the archive level by
`archives a session paused on custom-tool requires_action`.

### Paused Built-In Tool Confirmation

Archive is also allowed when the session is idle on a built-in tool
confirmation wait. The current behavior is:

- archive returns 200,
- the session becomes `terminated`,
- pending confirmation state is cleared from the service.

Interrupt behavior is covered more deeply than delete/archive behavior here:
after `user.interrupt`, a stale `user.tool_confirmation` is rejected with 404.

### SSE Subscribers

SSE uses replay-then-tail semantics. The broadcaster registers a live subscriber
before replaying persisted history, then dedupes by event id while tailing.

Delete has explicit live-subscriber behavior:

- `session.deleted` is persisted and published,
- the broadcaster closes subscribers for the deleted session,
- the HTTP stream completes.

This is covered by `sends a terminal deletion event to live streams before
closing them`.

Archive does not call `broadcaster.closeSession(...)`. Archived session history
remains readable, and opening a stream after archive replays the closed history.
There is no test that keeps a stream open before archive and asserts what should
happen to that subscriber.

### Archive Versus Delete

Archive is a soft lifecycle transition:

- session row remains retrievable,
- normal session list hides it unless `include_archived=true`,
- event history remains readable,
- new sends are rejected because the session is no longer active,
- runtime close is best-effort.

Delete is a hard cleanup:

- session row is removed,
- event history is removed,
- pending runtime rows/actions are removed,
- session output metadata and objects are cleaned best-effort,
- `events.send` idempotency responses for the session path are removed,
- retrying an old `events.send` idempotency key after delete returns 404 rather
  than replaying the deleted session response.

## Visible Gaps

### 1. Decide And Test Archive Behavior For Existing SSE Subscribers

Current behavior is implicit. A client with an open stream during archive likely
receives `session.status_terminated` but the stream remains open until client
cancel because archive does not close subscribers.

That may be acceptable, but it should be intentional. Pick one contract:

- archive publishes `session.status_terminated` and leaves the stream open, or
- archive publishes `session.status_terminated` and closes the stream like
  delete closes after `session.deleted`.

Either contract needs one HTTP-level regression test.

### 2. Add HTTP-Level Delete Coverage For Paused Custom Tool Sessions

The service clears pending custom tool actions during delete, and runtime/event
cleanup is covered generally. What is missing is a user-visible test that drives:

1. session reaches `requires_action` on `agent.custom_tool_use`,
2. client deletes the session,
3. stale `user.custom_tool_result` returns 404,
4. event list returns 404,
5. no pending runtime rows are left behind.

This is cheap and closes the clearest visible lifecycle gap.

### 3. Add HTTP-Level Delete Coverage For Paused Tool Confirmation Sessions

Same shape as custom tools, but for built-in tool confirmation:

1. session reaches `requires_action` on `agent.tool_use`,
2. client deletes the session,
3. stale `user.tool_confirmation` returns 404,
4. event list returns 404,
5. no pending runtime rows/actions are left behind.

Interrupt already has stale-confirmation coverage; delete should have the same
visible guarantee.

### 4. Document Archive Stream Semantics Once Chosen

The client retry cleanup cookbook documents delete cleanup. It does not need to
become a lifecycle spec, but once archive stream behavior is made explicit, add a
short note to the relevant cookbook or reference doc:

- archive keeps history readable,
- delete sends terminal `session.deleted` to live streams and closes them,
- archive stream behavior is either "terminal event then close" or "terminal
  event then remain open until client reconnect/cancel".

## Recommended Next Slice

Do not start with new runtime capabilities. First make the existing behavior
crisp:

1. Add/choose the archive-with-live-SSE-subscriber contract and test.
2. Add delete-while-paused-on-custom-tool HTTP regression.
3. Add delete-while-paused-on-tool-confirmation HTTP regression.
4. Add the small doc note for archive/delete stream semantics.

This is a narrow, user-visible lifecycle polish slice. It should not require a
new storage seam or async store work.
