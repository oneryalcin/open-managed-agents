# File storage prior art notes

Date: 2026-05-28

Purpose: narrow storage-focused prior art pass before implementing ADR 0013.
This is not a second resource ADR. It checks whether the ADR's storage and
mount decisions conflict with nearby agent-platform prior art.

## Scope

Reviewed for four questions only:

1. file identity and tenancy/scoping,
2. storage abstraction shape,
3. mount/materialization timing,
4. quota, cleanup, and anti-patterns.

Sources checked:

- ADR 0013 in this repo: `docs/adrs/0013-file-resources-and-session-mounts.md`.
- Anthropic live resource probes: `docs/references/managed-agents-resources-notes.md`.
- Flue local checkout at `b6154a5`:
  - `/private/tmp/flue/docs/deploy-cloudflare.md`
  - `/private/tmp/flue/docs/connect-daytona.md`
  - `/private/tmp/flue/connectors/sandbox--daytona.md`
- OpenClaw Managed Agents local clone at `6b89ca0`:
  - `/private/tmp/oma-storage-prior-art/openclaw-managed-agents/README.md`
  - `/private/tmp/oma-storage-prior-art/openclaw-managed-agents/src/index.ts`
- `rogeriochaves/open-managed-agents` at `e9a074356251` via GitHub API:
  - `packages/server/src/schemas/sessions.ts`
  - `packages/server/src/routes/sessions.ts`
  - `packages/server/src/__tests__/schema-handler-alignment.test.ts`
- `paperclipai/paperclip` at `8da50dbcf8f9` via GitHub API:
  - `server/src/storage/types.ts`
  - `server/src/storage/service.ts`
  - `server/src/storage/local-disk-provider.ts`
  - `server/src/storage/s3-provider.ts`
  - `server/src/__tests__/storage-local-provider.test.ts`
  - `docs/deploy/storage.md`
- Hermes Agent local checkout at `64145a199`:
  - `/Users/mehmetoneryalcin/dev/junk/hermes-agent/environments/tool_context.py`
  - `/Users/mehmetoneryalcin/dev/junk/hermes-agent/tools/memory_tool.py`
- Official docs spot-checks:
  - Modal sandbox files: https://modal.com/docs/guide/sandbox-files
  - Modal volumes: https://modal.com/docs/guide/volumes
  - Daytona file system operations: https://www.daytona.io/docs/file-system-operations/
  - Cloudflare Sandbox bucket mounts: https://developers.cloudflare.com/sandbox/guides/mount-buckets/
  - OpenAI Agents sandbox concepts: https://openai.github.io/openai-agents-js/guides/sandbox-agents/concepts/

## Verdict

No high-severity contradiction to ADR 0013.

The prior art mostly validates the amended ADR:

- storage APIs should be tenant/workspace-scoped at the storage boundary,
- bytes should be read through a stream-shaped interface,
- object keys need path-containment checks even when IDs look opaque,
- mounted workspace context should be hydrated/materialized before the agent
  starts depending on it,
- uploaded input bytes and future output artifacts should stay separate,
- local disk is a good next backend, but not needed in v1.

The one useful implementation addition from prior art is internal `sha256`
metadata on stored uploads. It does not need to be public in v1, but it is cheap
to store and useful later for diagnostics, dedupe, and integrity checks.

Do not copy Paperclip's storage code shape verbatim. Paperclip uses whole
`Buffer` upload bodies and hashes the whole buffer at once; OMA should keep both
upload and read paths stream-shaped so future filesystem/object-store backends
do not require a second API redesign.

## Findings by source

### Paperclip storage

Paperclip is the closest direct storage prior art.

Relevant shape:

- `StorageProvider` has `putObject`, `getObject`, `headObject`, `deleteObject`.
- `getObject` returns a Node `Readable` stream, not a whole-buffer value.
- `StorageService` takes `companyId` on `putFile`, `getObject`, `headObject`,
  and `deleteObject`.
