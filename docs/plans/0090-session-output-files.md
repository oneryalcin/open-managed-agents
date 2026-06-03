# 0090 - Session Output Files

## Context

Hosted Claude Managed Agents treats files written by the agent under
`/mnt/session/outputs/` as session-scoped files. Clients list them with the
Files API and download them by file id:

- `GET /v1/files?scope_id=<session_id>`
- `GET /v1/files/<file_id>/content`

This is documented in `/tmp/claude-docs/docs/managed-agents/files.md` under
"Listing and downloading session files". The same pattern appears in
`/tmp/claude-docs/docs/managed-agents/define-outcomes.md`.

The hosted probe in `scratch/39-hosted-session-output-files-probe.py`
confirmed the details this slice depends on. Artifact:
`scratch/artifacts/39-hosted-session-output-files-probe.json`.

Observed hosted behavior on June 3, 2026:

- `client.beta.files.list(scope_id=session.id)` returns the mounted input copy
  before any user turn, with `downloadable: false` and
  `scope: { type: "session", id: session.id }`.
- Files written under `/mnt/session/outputs/` are listed after terminal idle
  with `downloadable: true` and the same session scope object.
- Hosted flattens nested output paths into basename-style filenames:
  `/mnt/session/outputs/nested/child.txt` listed as `child.txt`, not
  `nested/child.txt`.
- `client.beta.files.download(id)` returns the generated output bytes for
  downloadable output files.

The CWC `eval-driven-agent-development` workshop depends on this contract:

- the agent writes `/mnt/session/outputs/output.pptx`
- the client retries `client.beta.files.list({ scope_id: session.id })`
- the client downloads the resulting file with `client.beta.files.download(id)`

OMA already supports uploaded input files and Docker-local materialization, but
it intentionally keeps uploaded input files non-downloadable and keeps internal
mount snapshots out of the public Files API. That boundary must remain intact.

Current OMA constraints that this slice must handle:

- Docker-local containers run `--read-only` and currently mount writable tmpfs
  only at `/workspace` and `/mnt/session/uploads`; there is no writable
  `/mnt/session/outputs` path yet.
- The Docker container runs as uid/gid `65534:65534`, so the output mount must
  be writable by that user.
- Docker tmpfs memory validation currently assumes workspace + uploads tmpfs
  only. Adding an outputs tmpfs must update that invariant.
- `RuntimeEventRunner` has no output-collection method today. The live sandbox
  is held inside the Pi runner handle, so the runner must own the bridge between
  terminal-idle detection and sandbox output collection.
- Public file metadata currently types `scope` as `string | null`. Hosted uses
  `scope: { type: "session", id }` for session-scoped rows, so this slice must
  update the public shape deliberately instead of creating an accidental API
  break.

Relevant existing docs:

- `docs/adrs/0003-pluggable-sandbox-provider-boundary.md` names
  `listOutputs()` and `downloadOutput(path)` as the sandbox boundary for
  `/mnt/session/outputs/`.
- `docs/adrs/0013-file-resources-and-session-mounts.md` explicitly leaves
  output artifacts as a follow-up and keeps input uploaded files distinct from
  output artifacts.
- `docs/references/managed-agents-resources-notes.md` records the hosted probe:
  uploaded input files were `downloadable: false`, while output files are
  retrieved through session-scoped Files API listing/download.

## Goal

Add CMA-compatible generated session output files for Docker-local sessions.

After a session writes files under `/mnt/session/outputs/`, OMA should expose
those generated files through the public Files API:

- `GET /v1/files?scope_id=<session_id>` returns session output files.
- `GET /v1/files/<file_id>/content` downloads the output bytes.
- Output file metadata has `downloadable: true` and
  `scope: { type: "session", id: <session_id> }`.

This unlocks artifact-producing examples such as the CWC PPTX eval workshop
without weakening the uploaded-input-file boundary.

## Non-Goals

- Do not make uploaded input files downloadable.
- Do not expose internal session mount snapshots in `GET /v1/files` or
  `GET /v1/files?scope_id=...`.
- Do not expose hosted-style mounted input-copy rows yet, even though hosted
  lists those rows as `downloadable: false`.
