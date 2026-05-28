# Managed Agents resources scratchpad

Date: 2026-05-28

Purpose: collect parity notes from Anthropic Managed Agents docs, the
`cwc-workshops` examples, and live probes before designing OMA resources.

## Source examples read

- `/Users/mehmetoneryalcin/dev/junk/cwc-workshops/ship-your-first-managed-agent`
- `/Users/mehmetoneryalcin/dev/junk/cwc-workshops/production-ready-agent`
- `/Users/mehmetoneryalcin/dev/junk/cwc-workshops/agent-decomposition`
- `/Users/mehmetoneryalcin/dev/junk/cwc-workshops/agent-battle`

## Confirmed source patterns

- First-use tutorial path is:
  1. `client.beta.agents.create(...)`
  2. `client.beta.environments.create(...)`
  3. `client.beta.files.upload(file=...)`
  4. `client.beta.sessions.create(agent=..., environment_id=..., resources=[...])`
  5. `client.beta.sessions.events.stream(session_id)` plus `events.send(...)`
  6. `client.beta.sessions.delete(session_id)` for cleanup.
- File mounts are passed directly at session creation:
  `{"type": "file", "file_id": log.id, "mount_path": "app.log"}`.
  This is repeated in `agent_complete.py`, `e2e.py`, and
  `agent-decomposition/agents/cma.py`.
- Workshop code uses relative mount paths such as `app.log`,
  `data/<name>.csv`, and `targets/0.csv`, not absolute `/workspace/...`
  paths. OMA should probably accept relative workspace mount paths first.
- `production-ready-agent` treats session resources as more than files:
  `memory_store` resources and `vault_ids` are also part of session create.
  Those should stay out of the first OMA resource slice.
- `production-ready-agent` uses `sessions.retrieve()` for status/tool/outcome
  polling, `events.list()` plus `events.stream()` for replay + live tail, and
  `user.tool_confirmation` for gated tool calls. This confirms resources are
  only one parity layer, not the whole next milestone.
- `agent-battle` sends `user.interrupt` before `sessions.archive()` because
  archiving a running session can reject. OMA now has explicit interrupt
  semantics; archive-running-session parity remains a separate lifecycle gap.
- Stream reconnect is a real pattern: `agent-battle` loops on
  `sessions.events.stream(session.id)` reconnect after transport errors while
  the cloud session keeps running.

## Early OMA implications

- First vertical slice should be:
  upload file -> store file metadata/content -> create session with file
  `resources[]` -> materialize file into Docker-local workspace -> bash can
  read exact bytes.
- Do not start with session-resource CRUD, memory stores, GitHub resources, or
  vaults. Source examples show create-time file mounts are enough for the first
  useful tutorial path.
- Mount-path validation is load-bearing. Relative paths are common upstream;
  OMA should reject absolute paths, `..`, empty paths, and directory-only
  ambiguity unless a live probe proves otherwise.
- File API idempotency should be designed against upload/mount reality, not in
  isolation. Content-hash dedupe plus optional `Idempotency-Key` should be
  evaluated after live probe behavior is known.

## Live probe questions

- Exact `files.upload` returned fields.
- Exact accepted file argument forms and metadata names.
- Whether `sessions.create(... resources=[file mount])` echoes resources in the
  returned session. Answered: yes; see `sessions.create.relative_mount` in
  `scratch/25-managed-agents-resource-probe-output.txt`.
- Default `mount_path` behavior if omitted.
- Error behavior for invalid/path traversal/absolute mount paths.
- Whether mounted relative path is read from sandbox current directory, and
  where that sits relative to `/mnt/session/uploads`.

## SDK introspection

Python SDK version in the workshop venv: `anthropic 0.103.1`.

- `client.beta.files.upload(file=...) -> FileMetadata`
- `client.beta.files.retrieve_metadata(file_id)`
- `client.beta.files.download(file_id)`
- `client.beta.files.delete(file_id)`
- `client.beta.sessions.create(... resources=..., vault_ids=...)`
- `client.beta.sessions.resources.list(session_id)`
- `client.beta.sessions.resources.retrieve(resource_id, session_id=...)`
- `client.beta.sessions.resources.update(resource_id, session_id=..., authorization_token=...)`
- `client.beta.sessions.resources.delete(resource_id, session_id=...)`
- No `client.beta.sessions.resources.create` method in this SDK. Create-time
  `resources=[...]` is the important first path.

