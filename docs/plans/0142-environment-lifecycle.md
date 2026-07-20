# 0142 — Environment archive/delete lifecycle

## Status

Implemented on the current feature branch for [#206](https://github.com/oneryalcin/open-managed-agents/issues/206). This is a bounded v1 lifecycle slice: archive is supported for immutable environments; physical deletion is supported only when it cannot orphan a durable OMA session.

## Evidence

- CMA documentation snapshot: `environments.md` says environments persist until archived/deleted, archive preserves existing sessions, and the default list hides archived rows.
- CMA live probe: [`scratch/69-managed-agents-environment-lifecycle-probe.md`](../../scratch/69-managed-agents-environment-lifecycle-probe.md) and its runnable script. It confirms archive idempotency, list filtering, and archived-environment session rejection.
- OMA runtime seam: `src/control-plane/wiring.ts` resolves a persisted session's environment at sandbox creation. It does not snapshot the environment configuration into the session row.

The live probe also found that hosted CMA currently permits deleting environments that idle sessions reference, despite the documentation saying otherwise. That would make OMA's persisted sessions unable to recreate their environment, so OMA deliberately diverges for safety.

## Requirements

- `POST /v1/environments/{id}/archive` archives an active environment, is idempotent, and returns the full environment object.
- `GET /v1/environments/{id}` retrieves active or archived environments.
- `GET /v1/environments` defaults to active rows; `include_archived=true|false` is validated and controls filtering.
- A new session cannot use an archived environment; existing sessions remain readable and executable because the environment remains persisted.
- A session creation that is preparing files or runtime state re-checks that the
  environment is still active immediately before its synchronous durable write.
- `DELETE /v1/environments/{id}` returns an explicit deletion response only when no session in the same workspace references it. Referenced environments return a 409; this prevents durable runtime reconstruction failures.
- All lifecycle operations are workspace scoped.
- The route registry/OpenAPI, tests, console adapter, and console UI describe and exercise only real endpoints.

## Non-goals

- No mutable environment configuration or replacement/update endpoint.
- No force delete, cascade delete, or session environment snapshot migration.
- No attempt to match hosted CMA's observed referenced-delete behavior.
- No deployment/cron/analytics work.

## Design

### Storage and service

Extend `EnvironmentStore` with `retrieveAny`, `archive`, and `delete`. Archive sets `archived_at` once and preserves the first archive timestamp; delete physically removes a row only after the service's session-reference guard passes.

Extend `SessionStore` with a workspace-scoped `hasEnvironmentReference` query. The environment service receives that narrow dependency. If a custom in-process composition does not supply the guard, deletion fails closed rather than deleting blindly.

Session creation resolves the environment through `retrieveAny`, then rejects an archived row before any file snapshots or runtime side effect. It repeats that active-environment check immediately before the durable session write, closing an archive/delete race while asynchronous preparation is in flight. Runtime egress resolution also uses `retrieveAny`, so archived rows remain available for already-created sessions.

### HTTP contract

| Operation | Success | Failure |
| --- | --- | --- |
| `POST /v1/environments/{id}/archive` | `200 Environment` | `404` missing/cross-workspace |
| `DELETE /v1/environments/{id}` | `200 {type:"environment_deleted", id}` | `404` missing/cross-workspace; `409` referenced |
| `GET /v1/environments?include_archived=…` | forward page | `400` invalid boolean |

Archive remains visible through direct retrieval and `include_archived=true`, but not the default list. Repeating archive returns the same archived row. Delete is not idempotent: a retry after success gets `404`, matching the normal resource lifecycle response.

### Console

Load archived environments, mark them clearly, and expose Archive/Delete only in live API mode. Archive prompts for confirmation and updates the row from the returned server response. Delete prompts for confirmation, removes a row only after the server returns success, and surfaces conflict errors verbatim (including referenced-session rejection). The create-session picker includes active environments only.

## Verification

- Store/service tests: archive idempotency, retrieve/list filtering, missing/cross-workspace isolation, safe unreferenced delete, and referenced-delete conflict.
- Session tests: archived environment rejects before runtime preparation; an
  archive during runtime preparation prevents the durable write and cleans up;
  existing sessions resolve their egress configuration after archive.
- API/OpenAPI tests: all operations, boolean parsing, route completeness.
- Console API/source tests: narrow write capabilities and no optimistic fake delete/archive.
- Browser/Docker alpha flow: create environment, archive it, verify Start no
  longer offers session creation, delete the unreferenced archived row, and
  run the existing agent/session lifecycle checks.