- Do not implement full hosted file-copy semantics for mounted inputs.
- Do not add a durable object-store backend in this slice.
- Do not implement skills, `agents.update`, memory stores, outcomes, MCP,
  multiagent threads, or hosted cloud environment parity.
- Do not add host-passthrough output support unless it has a deliberately
  designed safe mapping. Docker-local is the first implementation target.

## Contract

Output files are public Files API records with a session scope:

```ts
{
  id: "file_...",
  type: "file",
  filename: "output.pptx",
  mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  size_bytes: 12345,
  created_at: "...",
  downloadable: true,
  scope: { type: "session", id: "sesn_..." }
}
```

`GET /v1/files?scope_id=<session_id>` should return only public output file
records for that session. It must not return:

- workspace-level uploaded input files (`scope: null`);
- hosted-style session-scoped mounted input copies in v1;
- internal session mount snapshots;
- output files from another workspace or session.

Hosted does return session-scoped mounted input copies, but they are
`downloadable: false`. OMA v1 should explicitly diverge and keep those hidden
until input-copy semantics are designed. The output-file path should not expose
the existing internal snapshot rows as a shortcut.

Public scope shape decision:

- Public output file rows should use the hosted object shape:
  `scope: { type: "session", id: sessionId }`.
- Storage can keep a simple internal `scope_id` string for lookup and
  isolation. Do not force internal snapshot records to become public scoped
  file records.
- Update `ManagedAgentsFileMetadata` and tests for scoped public files.
  Uploaded input files remain `scope: null`.

`GET /v1/files/<file_id>/content`:

- returns bytes for output files where `downloadable === true`;
- keeps returning the existing 400 invalid request for non-downloadable uploads;
- returns caller-safe not found for missing or cross-workspace file IDs.

## Design

### 1. Provision the Docker-local output root

Docker-local must create a writable output root before any collection can work.
Today the root filesystem is read-only, so asking the agent to create
`/mnt/session/outputs` would fail.

Add a third tmpfs mount to Docker sandbox startup:

- path: `/mnt/session/outputs`;
- ownership/mode: writable by uid/gid `65534:65534`;
- security: `rw,nosuid,nodev,noexec`;
- size: explicit output tmpfs size, reviewed with the quota limits below.

Update Docker memory-headroom validation so it accounts for workspace + uploads
+ outputs tmpfs. Add command-construction tests that assert the outputs mount,
ownership, mode, and updated headroom error message.

### 2. Extend the sandbox provider boundary

Add a provider-owned output collection boundary beside `materializeFileResources`:

```ts
interface SandboxOutputFile {
  relativePath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  bytes: AsyncIterable<Uint8Array> | Uint8Array;
  sha256?: string;
}

interface SandboxProvider {
  collectOutputFiles?(): Promise<readonly SandboxOutputFile[]>;
}
```

The provider owns path traversal and container filesystem details.

For Docker-local:

- output root is `/mnt/session/outputs`;
- enumerate regular files recursively under that root;
- reject or skip directories, symlinks, device files, sockets, and paths that
  escape the output root;
- expose output `filename` as the basename, matching the hosted probe;
- keep `relativePath` internally for identity, dedupe, and collision detection;
- stream/copy bytes out through Docker, validating the discovered size.

The control plane must not directly shell into Docker from `FileService`.

Basename collision policy:

- The hosted probe only covered distinct basenames, so collision behavior is
  still unknown.
- OMA v1 should fail output indexing for colliding basenames within one
  collection pass, log the collision with both relative paths, and keep the
  previously indexed output set unchanged.
- Do not silently overwrite `model_a/report.json` with `model_b/report.json`.

### 3. Add a runner-owned output collection bridge

The event service detects terminal idle, but the Pi runner owns the live sandbox
handle. Add an optional method to `RuntimeEventRunner`:

```ts
interface RuntimeEventRunner {
  collectSessionOutputs?(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<RuntimeSessionOutputCollection>;
}
```

`RuntimeSessionOutputCollection` should distinguish these cases:

- live sandbox inspected and outputs collected;
- live sandbox inspected and output directory is empty;
- no live sandbox / unsupported provider.

The event service must collect only on terminal idle produced by the active live
runtime owner. It must not collect, and must not replace existing outputs, from
sandboxless terminalization paths such as abandoned-turn recovery, custom-tool
wait terminalization, tool-confirmation wait terminalization, archive cleanup,
or delete cleanup.