- `putFile` builds object keys with the company id as the first path segment.
- `ensureCompanyPrefix(companyId, objectKey)` blocks cross-company access and
  rejects `..` in object keys.
- local disk provider normalizes object keys, rejects absolute paths, `.`, `..`,
  and path escape after `path.resolve`.
- local disk writes through a temp file and `rename`, avoiding partially-written
  target files.
- S3 provider exposes the same provider contract and converts S3 bodies into
  readable streams.
- tests explicitly cover cross-company object access and idempotent delete.

OMA implications:

- ADR 0013's `workspaceId` on every `FileStorage` method is correct.
- `openBytes(): AsyncIterable<Uint8Array>` is the right direction; do not
  regress to `readBytes(): Uint8Array`.
- Store internal `sha256` at upload time, even if not public in the first wire
  response. Compute it incrementally while consuming upload chunks; do not copy
  Paperclip's `hashBuffer(input.body)` whole-buffer shape.
- Make upload input stream-capable too, for example
  `body: AsyncIterable<Uint8Array> | Uint8Array`. Paperclip's `PutFileInput`
  uses `body: Buffer`; that is fine for small attachment uploads but would
  fight OMA's future object-store backend and ADR 0013's stream-shaped reads.
- When filesystem storage lands, copy Paperclip's discipline: normalize keys,
  reject absolute paths and traversal, resolve inside root, write temp then
  rename.
- Idempotent file delete is reasonable, but OMA's public behavior should still
  match the chosen Managed Agents contract.

What not to copy:

- Paperclip's object key is a storage key, not a Managed Agents file id. OMA
  should keep public `file_*` IDs and hide object keys behind the store.
- Paperclip's company-prefix check is safe by construction because object keys
  are internal. OMA must keep storage keys internal too: do not expose internal
  object keys in public API responses, caller-facing errors, logs, or metrics.
  Public surfaces use `file_*` and `sesrsc_*` IDs only.

### rogeriochaves/open-managed-agents

The repo has a useful schema shape but a weak implementation path.

Relevant shape:

- `SessionCreateBodySchema` accepts `resources`.
- resource params include `file` with `file_id` and optional `mount_path`.
- response resources have `id`, `type`, `file_id`, `mount_path`, `created_at`,
  and `updated_at`.
- route implementation stores `JSON.stringify(body.resources ?? [])` directly
  into the session row.
- its schema-handler alignment lint is valuable because it exists to catch
  accepted-but-ignored fields.

OMA implications:

- ADR 0013's `sesrsc_*` echo shape matches this useful wire shape.
- The route shows the danger ADR 0013 is avoiding: accepting `resources[]` into
  storage is not enough. The create path must validate, snapshot, and materialize.
- Keep the #24-style allowlist/reject discipline and add resource-specific
  alignment tests so accepted resource fields cannot become no-ops.

What not to copy:

- Do not store unvalidated resource JSON directly.
- Do not accept `github_repository` just because the schema can describe it.

### OpenClaw Managed Agents

OpenClaw's file API is workspace-session oriented, not uploaded-resource
oriented.

Relevant shape:

- API docs expose workspace file operations under an agent/session path:
  `GET/PUT/DELETE /v1/agents/:id/files/<rel>?session_id=<id>`.
- Runtime sessions have isolated containers with bind-mounted state.
- The README explicitly warns that user-token auth is not yet tenant isolation:
  agents, environments, vaults, and workspace file APIs remain
  deployment-global until ownership checks cover every resource.
- Restart handling adopts labelled containers whose sessions still exist and
  stops orphans.

OMA implications:

- Workspace/session file APIs are a different surface from Managed Agents
  uploaded input files. Keep ADR 0013's top-level Files API separate from future
  live workspace file browsing.
- The deployment-global warning strongly supports `workspaceId` at the storage
  boundary now, even while OMA has few/no users.