## Live probe findings

Probe scripts:

- `scratch/25-managed-agents-resource-probe.py`
- `scratch/26-managed-agents-file-mount-cat-probe.py`

Sanitized outputs:

- `scratch/25-managed-agents-resource-probe-output.txt`
- `scratch/26-managed-agents-file-mount-cat-probe-output.txt`

Findings:

- `files.upload` returns metadata:
  `id`, `type: "file"`, `filename`, `mime_type`, `size_bytes`, `created_at`,
  `downloadable`, `scope`.
- Files uploaded for session resources were `downloadable: false`.
  `files.download(file_id)` returned 400:
  `File '<id>' is not downloadable`. OMA should not assume upload implies
  later byte-download through the public API. Internally, OMA still needs bytes
  to mount into Docker, so its own file store must keep content even if the
  Anthropic public API marks uploaded files non-downloadable.
- `sessions.create(resources=[{"type": "file", "file_id": uploaded_id,
  "mount_path": "probe.txt"}])` succeeds.
- Returned session resources use an absolute canonical mount path under
  `/mnt/session/uploads/...`.
  - `"probe.txt"` becomes `/mnt/session/uploads/probe.txt`.
  - `"data/probe.txt"` becomes `/mnt/session/uploads/data/probe.txt`.
  - omitted `mount_path` becomes `/mnt/session/uploads/<original_uploaded_file_id>`.
  - `"/tmp/probe.txt"` becomes `/mnt/session/uploads/tmp/probe.txt`.
    Upstream treats absolute paths as upload-relative by stripping the leading
    slash, not as host/container absolute paths.
- `../probe.txt` is rejected with 400:
  `Invalid file resource: mount path "../probe.txt" escapes /uploads/`.
- duplicate mount paths are rejected with 400:
  `Invalid file resource: mount_path overlaps another resource: /uploads/dupe.txt`.
- The session resource `file_id` echoed in the session is not the same as the
  originally uploaded file id. Anthropic appears to clone/materialize the file
  into a session-scoped file id while preserving default path derivation from
  the original upload id.
- Live Sonnet smoke:
  - Created temporary agent with `model: claude-sonnet-4-6`.
  - Uploaded 22-byte text file.
  - Created session with resource mount `probe.txt`.
  - Sent one message asking the agent to read
    `/mnt/session/uploads/probe.txt` with bash.
  - Event stream included `agent.tool_use` with `name: "bash"` and
    `agent.tool_result`.
  - Final assistant text exactly matched `OMA_RESOURCE_PROBE=ok`.
  - Session was deleted, agent archived, file deleted.

## OMA design updates from live probes

- OMA should model file resources as create-time session resources first:
  `{ type: "file", file_id, mount_path? }`.
- Canonical mount root should be `/mnt/session/uploads`, matching Anthropic.
  Docker-local can map that inside the container even if its writable workspace
  remains `/workspace`.
- Mount path normalization should mimic upstream:
  - relative paths are rooted under `/mnt/session/uploads`;
  - leading `/` is stripped and still rooted under `/mnt/session/uploads`;
  - omitted path defaults to original `file_id`;
  - `..` escape is rejected;
  - duplicate/overlapping paths are rejected.
- First implementation should preserve the original uploaded file id in the
  request/session input, but can decide whether to clone to session-scoped file
  ids later. Cloning is parity-correct but not necessary for the first OMA
  vertical unless lifecycle isolation needs it.
- A real acceptance probe for OMA should mirror the live smoke:
  upload file -> create session with `resources[]` -> send user message -> bash
  cats `/mnt/session/uploads/probe.txt` inside Docker -> exact byte match.

## Broader CWC workshop pass

Read:

- Root `cwc-workshops/README.md`.
- `agent-battle/README.md`.
- `agent-decomposition/README.md`.
- `agents-that-remember/README.md`.
- `eval-driven-agent-development/README.md` and key `src/*` files.
- `production-ready-agent/README.md`, `starter/README.md`,
  `solution/README.md`, and `solution/app/api/*`.
- `rightmodel/README.md`.
- `how-we-claude-code/README.md`.

### Product/API patterns worth carrying into OMA

- **Stream-first then backfill.** `production-ready-agent/solution/app/api/stream/[id]/route.ts`
  opens the live stream before replaying historical `events.list()`, then
  dedupes. `eval-driven-agent-development/src/create-slides.ts` also opens
  `events.stream()` before sending `user.message`. This is an important
  client pattern and validates OMA's replay + live tail design.