This gate is load-bearing. A sandboxless recovery path that emits
`session.status_idle` must never replace a previously indexed output set with
an empty collection.

### 4. Persist output files as public scoped records

Extend `FileStorage` with output-file methods distinct from upload and internal
snapshots:

```ts
replaceSessionOutputs(
  workspaceId: WorkspaceId,
  sessionId: string,
  files: readonly {
    relativePath: string;
    sessionId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256?: string;
    body: Uint8Array | AsyncIterable<Uint8Array>;
  }[],
): Promise<readonly FileRecord[]>;

deleteSessionOutputs(
  workspaceId: WorkspaceId,
  sessionId: string,
): Promise<void>;
```

Records created this way have:

- `scope_id = sessionId` internally;
- `scope = { type: "session", id: sessionId }` at the public API boundary;
- `downloadable = true`;
- normal public `file_*` IDs;
- a public-output visibility/kind distinct from uploads and internal snapshots;
- bytes readable by `download`.

Keep uploaded inputs as:

- `scope = null`;
- `downloadable = false`.

Keep internal snapshots on their existing internal-only APIs.

Implement `files.list({ scopeId })` by selecting public output files scoped to
that session, preserving workspace isolation and pagination. Do not include
internal snapshots or workspace-level uploads.

`replaceSessionOutputs` must be atomic with respect to metadata, bytes, and
quota accounting. A failed replacement must leave either the old complete output
set or the new complete output set, never a half-deleted set.

### 5. Define output quotas

Agent-produced output bytes are untrusted data. Add explicit limits before
collecting bytes into in-memory storage:

- maximum files per collection;
- maximum single output file bytes;
- maximum aggregate session output bytes;
- maximum basename length after flattening;
- reject unsafe names and non-regular files.

Recommended v1 defaults:

- max files: 100;
- max single output file: 25 MiB;
- max aggregate session outputs: 100 MiB.

If a limit is exceeded, do not partially index outputs. Log a structured warning
with workspace/session/limit context and leave the previous indexed output set
untouched. The session turn remains successful, but artifacts are absent or
stale and the failure is observable.

### 6. Index outputs at terminal idle

Collect and persist outputs when a runtime turn reaches terminal idle after the
agent has had a chance to write artifacts.

The first implementation can index on non-`requires_action`
`session.status_idle` and before disposing the runtime handle. This gives OMA
immediate indexing, while hosted clients already tolerate a short indexing lag.

Important boundaries:

- Do not index on `requires_action`; the session may resume and write more.
- Do not index after the sandbox is disposed.
- Do not index from sandboxless terminalization paths.
- Do not replace indexed outputs when no live sandbox is available.
- Do not let output-indexing failure erase the already-persisted session result.
  Prefer a logged warning plus no files over returning a false failure after the
  turn completed, unless review decides artifact persistence is part of turn
  success.
- Make indexing idempotent per `(workspace_id, session_id, relative_path,
  content hash)` or replace prior generated outputs only after successful live
  sandbox collection.

The idempotency choice should be explicit before implementation. Conservative
v1 recommendation: replace the indexed output set for a session only when a live
owner-matched sandbox collection succeeds. Never replace with an empty result
from a path that did not inspect a live sandbox. This avoids duplicate records on
normal replay/recovery while preventing sandboxless recovery from deleting good
artifact metadata.

### 7. Route download bytes

Change `FileService.download` from unconditional rejection to:

- retrieve metadata;
- if `downloadable !== true`, preserve the existing invalid-request error;
- if downloadable, return the bytes from storage.

Change `GET /v1/files/:id/content` to return a binary response with the stored
`mime_type` where available.

Implement a return type for downloads, for example:

```ts
interface FileDownload {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  body: AsyncIterable<Uint8Array>;
}
```

The route should construct a binary `Response`, set `content-type`, and avoid
buffering unnecessarily when storage can stream.

MIME detection:

- Preserve explicit MIME type from the provider when available.
- For Docker-local v1, infer from filename extension with a small allowlist for
  common artifacts: `.txt`, `.json`, `.csv`, `.html`, `.md`, `.pptx`, `.png`,
  `.jpg`, `.jpeg`, `.pdf`.