- OpenClaw's labelled-container adoption/orphan cleanup validates our
  best-effort cleanup plus reaper posture for Docker materialization failures.

What not to copy:

- Bind-mounted persistent state is not the right v1 input-file mount for OMA.
  ADR 0013's tmpfs + session-scoped snapshot keeps the Docker-local isolation
  posture tighter.

### Flue, Daytona, and Cloudflare

Flue is framework-shaped, but its connector/docs split gives useful storage
patterns.

Relevant shape:

- Flue's Daytona connector wraps `sandbox.fs.downloadFile(path)` and
  `sandbox.fs.uploadFile(buffer, path)` behind a sandbox API.
- Flue's Daytona docs use a setup session to clone/install into `/workspace`,
  then a second working session rooted at the prepared directory.
- Flue's Cloudflare docs state R2 is a hydration source, not a live filesystem
  mount, for the lightweight `@cloudflare/shell` workspace path.
- The same docs point to Cloudflare Sandbox `mountBucket` only when bucket keys
  need to appear as live filesystem paths for Linux shell commands.
- Cloudflare's official Sandbox docs have a first-class `mountBucket` path for
  live R2 bucket semantics.
- Daytona's official docs expose `uploadFile` and `downloadFile` operations and
  note that relative paths resolve inside the workspace unless a leading `/` is
  provided.

OMA implications:

- Hydration/materialization before the useful run is a repeated pattern. ADR
  0013's `sessions.create` materialization is not overkill; it matches the
  "prepare the workspace before the working session" idea.
- Live bucket mounts are a v2/storage-backend feature, not v1. They solve a
  different problem from uploaded input files.
- Provider adapters should expose file operations, but OMA should not expose
  provider paths as public file IDs.

What not to copy:

- Do not make R2/S3 a live mount in v1.
- Do not use provider-native relative/absolute path behavior as the OMA public
  mount-path contract. ADR 0013's `/mnt/session/uploads` normalization stays
  the public contract.
- Do not materialize Docker-local uploads by shelling out through the sandbox
  user's normal write path. Hermes has to chunk base64 at roughly 60 KB because
  terminal/command-length limits make shell transfer fragile. ADR 0013's
  provider-owned `docker cp`/root materialization avoids that class entirely.

### Modal

Modal separates sandbox filesystem operations from durable volumes.

Relevant shape from official docs:

- Sandbox files docs describe options for uploading files to a Sandbox and
  reading files back out.
- Volumes are described as distributed filesystem storage optimized for
  write-once/read-many workloads.
- Volume docs include batch upload, copying within volumes, and downloading
  files from a volume.

OMA implications:

- ADR 0013's split between top-level uploaded input files, session snapshots,
  and future output artifacts maps cleanly to Modal's separation between live
  sandbox filesystem and durable volume-like storage.
- Write-once/read-many is the right mental model for uploaded input files.
- If Modal becomes the next real remote provider, it should implement the same
  session mount snapshot contract rather than leaking Modal Volume identity into
  OMA's wire API.

### OpenAI Agents sandbox concepts

OpenAI's sandbox-agent concepts validate the boundary language in ADR 0013.

Relevant shape:

- A manifest is the fresh-session workspace contract.
- A sandbox session is the live execution environment where commands run and
  files change.
- The `sandbox` run option controls whether the run injects, reconnects to, or
  creates a sandbox session.
- Saved state/snapshots are separate from fresh session manifests.

OMA implications:

- Keep public file resources as initial workspace inputs, not live sandbox
  state.
- Keep session-scoped mount snapshots distinct from top-level uploaded files.
- Future snapshot/resume work should not overload `resources[]`.

### Hermes Agent

Hermes is useful mainly as negative/low-level prior art.

Relevant shape:

- `ToolContext.upload_file()` base64-encodes host bytes, chunks large files,
  and decodes inside the sandbox through terminal commands.
