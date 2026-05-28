# ADR 0013: File resources and session mounts

**Status:** Proposed, 2026-05-28

## Context

ADR 0004 makes Anthropic Managed Agents compatibility the north star. That means a session can be created with `resources[]`, and the canonical first tutorial path is:

1. create an agent,
2. create an environment,
3. upload a file,
4. create a session with that file mounted as a resource,
5. ask the agent to read the mounted path with `bash`,
6. delete the session.

OMA now has the control-plane shape, the event stream, Pi runtime integration, Docker-local sandboxing, fail-closed provider selection, deployment config wiring, and lifecycle cleanup. The missing product-parity step is file resources: uploaded input files that appear inside a session sandbox.

Live Anthropic probes in [Managed Agents resources scratchpad](../references/managed-agents-resources-notes.md) verified the important compatibility details:

- `files.upload` returns metadata with `id`, `type: "file"`, `filename`, `mime_type`, `size_bytes`, `created_at`, `downloadable`, and `scope`.
- Uploaded input files used as session resources can be `downloadable: false`; `files.download(file_id)` can return a 400 "not downloadable" error.
- `sessions.create(resources=[{ type: "file", file_id, mount_path? }])` succeeds.
- Mounted paths are canonicalized under `/mnt/session/uploads`.
- Relative paths, leading slash paths, omitted paths, path traversal, and duplicate/overlapping paths all have observable behavior.
- A live smoke with `claude-sonnet-4-6` mounted a file at `/mnt/session/uploads/probe.txt`, used `bash` to read it, and returned the exact bytes.

This ADR defines the first OMA file-resource slice. It intentionally does not define the full resource system.

Two compatibility constraints are load-bearing:

- ADR 0004 says `sessions.create` blocks until resources are mounted. File-resource mounting is part of session creation, not a lazy first-turn side effect.
- All file operations are workspace-scoped. A file uploaded in one workspace must never be retrievable, mountable, listed, or deleted through another workspace.

## Decision

### 1. Add a Files API MVP for uploaded input files

Implement the smallest top-level Files surface needed for the tutorial path:

- upload file bytes and return file metadata,
- retrieve file metadata,
- delete a file,
- list file metadata if it falls out naturally from the store,
- keep uploaded bytes internally for sandbox materialization.

For uploaded input files, public download is not part of the v1 contract. If a `files.download`-shaped route exists, uploaded input files return HTTP 400 with `invalid_request_error` and this caller-safe message shape:

```text
File '<file_id>' is not downloadable
```

This matches the live Anthropic probe and keeps "uploaded input" separate from future "agent output artifact".

`mime_type` is metadata only in v1. OMA records the supplied or inferred MIME type, but it does not dispatch behavior, permission, sandbox policy, or rejection based on MIME type. Executable MIME-type filtering is deferred until a real policy exists.

### 2. Define a small file-storage boundary now, with one backend

Add a narrow storage interface owned by OMA, for example:

```ts
interface FileStorage {
  create(workspaceId: WorkspaceId, input: UploadedFileInput): Promise<FileMetadata>;
  retrieveMetadata(workspaceId: WorkspaceId, fileId: string): Promise<FileMetadata | undefined>;
  openBytes(workspaceId: WorkspaceId, fileId: string): Promise<AsyncIterable<Uint8Array> | undefined>;
  delete(workspaceId: WorkspaceId, fileId: string): Promise<boolean>;
  list?(workspaceId: WorkspaceId, opts?: FileListOptions): Promise<FileMetadataPage>;
}
```

Every method takes `workspaceId`. No global file-id lookup is allowed. Session-create validation must use the session workspace when resolving `file_id`.

Use a streaming-shaped byte reader (`openBytes`) even though v1 files are small and in-memory. This avoids baking `Uint8Array`-only reads into call sites before filesystem/object-store backends exist.

The first backend is in-memory. Filesystem and object-store backends are deferred, but the boundary is worth defining now because file bytes are a trust, quota, and durability boundary, not just another SQLite row.

Provider selection for file storage follows the same discipline as sandbox selection:

- selected from trusted deployment/config code,
- fail closed on malformed config,
- no request body, prompt, model output, or untrusted agent definition can choose the backend.