- **Status idle can be transient.** Eval code treats
  `session.status_idle` with `stop_reason.type === "requires_action"` as a
  pause, not completion. OMA should preserve this distinction when permission
  prompts/tool confirmations are implemented.
- **Permission confirmations are event-shaped.** Production-ready sends:
  `{ type: "user.tool_confirmation", tool_use_id, result: "allow" | "deny",
  deny_message? }`. This should be the next permission slice, not hidden inside
  a separate confirm endpoint internally.
- **Outcome evaluation is event-shaped.** Production-ready sends
  `user.define_outcome` with `{ description, rubric: { type: "text", content } }`.
  Session retrieve then surfaces `outcome_evaluations`. This is product-parity
  work after file resources.
- **Threads are first-class for multi-agent.** Production-ready uses
  `sessions.threads.list(session_id)` and
  `sessions.threads.events.{list,stream}(thread_id, { session_id })`.
  OMA should not fake multi-agent by overloading the main event stream forever;
  eventually threads need their own surface.
- **Memory stores are create-time resources.** Agents-that-remember and
  production-ready both attach memory stores through session resources:
  `{ type: "memory_store", memory_store_id, access, prompt? }`.
  Memory resources are siblings of file resources but should not be included in
  the first file-mount PR.
- **Memory store lifecycle is independent of sessions.** The same memory store
  is attached to multiple sessions, can be inspected independently, and can be
  archived. This argues against tying all future resources to session lifetime.
- **Dreaming is batch/distillation, not live memory.** It reads sessions and/or
  memory stores and writes a new memory store. Interesting later, not relevant
  to the file resource MVP.
- **Output files are scoped to sessions.** Eval-driven agents write to
  `/mnt/session/outputs/output.pptx`; client code later calls
  `files.list({ scope_id: session.id, betas: [...] })`, retries for indexing,
  then `files.download(file_id)`. This is distinct from uploaded input files,
  which were `downloadable: false` in the live probe. OMA should model input
  file uploads and output artifacts separately when output files are added.
- **Output file indexing has lag.** Eval-driven code retries `files.list` for
  1-3s after session idle. If OMA adds output artifacts, tests should include
  eventual indexing semantics or deliberately choose immediate indexing and
  document the divergence.
- **Agent/environment YAML via `ant` is a real provisioning path.** Eval-driven
  creates agents/environments from YAML. OMA does not need this now, but docs
  should eventually include copy-pasteable JSON/YAML examples for parity.
- **Session cleanup patterns differ by verb.** Agent-battle sends
  `user.interrupt` before `sessions.archive()` because archiving a running
  cloud session can reject. `ship-your-first-managed-agent` uses
  `sessions.delete()` for cleanup. OMA now supports `user.interrupt`; archive
  still best-effort-closes instead of rejecting running sessions first.
- **Do not overfit resource design to one tutorial.** Resources support files,
  memory stores, and eventually vault/MCP access. First PR can be file-only,
  but parser/storage types should leave room for a discriminated union without
  accepting unsupported resource types silently.

### Things not worth live-probing now

- Memory store read/write behavior: important, but it is a later resource type.
- Dreaming: later batch feature.
- Output artifact download: useful later, but not needed for input file mounts.
- Threads and multiagent: product-parity work after resources/permissions.
- Opus-based judge/eval flows: expensive and unrelated to file resource shape.

### Updated first resources plan

1. Add top-level Files API MVP:
   - upload stores metadata and bytes;
   - retrieve metadata;
   - delete;
   - optionally list;
   - public download can be omitted or made explicitly controlled because live
     uploaded files are not necessarily downloadable.
2. Add session create `resources[]` parser for `type: "file"` only:
   - validate `file_id` exists;
   - normalize/canonicalize mount paths to `/mnt/session/uploads/...`;
   - reject `..` escapes and overlapping paths;
   - reject unsupported resource types with caller-safe specific errors.
3. Persist session resources and echo them on session objects.
4. Materialize file resources into Docker-local before first runtime turn.
5. Acceptance probe:
   - create deployment app with Docker-local;
   - upload a tiny file;
   - create session with file resource;
   - send user message asking bash to cat `/mnt/session/uploads/probe.txt`;
   - assert `agent.tool_use` is `bash` and result/assistant text contains exact
     file bytes;
   - delete session and assert container cleanup still works.