- Fall back to `application/octet-stream`.
- Add a `.pptx` test because the eval workshop depends on it.

### 8. Keep session deletes honest

Deleting a session should eventually remove its scoped output files or make the
cleanup behavior explicit.

For this slice, prefer deleting session-scoped public output records as part of
session hard-delete cleanup because the files are generated artifacts owned by
that session. Uploaded input files remain independent and are not deleted when a
session is deleted.

If output byte deletion can fail in a future durable backend, it should use the
same cleanup discipline as snapshot deletes: retryable and observable, not
best-effort hidden loss. With the current in-memory store this is not a durable
hazard, but name it as a future durable-backend precondition.

## Tests

### File service/storage tests

- uploaded input file still has `downloadable: false` and `scope: null`;
- downloading uploaded input still returns the existing invalid-request error;
- session output file has `downloadable: true` and
  `scope: { type: "session", id: session_id }`;
- downloading a session output returns exact bytes and content type;
- `files.list({ scope_id })` returns scoped outputs and not workspace uploads;
- cross-workspace retrieve/list/download cannot see output files;
- deleting a session removes that session's output files;
- replace output set is atomic: failed replacement leaves the prior complete
  output set visible;
- quota violations leave prior outputs untouched and log/return an observable
  indexing failure.

### Runtime/service tests

- Docker command construction includes writable `/mnt/session/outputs` tmpfs
  owned by uid/gid `65534:65534`;
- Docker memory-headroom validation accounts for workspace + uploads + outputs
  tmpfs;
- Docker-local session writes one output file and terminal idle indexes it;
- `requires_action` idle does not index outputs prematurely;
- sandboxless terminalization/recovery does not replace existing outputs with an
  empty set;
- repeated live terminalization does not duplicate output file records;
- output indexing failure after terminal idle is observable and does not corrupt
  the event log;
- output files are not indexed for host-passthrough if unsupported.
- basename collisions fail indexing without clobbering either file;
- zero-byte outputs are indexed and downloadable;
- oversized files and aggregate quota violations are not partially indexed.

### Live smoke

Add a cheap Docker-local smoke, separate from the CWC SRE smoke:

1. start the deployment app with Docker-local enabled;
2. create an agent with `agent_toolset_20260401`;
3. create a session;
4. send a pinned prompt that writes `/mnt/session/outputs/probe.txt`;
5. wait for terminal idle;
6. call `client.beta.files.list(scope_id=session.id)`;
7. assert one downloadable file named `probe.txt`;
8. call `client.beta.files.download(file.id)`;
9. assert exact bytes;
10. delete the session and confirm cleanup behavior.

The smoke should use the real SDK because this feature exists primarily for
SDK/client compatibility.

## Open Questions Before Code

1. Confirm final v1 quota numbers: max file count, max single-file bytes, max
   aggregate output bytes.
2. Confirm whether to probe hosted basename-collision behavior now or defer it.

Resolved by hosted probe:

- Hosted uses basename-style filenames for nested outputs.
- Hosted lists mounted input copies under `scope_id`, but marks them
  `downloadable: false`; OMA v1 intentionally hides input copies rather than
  exposing internal snapshots.

Resolved by plan revision:

- Replace indexed outputs only after a successful live sandbox collection; never
  replace from sandboxless terminalization.
- Output indexing failures are observable and non-terminal for the session turn;
  prior indexed outputs stay visible.
- Basename collisions fail indexing rather than silently clobbering.

## Acceptance Criteria

- Public uploaded inputs remain non-downloadable.
- Internal mount snapshots remain unlistable and undownloadable.
- Docker-local provisions a writable `/mnt/session/outputs` mount before the
  agent runs.
- Docker-local generated files under `/mnt/session/outputs/` are listed by
  `scope_id=session_id`.
- Downloading a generated output file returns exact bytes.
- The real Python or TypeScript Anthropic SDK can list and download a generated
  output against OMA.
- Tests cover scope isolation, non-downloadable uploads, sandboxless recovery,
  quota failure, basename collision, binary download content type, and no
  duplicate output records across repeated live terminalization.
- Docs mention that generated output files are supported, while uploaded input
  file download remains intentionally unsupported.