Do not build S3/GCS/filesystem backends in this ADR's implementation slice.

### 3. Set an explicit file-size limit

File upload needs hard size limits in v1:

| Limit | Default |
|---|---:|
| Per uploaded file | 10 MiB |
| Per session file-resource count | 10 files |
| Per session aggregate mounted bytes | 50 MiB |
| Per workspace aggregate in-memory file bytes | 100 MiB |

These are conservative defaults for the in-memory backend. A later implementation may adjust them with upstream evidence or deployment config, but v1 must not be unlimited.

Limits must be enforced before storing bytes and before attempting Docker materialization. Exceeding a v1 file/resource quota returns HTTP 400 with `invalid_request_error` and a caller-safe message naming the violated limit. Do not leave the error type to implementation choice.

### 4. Name idempotency as unsupported in v1

`Idempotency-Key` is not supported for file uploads in v1.

Duplicate uploads create distinct `file_*` IDs, even if the bytes are identical. Content-hash deduplication and HTTP idempotency are deferred until the first implementation shows where retry-safety matters most.

This is an explicit contract decision, not an accidental omission.

Tests must assert that two identical uploads return distinct file IDs.

### 5. Add create-time session file resources only

Session create accepts only this resource shape in v1:

```json
{
  "type": "file",
  "file_id": "file_...",
  "mount_path": "optional/path.txt"
}
```

Rules:

- `file_id` must reference an existing uploaded file.
- unsupported resource types are rejected with specific caller-safe errors,
- unsupported resource fields are rejected rather than ignored,
- resources are persisted and echoed on session objects,
- session resource CRUD is not implemented in v1.

Each persisted session resource has this wire shape:

```json
{
  "id": "sesrsc_...",
  "type": "file",
  "file_id": "file_...",
  "mount_path": "/mnt/session/uploads/probe.txt",
  "created_at": "2026-05-28T00:00:00.000Z",
  "updated_at": "2026-05-28T00:00:00.000Z"
}
```

OMA v1 preserves the original uploaded `file_id` in `session.resources[]`. Tests must assert that `session.resources[0].file_id === uploadedFile.id`.

Anthropic appears to clone/materialize the uploaded file into a session-scoped file id. OMA deliberately does not do that in v1. The divergence is acceptable because it avoids a second file identity model before output artifacts and session-resource CRUD exist.

OMA still creates an internal session-scoped mount snapshot at session creation time. That snapshot is not exposed as a Files API resource and does not change the public `file_id`. Its job is to make the session mount independent from later deletion of the original uploaded file.

Unsupported resource types use this message shape:

```text
Unsupported session resource type: <type>.
```

### 6. Match Anthropic mount-path normalization

All file resource mounts are canonicalized under:

```text
/mnt/session/uploads
```

Normalization rules:

| Input `mount_path` | Canonical path |
|---|---|
| `"probe.txt"` | `/mnt/session/uploads/probe.txt` |
| `"data/probe.txt"` | `/mnt/session/uploads/data/probe.txt` |
| `"/tmp/probe.txt"` | `/mnt/session/uploads/tmp/probe.txt` |
| omitted | `/mnt/session/uploads/<uploaded_file_id>` |

Validation rules:

- Strip leading `/` characters before normalization. Absolute-looking inputs are upload-root-relative, not container-root-relative.
- Split the remaining string on `/`.
- Reject empty segment lists.
- Reject empty segments, `.` segments, and `..` segments lexically before any path normalization. For example, reject `data//probe.txt`, `data/./probe.txt`, and `data/../probe.txt`.
- Reject NUL bytes and backslashes.
- Restrict each segment to this v1 portable filename regex: `[A-Za-z0-9._-]+`. This can be widened later with live upstream evidence.
- Reject duplicate canonical paths.
- Reject overlapping canonical paths. Two paths overlap if they are equal or if one path's segment list is a prefix of the other's segment list. For example, `data` overlaps `data/probe.txt`; `data` does not overlap `data2/probe.txt`.

Exact error messages do not need to copy Anthropic text, but they should be caller-safe and specific. The live upstream messages were:

