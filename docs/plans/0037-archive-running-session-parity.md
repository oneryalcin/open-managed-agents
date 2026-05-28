# Plan: Archive-running-session parity

Status: Draft, 2026-05-28

Tracking issue: [#37](https://github.com/oneryalcin/open-managed-agents/issues/37)

This is the remaining lifecycle-parity half of #37 after `user.interrupt` landed
in PR #58. The goal is to make `POST /v1/sessions/{id}/archive` reject running
sessions before mutating session state or closing runtime resources. Clients
must interrupt first, wait for the session to become idle, then archive.

## Probe Result

Live hosted probe:

```bash
uv run --with anthropic python scratch/28-managed-agents-archive-running-probe.py
```

Evidence is saved at:

- `scratch/artifacts/28-managed-agents-archive-running-probe-output.txt`

Observed hosted behavior:

- `sessions.archive(session_id)` during `session.status_running` returns HTTP
  400 `invalid_request_error`.
- Exact hosted message captured:

  ```text
  Session <session_id> cannot be archived while its status is "running". Only pending or idle sessions may be archived.
  ```

- The session is not archived: `archived_at` remains `null`.
- The in-flight turn continues to completion and the session later emits
  `session.status_idle`.
- This means hosted archive does **not** implicitly interrupt a running session.

## Current State

- `src/control-plane/sessions/routes.ts:45-49` mutates the session row first via
  `service.archive(...)`, then calls `events.archiveSession(...)`.
- `src/control-plane/sessions/service.ts:145-155` archives unconditionally for
  any existing session row.
- `src/control-plane/events/service.ts:131-145` appends
  `session.status_terminated` and best-effort closes runtime.
- `src/control-plane/events/service.ts:193-205` already distinguishes active
  vs closed streams by reading the session row status.
- `src/control-plane/__tests__/session-lifecycle-api.test.ts:179-213`
  currently asserts the old behavior: archive mid-runtime succeeds and blocks
  late runtime output.

The risky bug shape is the existing commit-first ordering: if archive should
reject while running, the route cannot update the row before asking the
lifecycle/event layer whether archiving is currently legal.

## Non-Goals

- Do not change `DELETE /v1/sessions/{id}` behavior in this slice. Delete may
  remain the hard cleanup verb that tears down a running runtime.
- Do not implement `agents.archive`; that remains separate API parity.
- Do not implement stronger cross-request interrupt/message semantics from
  [#59](https://github.com/oneryalcin/open-managed-agents/issues/59).
- Do not add a new runtime abstraction unless the existing event/session
  services cannot express the running check cleanly.

## Design

### 1. Add A Preflight Boundary Before Store Mutation

Add a lifecycle preflight on the events/runtime side, for example:

```ts
assertSessionArchivable(workspaceId, sessionId): void;
```

This should live on `SessionEventsService` because `DefaultSessionEventsService`
owns the in-memory active runtime task count and lifecycle guards. The route
should call this before `service.archive(...)`.

Required route ordering:

```ts
events.assertSessionArchivable(DEFAULT_WORKSPACE_ID, sessionId);
const session = service.archive(DEFAULT_WORKSPACE_ID, sessionId);
await events.archiveSession(DEFAULT_WORKSPACE_ID, sessionId);
return c.json(session, 200);
```

If the preflight rejects, no session row changes and no lifecycle event is
appended.

The preflight and `service.archive(...)` call must run as one synchronous block
with no `await` or other suspension point between them. `assertSessionArchivable`
should be synchronous because it only reads session state and
`activeRuntimeTasks`. Suspending between check and mutate would reintroduce a
TOCTOU: another request could start a runtime task after the check but before
the row is archived.

### 2. Define "Running" From The Control Plane, Not From Stale Row State Only

`DefaultSessionEventsService` already maintains `activeRuntimeTasks`. Use that
as the source for "running in this process":

```ts
if ((this.activeRuntimeTasks.get(sessionId) ?? 0) > 0) reject;
```

Also treat a persisted active session row with `status === "running"` as not
archivable if the process can observe that status. This protects future
durable/restart scenarios where a row may say running even if the in-memory task
map is empty.

The check should still allow:

- idle active sessions,
- already archived/terminated sessions, preserving current idempotent archive,
- deleted/missing sessions should return the existing 404.

`rescheduling` is currently not produced by OMA's session service, but it is in
the public status enum. Treat it as not archivable for this slice unless a
hosted probe proves otherwise. Hosted archive says only pending or idle sessions
may be archived; OMA does not expose `pending`, so the conservative local rule
is: allow `idle` and already `terminated`; reject `running` and `rescheduling`.

### 3. Caller-Safe Error Contract

Use HTTP 400 `invalid_request_error`, matching the hosted probe:

```text
Session <session_id> cannot be archived while its status is "running". Only pending or idle sessions may be archived.
```

Use the hosted wording even though OMA does not currently expose a `pending`
status. That keeps the public contract closer to upstream and avoids inventing a
different client-visible string.

### 4. Keep Archive Commit/Cleanup Ordering For Idle Sessions

For idle sessions, keep current public behavior:

- archive returns 200 with `status: "terminated"` and `archived_at` set,
- event history remains readable,
- exactly one `session.status_terminated` is appended,
- re-archive is idempotent and does not duplicate terminal events,
- runtime close remains best-effort.

Do not try to make session-store and event-store archival fully atomic in this
slice. The load-bearing parity fix is rejecting running sessions before the
session row can be mutated. Once preflight passes for an idle session, current
best-effort cleanup behavior is acceptable and already covered by tests.

## Acceptance Criteria

1. Running archive rejection:
   - Start a session turn using a fake runtime that keeps
     `activeRuntimeTasks[sessionId] > 0`.
   - `POST /v1/sessions/{id}/archive` returns HTTP 400
     `invalid_request_error` with the hosted message shape.
   - `GET /v1/sessions/{id}` still shows `archived_at: null` and active
     status semantics are not converted to `terminated`.
   - `GET /v1/sessions/{id}/events` contains no
     `session.status_terminated`.
   - `runtimeRunner.closeSession` is not called.
   - The implementation has no `await` or Promise-producing call between the
     archive preflight and the session row mutation.

2. Archive after interrupt/idle succeeds:
   - Start a fake runtime turn.
   - Send `user.interrupt`, settle/release the runtime so the session returns
     to idle.
   - Archive returns 200 and appends exactly one
     `session.status_terminated`.

3. Existing idle archive behavior stays green:
   - Archive idle session succeeds.
   - Re-archive remains idempotent.
   - The preflight explicitly allows an already terminated/archived session.
   - Archived session events remain readable and streams replay closed history.

4. Rescheduling status is not archived:
   - A direct store/service-level test for a `rescheduling` row rejects archive
     with a caller-safe 400, unless implementation proves the state is
     impossible to construct without widening test seams.

5. Delete behavior is unchanged:
   - Deleting a running session still performs hard cleanup per current tests.

6. Probe/docs:
   - Keep `scratch/28-managed-agents-archive-running-probe.py` and its captured
     output as the upstream evidence, or fold the key result into the PR body if
     the probe artifact is not committed.

## Implementation Steps

1. Add `assertSessionArchivable(...)` or equivalent to
   `src/control-plane/events/types.ts`.
2. Implement it in `src/control-plane/events/service.ts`:
   - require existing session,
   - reject when `activeRuntimeTasks` says running,
   - reject when the retrieved row status is `"running"` or `"rescheduling"`,
   - allow idle and already terminated/archive-idempotent sessions.
3. Reorder `src/control-plane/sessions/routes.ts` archive route so synchronous
   preflight happens immediately before `service.archive(...)`, with no `await`
   between those two calls.
4. Update `src/control-plane/__tests__/session-lifecycle-api.test.ts`:
   - replace the current "archive mid-runtime succeeds" expectation with
     "archive mid-runtime rejects without mutation/cleanup",
   - add the "interrupt then archive" success path,
   - keep the delete-mid-runtime coverage unchanged.
5. Add or update docs/reference notes only if they still describe archive as
   best-effort-close parity behavior after the code changes.

## Risks And Mitigations

- **Race: runtime finishes between preflight and store archive.**
  This is safe: the preflight may reject slightly conservatively when a turn is
  just finishing. The client can retry after observing idle.

- **Race: runtime starts after preflight but before archive.**
  In current OMA, new runtime work is only started by `events.send`, and
  archived sessions reject new sends because `service.archive(...)` removes the
  active session before any later send can pass `requireActiveSession`. Tests
  should keep this route ordering explicit.

- **Durable restart with stale `status: "running"`.**
  Rejecting row status `"running"` is conservative and matches the hosted error.
  A future recovery slice can reschedule or mark stale running sessions idle;
  archive should not silently terminate them in this slice.

- **Cross-store atomicity for idle archive remains imperfect.**
  This slice fixes the dangerous running-session mutation. Full transactionality
  across session and event stores is broader and should not be smuggled in unless
  tests show a current failure.

## Verification

- `npm run typecheck`
- `npm test`
- Focused tests:

  ```bash
  npx vitest run src/control-plane/__tests__/session-lifecycle-api.test.ts
  ```

- Optional live OMA smoke after implementation:

  ```bash
  ANTHROPIC_API_KEY=... npx tsx scratch/24-session-lifecycle-docker-midrun.ts
  ```

  Expect the archive half to be updated for the new 400-on-running behavior if
  it remains part of the smoke suite.
