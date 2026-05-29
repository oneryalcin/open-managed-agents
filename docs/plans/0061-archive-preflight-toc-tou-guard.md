# Plan: Archive Preflight TOCTOU Guard

Issue: [#61](https://github.com/oneryalcin/open-managed-agents/issues/61)

## Goal

Make the `POST /v1/sessions/{id}/archive` preflight-to-row-mutation invariant
explicit and testable. Today the route is correct because the code happens to
run:

```ts
events.assertSessionArchivable(DEFAULT_WORKSPACE_ID, sessionId);
const session = service.archive(DEFAULT_WORKSPACE_ID, sessionId);
await events.archiveSession(DEFAULT_WORKSPACE_ID, sessionId);
```

with no `await` between the preflight and the session-row mutation. That is the
right runtime behavior, but it is protected by review discipline rather than an
architectural boundary.

## Current Contract

- `assertSessionArchivable(...)` is synchronous.
- It rejects genuinely running/rescheduling sessions.
- It allows idle, already-terminated, already-archived, and hosted-probed
  `requires_action` sessions paused on pending custom-tool input.
- `service.archive(...)` is synchronous today.
- `events.archiveSession(...)` may remain async because it runs after the row is
  archived and handles cleanup/event emission.

## Design

Add one typed synchronous archive boundary to `SessionEventsService`:

```ts
archiveSessionRowAfterPreflight(
  workspaceId: WorkspaceId,
  sessionId: string,
): SessionRow;
```

Implementation in `DefaultSessionEventsService`:

1. Run the existing archive eligibility checks internally. The old
   `assertSessionArchivable(...)` method should stop being part of the public
   `SessionEventsService` interface so route code cannot choose the unsafe
   check-only API.
2. Increment a short-lived `archivingSessions` guard count keyed by the full
   workspace/session identity.
3. Mutate the same session row synchronously through the already-injected
   `SessionStore.archive(workspaceId, sessionId, archivedAt)`.
4. Always decrement the guard count in `finally`.
5. Return the archived `SessionRow`.

Route shape becomes:

```ts
const row = events.archiveSessionRowAfterPreflight(
  DEFAULT_WORKSPACE_ID,
  sessionId,
);
await events.archiveSession(DEFAULT_WORKSPACE_ID, sessionId);
return c.json(toManagedSession(row), 200);
```

Why this boundary earns its place:

- It makes preflight and session-row mutation one synchronous service operation.
  The caller cannot acquire a guard, `await`, and then mutate later.
- It does not move row mutation into an arbitrary callback, so there is no
  post-mutation validation failure mode that can strand an archived row without
  lifecycle cleanup.
- It uses the same `SessionStore` already held by
  `DefaultSessionEventsService` for `requireExistingSession(...)`, so no new
  storage dependency is introduced.
- The temporary `archivingSessions` guard lets tests inject the exact race shape
  from #61 inside `SessionStore.archive(...)`: a user event starts after
  preflight but before the row mutation. During that window, `send(...)`
  rejects like it would immediately after the row has been archived.
- The guard is count/token-based rather than a bare `Set`. If overlapping
  archive attempts begin for the same workspace/session identity, one failed
  path releasing its guard must not unblock `send(...)` while another
  preflight-to-mutation window is still open.
- The guard key includes `workspaceId`. A preflight in one workspace must not
  block or release a same-string `sessionId` in another workspace.

## Rejection Semantics During Guard Window

If `send(...)` sees a positive `archivingSessions` count for the current
`workspaceId` + `sessionId`, reject with the same caller-safe `not_found`
shape used for archived sessions:

```text
Session <id> not found
```

This keeps the transient guard behavior indistinguishable from the state clients
would observe once the archive mutation has completed.

The guard check must be the first side-effect boundary in `send(...)`, before:

- active-session lookup
- request parsing
- custom-tool result claiming
- pending custom-tool state mutation
- event materialization/persistence/broadcast
- runtime scheduling / `activeRuntimeTasks` increments

The goal is not only "do not start runtime work." The goal is "no late user
event or pending-tool mutation can enter a session that has passed archive
preflight and is about to have its row archived."

## Tests

Add focused tests in `session-lifecycle-api.test.ts`:

1. Route/behavior test: archive still rejects an actively running session with
   the hosted message and does not call cleanup.
2. Boundary test:
   `archiveSessionRowAfterPreflight(...)` archives and returns the row for an
   idle session.
3. Race test: use a test hook/fake store so `SessionStore.archive(...)` invokes
   `service.send(...)` for the same workspace/session after preflight but before
   the archive row mutation. It must reject before any side effect:
   - event store remains unchanged
   - broadcaster does not publish the attempted user event
   - pending custom-tool state remains unchanged
   - `activeRuntimeTasks` is not incremented
4. Failure-path test: if `SessionStore.archive(...)` throws after the guard is
   incremented, the guard count is decremented so future operations are not
   permanently blocked.
5. Overlap test: simulate overlapping archive-row calls for the same
   workspace/session and assert `send(...)` remains rejected until the outermost
   archive operation exits. This pins the guard as ref-counted/token-aware, not
   a bare `Set.delete(...)`.
6. Cross-workspace isolation test: create or stub the same `sessionId` in two
   workspaces, archive-preflight one workspace, and assert `send(...)` in the
   other workspace is not blocked by the guard.
7. Public interface test by typecheck: route code uses
   `archiveSessionRowAfterPreflight(...)`; `assertSessionArchivable(...)` is no
   longer part of `SessionEventsService`.
8. Existing broader lifecycle tests continue to cover archive cleanup after the
   row mutation. Do not add post-mutation validation inside the guard.

## Non-Goals

- Do not solve the broader archive/event-store cleanup atomicity debt. This
  slice only guards the preflight-to-session-row mutation boundary.
- Do not change `DELETE /v1/sessions/{id}`.
- Do not change the hosted archive contract from PR #60.
- Do not introduce a general transaction framework. The issue is a narrow
  synchronous boundary around one route.
