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

`GET /v1/files/<file_id>/content`:

- returns bytes for output files where `downloadable === true`;
- keeps returning the existing 400 invalid request for non-downloadable uploads;
- returns caller-safe not found for missing or cross-workspace file IDs.

## Design

### 1. Extend the sandbox provider boundary

Add a provider-owned output collection boundary beside `materializeFileResources`:

```ts
interface SandboxOutputFile {
  relativePath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  bytes: AsyncIterable<Uint8Array> | Uint8Array;
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
- stream/copy bytes out through Docker, validating the discovered size.

The control plane must not directly shell into Docker from `FileService`.

### 2. Persist output files as public scoped records

Extend `FileStorage` with an output-file creation path distinct from upload and
internal snapshots:

```ts
createSessionOutput(
  workspaceId: WorkspaceId,
  input: {
    sessionId: string;
    filename: string;
    mimeType: string;
    body: Uint8Array | AsyncIterable<Uint8Array>;
  },
): Promise<FileRecord>;
```

Records created this way have:

- `scope = { type: "session", id: sessionId }` at the public API boundary;
- `downloadable = true`;
- normal public `file_*` IDs;
- bytes readable by `download`.

Keep uploaded inputs as:

- `scope = null`;
- `downloadable = false`.

Keep internal snapshots on their existing internal-only APIs.

### 3. Index outputs at terminal idle

Collect and persist outputs when a runtime turn reaches terminal idle after the
agent has had a chance to write artifacts.

The first implementation can index on non-`requires_action`
`session.status_idle` and before disposing the runtime handle. This gives OMA
immediate indexing, while hosted clients already tolerate a short indexing lag.

Important boundaries:

- Do not index on `requires_action`; the session may resume and write more.
- Do not index after the sandbox is disposed.
- Do not let output-indexing failure erase the already-persisted session result.
  Prefer a logged warning plus no files over returning a false failure after the
  turn completed, unless review decides artifact persistence is part of turn
  success.
- Make indexing idempotent per `(workspace_id, session_id, relative_path,
  content hash)` or clear and replace prior generated outputs for the session.

The idempotency choice should be explicit before implementation. Conservative
v1 recommendation: replace all indexed output records for a session at each
terminal idle with the current contents of `/mnt/session/outputs/`. This avoids
duplicate records on replay/recovery and matches the "current session outputs"
mental model.

### 4. Route download bytes

Change `FileService.download` from unconditional rejection to:

- retrieve metadata;
- if `downloadable !== true`, preserve the existing invalid-request error;
- if downloadable, return the bytes from storage.

Change `GET /v1/files/:id/content` to return a binary response with the stored
`mime_type` where available.

### 5. Keep session deletes honest

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
- deleting a session removes or hides that session's output files, depending on
  the chosen cleanup contract.

### Runtime/service tests

- Docker-local session writes one output file and terminal idle indexes it;
- `requires_action` idle does not index outputs prematurely;
- repeated terminalization/recovery does not duplicate output file records;
- output indexing failure after terminal idle is observable and does not corrupt
  the event log;
- output files are not indexed for host-passthrough if unsupported.

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

1. Should terminal idle replace all prior output records for the session or
   append new records over time?
2. Should output indexing failure be terminal for the turn or only observable?

Resolved by hosted probe:

- Hosted uses basename-style filenames for nested outputs.
- Hosted lists mounted input copies under `scope_id`, but marks them
  `downloadable: false`; OMA v1 intentionally hides input copies rather than
  exposing internal snapshots.

The remaining questions are OMA implementation-policy choices, not hosted
contract unknowns. The plan recommends replace-on-terminal-idle and observable
non-terminal indexing failures, but those should be reviewed before code.

## Acceptance Criteria

- Public uploaded inputs remain non-downloadable.
- Internal mount snapshots remain unlistable and undownloadable.
- Docker-local generated files under `/mnt/session/outputs/` are listed by
  `scope_id=session_id`.
- Downloading a generated output file returns exact bytes.
- The real Python or TypeScript Anthropic SDK can list and download a generated
  output against OMA.
- Tests cover scope isolation, non-downloadable uploads, and no duplicate output
  records across repeated terminalization.
- Docs mention that generated output files are supported, while uploaded input
  file download remains intentionally unsupported.
