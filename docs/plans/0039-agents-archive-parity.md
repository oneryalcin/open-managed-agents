# Plan: Agents Archive Parity

Issue: [#39](https://github.com/oneryalcin/open-managed-agents/issues/39)

Status: plan-only branch, implementation follows after review.

## Goal

Add `POST /v1/agents/:id/archive` with hosted Managed Agents parity for
archiving agent definitions.

This is a contained API-shape slice. It must not grow into session lifecycle
cleanup, agent version history, beta-header enforcement, or runtime orchestration.

## Live Contract Evidence

Primary probe:

```bash
uv run --with anthropic python scratch/30-managed-agents-agent-archive-probe.py
```

Captured output:

- `scratch/artifacts/30-managed-agents-agent-archive-probe-output.txt`

Probe findings:

1. `agents.archive(agent_id)` while an agent has an actively running session
   succeeds. The running session continues independently and reaches
   `session.status_idle`; archive does not interrupt, cascade, terminate, or
   mutate existing sessions.
2. Re-archiving is idempotent. The second archive call succeeds and returns the
   same `archived_at` value.
3. Archived agents remain retrievable by direct ID. Hosted
   `agents.retrieve(agent_id)` returns the archived agent with `archived_at`.
4. Default `agents.list()` excludes archived agents; `include_archived=true`
   includes them.
5. Creating a new session with an archived agent fails with 400
   `invalid_request_error` and the message:
   `agent <agent_id> is archived and cannot be used to create a session`.
   This applies to the current agent reference and explicit versioned
   references.
6. Archive applies to the agent line, not one version. Hosted version 1 and the
   current version both return the same `archived_at` after archive.
7. A valid-looking missing agent ID returns 404 `not_found_error` with
   `Agent not found.`. A malformed/invalid-looking agent ID returns 400
   `invalid_request_error` with `Invalid agent ID.`.

Important correction to #39: the issue body says archived agents should be
excluded from default list/retrieve behavior "consistently with the existing
store model." The live API contradicts the retrieve half. For hosted parity,
default list excludes archived agents, but direct retrieve returns archived
agents.

## Current OMA State

- Agent rows already have `archived_at` in the SQLite schema
  (`src/control-plane/agents/store.ts:10-29`).
- The store currently has only active direct lookup:
  `retrieveActiveStmt` filters `archived_at IS NULL`
  (`src/control-plane/agents/store.ts:54-73`, `127-135`).
- Agent list already supports `includeArchived`; default list filters archived
  rows (`src/control-plane/agents/store.ts:74-97`, `138-169`).
- The public agents router exposes create/list/retrieve only; there is no
  archive route (`src/control-plane/agents/routes.ts:6-36`).
- The agent service has create/retrieve/list only
  (`src/control-plane/agents/service.ts:25-78`).
- Session creation currently resolves agents through `AgentStore.retrieve`,
  so archived and missing agents collapse into the same
  `Agent <id> not found` path
  (`src/control-plane/sessions/service.ts:62-75`).
- Existing tests currently assert direct missing-agent retrieval returns OMA's
  existing 404 shape, `Agent <id> not found`
  (`src/control-plane/__tests__/agents-api.test.ts`).

## Design

### 1. Extend the Agent Store Boundary

Add explicit methods to `AgentStore`:

```ts
retrieveAny(workspaceId: WorkspaceId, agentId: string): AgentRow | undefined;
archive(
  workspaceId: WorkspaceId,
  agentId: string,
  archivedAt: string,
): AgentRow | undefined;
```

Keep `retrieve(...)` as the active-only lookup for call sites that need an
active agent.

`SqliteAgentStore.archive` should be synchronous and idempotent:

- `UPDATE agents SET archived_at = COALESCE(archived_at, ?), updated_at =
  CASE WHEN archived_at IS NULL THEN ? ELSE updated_at END` by workspace and
  id.
- Return `retrieveAny(...)` after the update.
- A second archive must not refresh `archived_at`; it should also avoid
  refreshing `updated_at` on a no-op re-archive. The hosted probe clearly pins
  `archived_at` idempotency, while `updated_at` differs between immediate
  archive and later retrieve responses, so do not overfit tests to hosted
  `updated_at` behavior beyond no-op stability.

No transaction abstraction is needed for this single-row update. Keep it boring.

### 2. Split Public Retrieve From Session-Create Eligibility

Hosted parity requires two lookup meanings:

- `GET /v1/agents/:id`: direct lookup; returns archived agents.
- `sessions.create`: active-agent eligibility; rejects archived agents with the
  hosted archived-agent message.

Implement that distinction explicitly:

- `AgentService.retrieve(...)` should use `store.retrieveAny(...)`.
- `SessionService.create(...)` should inspect `store.retrieveAny(...)` so it can
  distinguish:
  - missing agent: keep current OMA invalid request shape unless review decides
    to adopt hosted's terse `Agent not found.` message.
  - archived agent: throw invalid request with hosted message
    `agent <agent_id> is archived and cannot be used to create a session`.
  - active agent: proceed with the existing version check.

Do not make direct retrieve active-only just because the existing store happened
to have that shape before `agents.archive` existed. The direct retrieve contract
is now probe-grounded.

### 3. Add the Public Route

Add:

```http
POST /v1/agents/:id/archive
```

Route body is ignored/empty. It should call `service.archive(...)` and return
the managed agent object with status 200.

Missing valid-looking agent IDs should return OMA's standard not-found envelope.
Do not spend this slice on strict hosted ID-format validation; OMA's existing ID
parsing is permissive across resources.

### 4. Keep Existing Sessions Independent

Do not inspect session rows, active runtime tasks, event streams, or sandbox
state during agent archive.

Hosted allows archive while a session is running and the session keeps going.
OMA sessions already snapshot the agent ref into the session row at create time,
so the archive operation should only affect future session creation.

This is the key boundary for avoiding lifecycle scope creep:

- no `SessionService` dependency from `AgentService`
- no runtime cleanup
- no cascade
- no `session.status_terminated`
- no event-store writes

### 5. Versioning Note

Hosted archive applies to the whole agent line: retrieving version 1 and the
current version after archive returns the same `archived_at`.

OMA currently stores one agent row with one `version`, not a version-history
table. For this slice, archiving that row is sufficient and matches the current
model. If agent version history lands later, the archived timestamp belongs to
the agent line, not one version row.

## Acceptance Criteria

1. `POST /v1/agents/:id/archive` returns 200 and the agent object with
   `archived_at` set.
2. Re-archiving the same agent returns 200 with the same `archived_at` value.
3. `GET /v1/agents/:id` returns the archived agent after archive.
4. `GET /v1/agents` excludes archived agents by default.
5. `GET /v1/agents?include_archived=true` includes archived agents.
6. `POST /v1/sessions` with an archived agent rejects with 400
   `invalid_request_error` and exact message
   `agent <agent_id> is archived and cannot be used to create a session`.
7. Explicit versioned session create requests for the archived agent reject with
   the same archived-agent message.
8. Existing sessions created before agent archive remain retrievable and keep
   their original agent ref.
9. Archiving an agent does not call any session runtime cleanup path and does
   not emit session lifecycle events.
10. Cross-workspace archive and retrieve do not leak agents.
11. Missing-agent archive returns caller-safe not found and does not create any
    row.

## Tests

Add focused tests in the existing test layers:

1. `src/control-plane/agents/__tests__/service-store.test.ts`
   - archive sets `archived_at` and is idempotent.
   - direct retrieve uses `retrieveAny` semantics after archive.
   - default list excludes archived; include-archived list includes it.
   - cross-workspace archive cannot see another workspace's agent.
2. `src/control-plane/__tests__/agents-api.test.ts`
   - route response shape and idempotency.
   - retrieve-after-archive parity.
   - list/default vs `include_archived=true`.
   - missing archive route error envelope.
3. `src/control-plane/__tests__/core-control-plane-api.test.ts` or a narrow session API
   test:
   - session create with archived agent rejects with the hosted message.
   - versioned archived-agent create rejects with the same hosted message.
   - existing pre-archive session remains retrievable after agent archive.

Run:

```bash
npm run typecheck
npx vitest run
```

## Non-Goals

- No agent version-history API.
- No `agents.update` changes beyond what current tests already cover.
- No session cascade, session termination, event emission, or runtime cleanup.
- No beta-header enforcement (#46).
- No archive preflight TOCTOU guard work (#61).
- No broader archive/delete cross-store atomicity work.

## Risks And Mitigations

1. **Stale issue-body assumption about retrieve.**
   The issue says archived agents should be excluded from retrieve. Hosted
   returns archived agents by direct ID. Mitigation: implement hosted parity and
   name this correction in the PR description.
2. **Archived and missing agents collapsing in session create.**
   If `sessions.create` continues to use active-only lookup, archived agents
   will look missing. Mitigation: session create must use `retrieveAny` and then
   branch on `archived_at`.
3. **Lifecycle scope creep.**
   Agents archive sounds adjacent to sessions, but hosted proves existing
   sessions are independent. Mitigation: keep `AgentService` free of session and
   runtime dependencies.
4. **Future version-history mismatch.**
   Hosted archives the agent line across versions. Mitigation: document the
   line-level archived timestamp now; future version storage must preserve it.

## Review Checklist

- Does the implementation keep active-only lookup and direct lookup as separate
  concepts?
- Does the route avoid any session/runtime dependency?
- Does `sessions.create` produce the hosted archived-agent message instead of
  `Agent <id> not found`?
- Does idempotency preserve the original `archived_at`?
- Do default list and direct retrieve intentionally diverge exactly as hosted
  does?