- `download_file()` does the inverse through base64 in terminal output.
- `memory_tool.py` injects a frozen memory snapshot into the prompt at session
  start; mid-session writes update durable files but do not change the current
  system-prompt snapshot.

OMA implications:

- Shell/base64 upload is a good fallback trick, but not the right Docker-local
  materialization mechanism when `docker cp` or provider-owned root
  materialization is available.
- The frozen snapshot pattern validates ADR 0013's session-scoped mount
  snapshot: the agent sees a stable view for the session even if the source
  resource changes later.

## Cross-cutting lessons

### Keep workspace scoping at the storage boundary

Do not rely on route-level checks alone. Paperclip's `companyId` prefix and
cross-company test are the clearest evidence. OMA's `workspaceId` belongs on
every storage call and on session resource validation.

### Use stream-shaped reads even for small files

Paperclip S3/local and Daytona/Modal-style APIs all point away from whole-buffer
storage APIs as the long-term shape. ADR 0013's `openBytes()` is worth keeping.

### Materialize/hydrate before the working run

Flue's setup-session pattern, Cloudflare R2 hydration, OpenAI manifests, and
ADR 0004's Tier 1 rule all converge here: the useful run should not discover
missing input files halfway through.

### Snapshot input files for sessions

The best v1 compromise remains:

- public session resource keeps the original uploaded `file_id`,
- `sessions.create` copies bytes to an internal session-scoped mount snapshot,
- later `files.delete` does not break an already-created session mount.

This avoids upstream-style cloned public IDs while still closing the TOCTOU.

### Store hashes internally

Paperclip stores `sha256` on upload. OMA should do the same internally. It does
not need to expose the hash publicly in v1, but it helps future dedupe,
integrity checks, and debugging.

Compute the hash while streaming upload bytes into storage. Avoid an API that
requires buffering the full upload just to calculate the digest.

### Keep storage keys private

Paperclip's cross-company protection works because object keys are constructed
inside the service and remain internal. OMA should follow the same discipline
with stronger public boundaries:

- public API returns `file_*` and `sesrsc_*` IDs,
- storage keys are implementation detail,
- storage keys do not appear in caller-facing errors,
- logs and metrics should use public IDs or redacted/hash-only storage-key
  labels.

### Prefer lexical path rejection at the API boundary

Paperclip's local-disk provider protects the filesystem with a post-resolution
`path.resolve(...).startsWith(root)` check. That is still necessary for any
future filesystem backend.

ADR 0013 is stricter at the public mount-path boundary: reject empty, `.`, and
`..` segments lexically before normalization. Keep both layers when filesystem
storage lands. Lexical public rejection gives simpler tests and prevents
provider-specific normalization behavior from becoming part of the public
contract.

### Do not add a ResourceManager framework

None of the useful prior art requires a registry-heavy abstraction for v1.
Keep:

- `FileStorage` for top-level uploaded bytes,
- session resource validation/materialization in the session create path,
- sandbox-provider materialization behind the provider boundary.

Avoid:

- per-agent resource policy DSLs,
- generalized `ResourceProvider` registries,
- UI-coupled resource browser concepts.

## Recommendation for implementation PR 1

Proceed with ADR 0013 unchanged.

For the Files API + storage PR, add these implementation details:

- include `workspaceId` in every storage method and test cross-workspace denial,
- accept stream-capable upload bodies,
- store internal `sha256` via streaming hash,
- keep `openBytes()` stream-shaped,
- keep internal storage keys private and expose only `file_*` / `sesrsc_*`,
- enforce the ADR quotas before storing bytes,
- make local disk/filesystem storage a follow-up, but design the in-memory store
  so swapping in local disk later does not change service call sites,
- keep the skipped/live resource smoke probe in the repo as ADR 0013 requires.

No prior-art finding justifies widening v1 beyond uploaded files and create-time
file mounts.