- `Invalid file resource: mount path "../probe.txt" escapes /uploads/`
- `Invalid file resource: mount_path overlaps another resource: /uploads/dupe.txt`

Tests must pin each rule directly.

### 7. Keep file lifecycle independent from session lifecycle

Uploaded files are independent resources.

Archiving or deleting a session does not delete files referenced by that session. Files are deleted only through the Files API. No reference counting is implemented in v1.

Deleting an uploaded file after a session has been created does not affect that session's already-created file mount. `sessions.create` already copied bytes into an internal session-scoped mount snapshot before returning. The session row retains the original `file_id` for compatibility/debuggability even if the original uploaded file is later deleted.

Deleting an uploaded file before a session is created means that `file_id` can no longer be resolved, and `sessions.create` fails with HTTP 400 `invalid_request_error`.

This matches the broader Managed Agents model where memory stores, uploaded files, and output artifacts have lifecycles separate from a single session.

Session-scoped mount snapshots are runtime support artifacts, not top-level files. They can be deleted when the session is hard-deleted. Archiving a session terminates runtime access; it does not make the mounted bytes downloadable through the Files API.

### 8. Materialize resources during session creation

The first sandbox materialization target is Docker-local.

Resource materialization is part of `sessions.create`. If a session has file resources, session creation must:

1. validate all resource records,
2. resolve uploaded files in the same workspace,
3. enforce per-session count and byte limits,
4. create internal session-scoped mount snapshots,
5. provision the Docker-local sandbox,
6. copy the mounted files into `/mnt/session/uploads`,
7. return the created session only after all mounts are present.

If any step fails, `sessions.create` fails with a caller-safe error and does not leave a visible partially-created session. Any already-started sandbox must be cleaned up best-effort; Docker-local orphan reaping remains the durability backstop if cleanup itself fails.

Lazy first-turn materialization is not allowed for file resources because ADR 0004 marks "session-create-blocks-until-resources-mount" as a Tier 1 compatibility rule. A client may open the event stream immediately after `sessions.create` and expect mounted resources to be ready before sending the first `user.message`.

The container keeps the existing isolation posture:

- read-only root filesystem,
- `/workspace` as a tmpfs for the runtime working directory,
- sandbox process user `65534:65534`.

Add a second tmpfs for session uploads:

```text
--tmpfs /mnt/session/uploads:rw,nosuid,nodev,noexec,mode=755,size=<configured>
```

Why `rw`: Docker must be able to materialize bytes into the tmpfs before the first runtime turn.

Why not `ro`: a read-only tmpfs would block `docker cp` or equivalent materialization.

Why this still gives read-only semantics to the agent: the upload directory and files are root-owned, files are copied as mode `0644`, and the sandbox process runs as `65534:65534`. The agent can read the bytes but cannot mutate them by ordinary file writes. `noexec` prevents direct execution of uploaded files through `./file`, though interpreters can still read scripts as input.

Materialization happens after container creation and before `sessions.create` returns. Use `docker cp` or an equivalent provider-internal root materialization step that writes as root. Do not use the sandbox user's normal `write` operation path for upload materialization; that would contradict the root-owned read-only-by-ownership model.

Materialization creates regular files and root-owned directories only. It does not materialize symlinks from uploaded input.

Do not bind-mount host resource directories into the sandbox.

Bind mounts are explicitly rejected for v1 because they reintroduce host filesystem exposure and weaken the Docker-local isolation work from ADR 0003 and the Docker-local hardening cycle.

Other sandbox providers can implement equivalent materialization later through the provider boundary. Host-passthrough support is not required for the first file-resource implementation; it may reject file resources until it has a deliberately designed mapping.

### 9. Explicit exclusions

This ADR does not implement:

- memory-store resources,
- GitHub repository resources,
- vault resources,
- session-resource CRUD,
- output artifacts under `/mnt/session/outputs`,
- public download for uploaded input files,
- file upload idempotency,
- content-hash deduplication,
- filesystem or object-store storage backends,
- remote sandbox provider materialization,
- permission confirmations for file access.

Unsupported resource types and fields must fail closed with caller-safe errors.

## Acceptance tests and probes

The implementation plan should start from tests/probes, not bolt them on at the end.

Required tests:

