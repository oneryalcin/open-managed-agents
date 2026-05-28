# Plan: Session file-resource control plane

Status: Draft, 2026-05-28

Tracking issue: [#43](https://github.com/oneryalcin/open-managed-agents/issues/43)

This is PR-A for #43. It deliberately stops before Docker-local
materialization. The goal is to freeze the public/control-plane contract:
`sessions.create(resources=[...])` accepts file resources, canonicalizes mount
paths, snapshots bytes internally, persists/echoes session resources, and keeps
top-level Files API scope behavior unchanged.

## Requirements Summary

Current state:

- `DefaultSessionService.create` rejects `resources` in
  `src/control-plane/sessions/service.ts` via `rejectUnsupportedField(obj, "resources")`.
- `SessionRow` and `ManagedAgentsSession` have no `resources` field in
  `src/control-plane/sessions/types.ts` and `src/types/sessions.ts`.
- `SqliteSessionStore` persists a single `sessions` row per session and
  currently has no resource/snapshot storage in `src/control-plane/sessions/store.ts`.
- The Files API from PR #44 provides workspace-scoped file metadata and
  internal bytes through `FileStorage.retrieveMetadata` and
  `FileStorage.openBytes` in `src/control-plane/files/types.ts`.

Upstream/probe-grounded contract:

- `sessions.create(... resources=[file mount])` echoes `resources[]` inline in
  the returned session. This is visible in
  `scratch/25-managed-agents-resource-probe-output.txt` under
  `sessions.create.relative_mount`; the subsequent `sessions.resources.list`
  emission is separate corroboration.
- The SDK resource type is
  `BetaManagedAgentsFileResource`: `id`, `created_at`, `file_id`,
  `mount_path`, `type`, `updated_at`.
- ADR 0013 requires OMA v1 to preserve the original uploaded `file_id` in
  `session.resources[]`, even though Anthropic appears to clone/materialize a
  session-scoped file id.
- ADR 0013 requires internal session-scoped mount snapshots so deleting the
  original uploaded file after session creation does not break future
  materialization.
- The SDK session type treats `resources` as non-optional, so resource-free
  sessions should return `resources: []`, not omit the field.

## Non-Goals

- No Docker-local tmpfs or `docker cp` materialization in PR-A.
- No host-passthrough behavior changes in PR-A.
- No `sessions.resources.*` list/retrieve/update/delete routes.
- No top-level Files API `scope` implementation. Uploaded input files stay
  `scope: null`, and `GET /v1/files?scope_id=...` continues to return an empty
  page for uploaded inputs.
- No session-scoped cloned `file_*` public identity in OMA v1.
- No memory-store, GitHub repository, vault, or output-artifact resources.

## Design

### Public Session Resource Types

Add a session file resource type in `src/types/sessions.ts`:

```ts
interface ManagedAgentsSessionFileResource {
  id: string;              // sesrsc_...
  type: "file";
  file_id: string;         // original uploaded file id in OMA v1
  mount_path: string;      // canonical /mnt/session/uploads/...
  created_at: string;
  updated_at: string;
}
```

Then add `resources: ManagedAgentsSessionFileResource[]` to
`ManagedAgentsSession`. This field is always present. Resource-free sessions
return `resources: []`.

Add `newSessionResourceId()` in `src/control-plane/ids.ts` using the
`sesrsc_` prefix.

### Request Parsing

Extend `CreateManagedSessionRequest` with optional `resources`.
`parseCreateSession` should stop rejecting `resources` and instead:

- Accept `resources` only when it is an array.
- Accept only objects shaped as:

  ```json
  { "type": "file", "file_id": "file_...", "mount_path": "optional/path.txt" }
  ```

- Reject unknown resource fields rather than ignoring them.
- Reject missing or non-string `file_id`.
- Reject unsupported resource types with:

  ```text
  Unsupported session resource type: <type>.
  ```

- Keep rejecting `vault_ids` and sandbox/provider fields.
- Allow the same `file_id` to be mounted more than once when each mount uses a
  distinct canonical `mount_path`.
- Preserve input order in the echoed `resources[]` array.

### File Resolution And Quotas

`DefaultSessionService` should receive the shared `FileStorage` instance so it
can validate file resources in the session workspace.

For each file resource:

1. Resolve metadata with `FileStorage.retrieveMetadata(workspaceId, file_id)`.
2. Open bytes with `FileStorage.openBytes(workspaceId, file_id)`.
3. Fail with HTTP 400 `invalid_request_error` when the file is missing.
4. Enforce ADR 0013 session quotas before persisting the session:
   - max 10 file resources,
   - max 50 MiB aggregate mounted bytes.
5. Drain and validate all resource bytes before opening any SQLite transaction.
   Do not `await` while a transaction is open on the shared `DatabaseSync`
   handle.
6. Recompute SHA-256 while draining bytes and assert it matches the source
   `FileStorageRecord.sha256`.

This is a trust-boundary check. Do not allow request bodies, agent definitions,
or model output to choose another storage backend or workspace.

### Mount Path Normalization

Add a focused normalizer, preferably in
`src/control-plane/sessions/resources.ts`, with no filesystem calls. This is a
public API lexical contract, not provider path behavior.

Rules from ADR 0013:

- Root is `/mnt/session/uploads`.
- Omitted `mount_path` becomes `/mnt/session/uploads/<original_file_id>`.
- Strip leading `/` characters before validation.
- Split on `/`.
- Reject empty segment lists.
- Reject empty segments, `.`, and `..` lexically before any normalization.
- Reject NUL bytes and backslashes.
- Restrict each segment to `[A-Za-z0-9._-]+`.
- Restrict each segment to at most 255 characters and the final canonical
  `mount_path` to at most 1024 characters.
- Reject duplicate canonical paths.
- Reject overlaps where one segment list is a prefix of another.

The segment character set and length limits are intentional OMA v1
conservatism. They may reject mount paths that Anthropic accepts; keep that
divergence explicit in tests and error messages rather than accidentally
weakening the lexical boundary.

Live fixtures to pin:

- `"probe.txt"` -> `/mnt/session/uploads/probe.txt`
- `"data/probe.txt"` -> `/mnt/session/uploads/data/probe.txt`
- `"/tmp/probe.txt"` -> `/mnt/session/uploads/tmp/probe.txt`
- omitted -> `/mnt/session/uploads/<original_file_id>`

### Snapshot Boundary

PR-A creates internal session-scoped mount snapshots but does not materialize
them into Docker.

The snapshot must contain enough for PR-B to materialize without consulting the
top-level uploaded file again:

```ts
interface SessionFileMountSnapshot {
  workspace_id: WorkspaceId;
  session_id: string;
  resource_id: string;
  file_id: string;          // original uploaded file id
  mount_path: string;       // canonical path
  snapshot_file_id: string; // internal-only storage id, never public
  sha256: string;           // recomputed and verified at create time
  size_bytes: number;
}
```

Keep this as an internal runtime artifact:

- It is not exposed by the Files API.
- It does not change `ManagedAgentsFileMetadata.scope`.
- It does not make uploaded inputs downloadable.
- It can be removed when a session is hard-deleted.
- A client calling `files.retrieve_metadata(resource.file_id)` sees the
  original uploaded file, not a session clone. That is an intentional OMA v1
  divergence from Anthropic's observed session-scoped clone behavior.

Implementation choice for PR-A:

- Persist public session resources in a dedicated `session_resources` table,
  not as JSON on the session row. Use columns for `workspace_id`, `session_id`,
  `id`, `type`, `file_id`, `mount_path`, `created_at`, and `updated_at`.
- Persist internal snapshot bytes through the file-storage byte boundary under
  an internal, unlistable session-mount scope. Do not store snapshot bytes as
  SQLite BLOBs. PR-B needs a streamable byte source, and workspace quota
  accounting must include public uploads plus internal session snapshots.
- Extend the storage boundary with an internal snapshot write/open/delete path
  rather than routing through the public `FileService` upload/list/download
  API. Internal snapshot records must not appear in `GET /v1/files`,
  `GET /v1/files?scope_id=...`, public errors, or logs.
- Persist internal snapshot metadata in a dedicated
  `session_file_mount_snapshots` table keyed by
  `(workspace_id, session_id, resource_id)`, with `file_id`, `mount_path`,
  `snapshot_file_id`, `sha256`, and `size_bytes`.
- Before opening the session-store transaction, resolve source files, drain
  bytes, enforce quotas, verify SHA-256, and create the internal snapshot byte
  records. Then open a fully synchronous session-store transaction and insert
  the session row, public resource rows, and snapshot metadata rows with no
  `await` inside `BEGIN` -> inserts -> `COMMIT`/`ROLLBACK`.
- If the synchronous session-store transaction fails after internal snapshot
  byte records were created, delete those internal snapshots best-effort and
  return the session-create error. Add a failure-path test that proves no
  session is visible and no quota-accounting orphan remains after an injected
  transaction failure.
- Hydrate `create`, `retrieve`, and `list` session objects from
  `session_resources`. `archive` should preserve public resource rows.
  Hard-delete should remove public resource rows, snapshot metadata rows, and
  internal snapshot byte records with the session.
- Expose a small store/helper method for PR-B to retrieve snapshots by
  `(workspaceId, sessionId)`. Do not expose snapshots through public Files API
  routes or `sessions.resources.*` routes in PR-A.

### Service Wiring

`createInMemoryControlPlaneApp` currently creates one `InMemoryFileStorage`.
PR-A should pass that same instance to `DefaultSessionService`, not create a
second file store. This preserves the workspace/file resolution boundary from
PR #44.

Keep the low-level `createControlPlaneApp` path ergonomic for existing tests by
providing explicit service dependencies at the app factory layer, not by making
global singleton storage.

## Acceptance Criteria

Contract tests:

- `sessions.create` with one file resource succeeds and returns a session whose
  `resources` array is echoed inline.
- `sessions.create` without resources returns `resources: []`; retrieve, list,
  and archive do the same for resource-free sessions.
- Echoed resource has `id` matching `^sesrsc_`, `type: "file"`, original
  uploaded `file_id`, canonical `mount_path`, `created_at`, and `updated_at`.
- For newly created resource rows, `created_at === updated_at`.
- `sessions.retrieve` and `sessions.list` include the same resource echo.
- `sessions.archive` preserves the public resource echo for readable archived
  sessions.
- Multiple resource inputs preserve input order in the echoed `resources[]`.
- The same uploaded `file_id` can be mounted at two distinct canonical
  `mount_path` values, producing two distinct `sesrsc_*` rows and two internal
  snapshots.
- Omitted mount path canonicalizes to
  `/mnt/session/uploads/<original_file_id>`.
- Relative, nested-relative, and leading-slash mount paths canonicalize to the
  live-probe fixtures above.
- Unknown resource fields are rejected.
- `resources: null`, non-array `resources`, and non-object resource entries are
  rejected with `invalid_request_error`.
- Missing `file_id` and nonexistent `file_id` are rejected with
  `invalid_request_error`.
- Unsupported `memory_store`, `github_repository`, and `vault` resources return
  `Unsupported session resource type: <type>.`
- Path validation rejects empty paths, `.` segments, `..` segments, nested
  `..`, duplicate paths, overlapping paths, NUL bytes, backslashes, and
  non-portable segments.
- Path validation rejects segments longer than 255 characters and canonical
  mount paths longer than 1024 characters.
- Overlap tests include:
  - `data` + `data/probe.txt` rejected,
  - duplicate `data/probe.txt` rejected,
  - `data` + `data2/probe.txt` accepted.
- More than 10 file resources is rejected.
- More than 50 MiB aggregate mounted bytes is rejected. Use injected small test
  limits or small fake records where possible; do not allocate 50 MiB just to
  prove arithmetic.
- Internal snapshot bytes count against the workspace storage meter; hard-delete
  of a session releases those internal bytes.
- A file uploaded in workspace A cannot be mounted by a session in workspace B.
- `GET /v1/files?scope_id=<session_id>` remains empty after session creation.
- Public files list/retrieve/download responses never expose internal snapshot
  ids or storage keys.
- Deleting the original uploaded file after `sessions.create` does not mutate
  the session resource echo and does not remove the internal snapshot.
- Deleting the original uploaded file before `sessions.create` makes validation
  fail.
- Injected session-store failure after snapshot byte creation leaves no visible
  session and no snapshot quota orphan.

Non-acceptance in PR-A:

- Do not assert that Docker can read `/mnt/session/uploads/...`; that belongs to
  PR-B and probe 27.

## Verification Steps

- Focused unit tests for mount-path normalization.
- Focused service/store tests for session resource persistence and snapshots.
- HTTP-level test for `POST /v1/sessions` resource parse/echo/retrieve/list.
- `npm run typecheck`.
- `npm test`.
- `git diff --check`.

## Risks And Mitigations

- Risk: Treating snapshots as top-level files accidentally populates `scope` or
  creates a second public file identity.
  Mitigation: Use internal-only file-storage snapshot APIs, not the public
  Files API; add a test that `GET /v1/files?scope_id=<session_id>` remains
  empty after session creation.

- Risk: Session row is visible without resources/snapshots if persistence is
  split across partial writes.
  Mitigation: drain and validate bytes before `BEGIN`, create internal snapshot
  byte records before `BEGIN`, then use one synchronous transaction for session
  row/resource/snapshot metadata inserts; tests should force both snapshot
  failure and session-store transaction failure and assert no session is visible
  and no quota orphan remains.

- Risk: Normalization drifts toward provider/filesystem behavior.
  Mitigation: keep the normalizer lexical and table-driven; do not use
  `path.normalize` or provider-specific path rules for public validation.

- Risk: PR-A accidentally pulls in Docker materialization.
  Mitigation: keep provider changes out; PR-B owns Docker tmpfs, root
  materialization, host-passthrough rejection, and probe 27.

## PR-B Handoff

PR-B consumes the internal snapshots created here. It must:

- provision `/mnt/session/uploads` as
  `--tmpfs /mnt/session/uploads:rw,nosuid,nodev,noexec,mode=755,size=<configured>`,
- materialize snapshots with provider-owned root copy, not sandbox-user writes,
- block `sessions.create` until mounted,
- fail closed and clean up on partial materialization failure,
- make host-passthrough reject file resources until a deliberate mapping exists,
- unskip and complete `scratch/27-file-resource-docker-materialization.ts`.