- Files API upload/retrieve/delete behavior.
- Files API calls are workspace-scoped; a file from workspace A cannot be retrieved, listed, deleted, downloaded, or mounted from workspace B.
- File size limit rejection.
- Per-session file count, per-session aggregate byte, and per-workspace aggregate byte quota rejection.
- Uploaded input file public download returns HTTP 400 `invalid_request_error` with `File '<file_id>' is not downloadable` if the route exists.
- `mime_type` is recorded but does not affect upload acceptance or sandbox policy.
- Two identical uploads return distinct file IDs.
- Session create validates `resources[]`.
- Unknown resource types and fields are rejected.
- Missing `file_id` and nonexistent `file_id` are rejected.
- Unsupported `memory_store`, `github_repository`, and `vault` resources return specific "not supported" errors.
- Mount path normalization covers relative, leading slash, omitted, empty, `.`, `..`, nested `..`, duplicate, overlapping, NUL, backslash, and non-portable segment paths.
- Overlap tests include positive cases (`data` + `data/probe.txt`, duplicate `data/probe.txt` mounts) and a negative case (`data` + `data2/probe.txt`).
- Session objects echo canonical file resources with `id`, `type`, `file_id`, `mount_path`, `created_at`, and `updated_at`.
- Session resource `file_id` remains the original uploaded file id.
- Deleting an uploaded file after session creation does not mutate existing session rows and does not break that session's already-created mount.
- Deleting an uploaded file before session creation makes later resource validation fail.
- `sessions.create` with file resources blocks until Docker-local materialization is complete.
- If materialization fails, no partially-created session is visible and any started sandbox is disposed best-effort.

Required live acceptance probe:

1. create a deployment app with Docker-local enabled,
2. upload a tiny text file,
3. create a session with:

   ```json
   {
     "type": "file",
     "file_id": "file_...",
     "mount_path": "probe.txt"
   }
   ```

4. send a pinned user message that asks for `cat /mnt/session/uploads/probe.txt` and nothing else,
5. assert the event stream contains a `bash` tool use for that path,
6. assert the exact bytes are returned in `agent.tool_result`; final assistant text can be checked too, but must not be the only assertion,
7. assert `sessions.create` had already returned only after the file was materialized,
8. delete the original uploaded file and assert the active session can still read the mounted bytes,
9. clean up the session and assert no labelled Docker container remains.

The probe should be committed as a durable scratch script, not only as an ad-hoc shell heredoc.

If the first Files API PR commits the probe before Docker materialization exists, it may be skipped temporarily only if the PR links the follow-up issue/PR that will unskip it. The skip is not allowed to become an open-ended TODO.

The probe should use the cheapest model that reliably exercises `bash`. It should assert tool events and tool output directly to minimize dependence on final natural-language phrasing.

## Consequences

- OMA gains the first visible product-parity feature after Docker-local: file upload plus sandbox-visible session mounts.
- Resource design stays narrow: file-only, create-time mounts, no general resource framework.
- The storage and sandbox materialization boundaries are explicit, so future filesystem/S3 backends and Modal-style providers do not require rewriting the HTTP contract.
- Input uploaded files and output artifacts remain separate concepts.
- We deliberately accept one upstream divergence in v1: session resources preserve the original uploaded `file_id` instead of exposing a cloned session-scoped file id.
- OMA still copies bytes into an internal session-scoped mount snapshot before `sessions.create` returns, so that divergence does not create a delete-after-create race.
- Sessions with file resources are no longer purely lazy at first user message; Docker-local provisioning can happen during `sessions.create` for those sessions.

## Follow-ups

- Implement `user.interrupt` and align archive-running-session semantics with upstream ([#37](https://github.com/oneryalcin/open-managed-agents/issues/37)).
- Extend `requires_action` semantics to builtin permission confirmations ([#38](https://github.com/oneryalcin/open-managed-agents/issues/38)).
- Add `agents.archive` parity endpoint ([#39](https://github.com/oneryalcin/open-managed-agents/issues/39)).
- Add output artifact support under `/mnt/session/outputs`.
- Add memory-store resources.
- Add file upload idempotency and/or content-hash deduplication.
- Add filesystem and object-store file storage backends.
