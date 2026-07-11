# Plan 0126 — Skills: `/v1/skills` resource + runtime execution

Date: 2026-07-10
Parent: [appliance product roadmap](0114-appliance-product-roadmap.md) —
capability track item 2 ("skills execution"), the remaining half of the
capability exit criterion now that MCP (0122 M1–M3) has shipped.
Grounded in: 4 research threads (Pi runtime, hosted wire, OMA current state,
prior art) + 3 live hosted probes (56 = `/v1/skills` wire, 56b = wire unknowns,
57 = execution trace). Probe artifacts: `scratch/artifacts/56-…json`,
`56b-…json`, `57-…json`.

## 0. What a skill is (settled)

A directory with a `SKILL.md` (YAML frontmatter + Markdown body) plus optional
`scripts/`, `references/`, `assets/`. Frontmatter: `name` (required, ≤64,
`[a-z0-9-]`, no leading/trailing/consecutive hyphen, must match dir name,
reserved `anthropic`/`claude` forbidden) + `description` (required, ≤1024);
optional `license`, `compatibility`, `metadata`, `allowed-tools`. Three-tier
progressive disclosure: metadata always loaded, body on activation, bundled
files on demand. Spec: agentskills.io/specification.

**`allowed-tools` is advisory, not a security boundary** — Pi does not parse it,
the Claude Agent SDK does not honor it (verified: anthropic/claude-code#37683).
v1 does NOT enforce it (parity with hosted/SDK). Named non-goal below.

## 1. The two layers

The work splits cleanly and the layers are independently testable:

- **Wire-parity layer** — a first-class `/v1/skills` resource (upload, version,
  list, get, delete) + attachment validation on agents/sessions. Mechanical;
  follows the existing resource pattern. No runtime dependency.
- **Runtime-execution layer** — resolve an agent's attached skills to bundles,
  materialize them into the sandbox at the path the read tool can reach, and
  advertise them to Pi so the model discovers and uses them. This is the novel
  part; its one hard constraint (the host↔container split) is resolved by the
  pinned-Pi source read (D5) + the probe-57 mount path.

Roadmap exit criterion ("an agent can use at least one skill") is met by the
runtime layer + one **OMA-owned example skill** (the anthropic prebuilt catalog
is a licensing blocker — D3). The custom-upload path is the milestone; wire layer
ships first.

## 1a. Evidence labeling (review: every reviewer)

Claims below carry one of four tags. Do not treat Documented/Chosen/Unknown as
probe facts.
- **[Obs]** Observed in probe 56/57 artifacts (`scratch/artifacts/56-…json`,
  `57-…json`) — auditable.
- **[Doc]** From hosted docs / agentskills.io spec — not probed.
- **[OMA]** A chosen OMA behavior (we are free to pick; not required to match
  hosted byte-for-byte).
- **[Unk]** Not yet established; listed in §9.

## 2. Wire contract (beta `skills-2025-10-02`)

### 2.1 Resource

- **CreateSkill** `POST /v1/skills` — **`multipart/form-data`**, field `files[]`.
  → 200 `{ id: "skill_…", display_title, latest_version, source: "custom",
  type: "skill", created_at, updated_at }`; wire discriminator is
  **`type: "skill"`**, `source ∈ {custom, anthropic}` **[Obs]**. All probe-56b
  **[Obs]**: the zip **must contain a single top-level folder** — a root-level
  SKILL.md is **rejected 400** ("Zip must contain a top-level folder…");
  path-qualified individual `files[]` (no zip, part name `<name>/SKILL.md`) is
  **accepted**; omitting `display_title` **derives it from the SKILL.md `name`**;
  a duplicate `display_title` is **400** ("Skill cannot reuse an existing
  display_title: …"); the request-size cap is **30 MB → HTTP 413**
  `request_too_large` ("The Skills API accepts requests up to 30MBs").
- **Version object** **[Obs]** `{ id: "skill_version_…", skill_id, version, name,
  description, directory, type: "skill_version", created_at }`. `name`/
  `description` parsed from SKILL.md; **`directory` == `name`, enforced at upload**
  (probe 56b: a folder name ≠ SKILL.md name → **400** "The folder name '…' must
  match the skill name '…'"). So the mount root is unambiguous. Custom `version`
  = **microseconds-since-epoch string** (16 digits; `1783682001075540` =
  2026-07-10T11:13:21.075540Z) **[Obs]**; anthropic = date string (`"20260203"`,
  observed in probe 56's list) **[Obs]**; both accept `"latest"` **[Doc]**.
- **GetSkill** `GET /v1/skills/{id}` = the CreateSkill shape (no inline versions) **[Obs]**.
- **ListSkills** `GET /v1/skills` → `{ data, has_more, next_page }` **[Obs]**.
  Anthropic prebuilts appear here — probe observed **`xlsx` + `pptx`** only
  (`source:"anthropic"`, date version) **[Obs]**; `docx`/`pdf` presence is
  **[Doc]**, NOT observed. Pagination continuation is **[Unk]**.
- **CreateVersion** `POST /v1/skills/{id}/versions` (same multipart) **[Obs]**;
  **ListVersions** → `{ data, has_more, next_page }` **[Obs]**; **GetVersion** **[Obs]**.
- **Lifecycle is delete-only** (no archive) **[Obs]**: `DELETE /v1/skills/{id}`
  with any version present → 400; delete each version → 200, then the skill → 200.
  Consistent with OMA's content resources (files hard-delete; only lifecycle
  entities archive). **Referenced-skill deletion [Obs, probe 56b]:** deleting a
  skill an agent references **succeeds** (no referential protection); the agent
  keeps a **dangling ref** (`GET agent` still echoes `{skill_id, version:"latest"}`);
  **re-attaching a deleted `skill_id` to a new agent → 400** (existence checked at
  attach). OMA matches this at the wire level; D4's session snapshot additionally
  retains bytes for a *live* session (more protective than hosted, for
  reproducibility).

### 2.2 Attachment (already modelled in OMA, needs hardening)

Skills attach on the **agent** (`skills[]`). Entry `{ type: "anthropic"|"custom",
skill_id, version? }` — already `ManagedAgentsSkill` in `types/agents.ts:58-62`.
Attachment validation on agent-create, all **[Obs]** in probe 56:

- `anthropic` + `version` → **accepted & echoed** (corrects the docs' "custom
  only" note).
- bad `type` → 400 invalid_request_error.
- unknown custom `skill_id` → 400.
- **duplicate `skill_id` → 400** "Agent has invalid configuration: duplicate
  skill_id \"…\"".
- skills + `tools: []` at agent-create → **accepted** (the read-tool coupling is
  NOT enforced here — see §2.3).

**Scope correction (review: External + Sonnet — MAJOR).** Hosted also exposes
session-local skills via `agent_with_overrides` and counts a **20-skill cap
across all agents in a multi-agent session** [Doc]. **Neither exists in OMA
today:** the session API accepts only `agent: string | {type:"agent",…}` and
rejects overrides (`sessions/request.ts` `agentField`), and multi-agent config
is stored but has no runtime. **v1 scope [OMA]: skills are the root persisted
agent's own attachments only.** The cap and read-tool coupling are enforced
against that single effective agent config. `agent_with_overrides` and
cross-agent cap aggregation are **named later parity work**, not in this arc.
The 20-cap *value* is [Doc]; the over-cap error message is [Unk] (probe 56's
dup-test tripped the duplicate rule first). OMA enforces a 20-cap per agent with
an OMA-chosen invalid_request_error message [OMA].

### 2.3 Read-tool coupling [Obs — exact message]

Hosted enforces at **session create** (probed via `agent_with_overrides` clearing
`tools:[]` with skills attached) → **400**: *"Missing required tool: skills
require the read tool to be usable (enabled and not always_deny) on the session's
`agent_toolset`"*. NOT enforced at agent-create ([Obs], §2.2). OMA v1 enforces the
equivalent against the **root agent's effective toolset** (D6) — it does not need
`agent_with_overrides` to reproduce the rule.

### 2.4 Events [Obs — auditable re-run]

**No skill-specific events.** Deduped distinct type SET (probe 57 re-run):
`user.message`, `agent.thinking`, `agent.tool_use`, `agent.tool_result`,
`agent.message`, `session.status_*`, `session.thread_status_*`,
`span.model_request_*`; `skill_specific_events: []`. A skill invocation is
ordinary `tool_use`/`tool_result` traffic. **OMA needs zero new event
vocabulary.**

## 3. Runtime execution model

- **Mount path [Obs, auditable]:** each skill mounts at **`/workspace/skills/<dir>/`**
  under the workspace root — where Pi's sandboxed `read` tool (guarded to
  `/workspace`) can open it. Probe 57 re-run proves this with *tool output* (not
  the model's paraphrase): a read `tool_result` returned the SKILL.md body at
  `/workspace/skills/probe57-…/SKILL.md`, and a bash `tool_result` returned that
  same path from `find`. Hosted **enforces name==directory at upload** (probe
  56b), so `name` and `directory` are always equal and the mount root
  `/workspace/skills/<name>/` is unambiguous — OMA mirrors the upload rule (D2).
- **The host↔container split — RESOLVED against pinned Pi 0.75.4** (Opus + Fable
  + External + Sonnet all read the source): Pi's loop runs in the control-plane
  process; `read`/`bash` are proxied into the container guarded to `/workspace`
  (`docker.ts:427-439`). `AgentSession._rebuildSystemPrompt` →
  `resourceLoader.getSkills()` → `formatSkillsForPrompt` (`skills.js:258-279`)
  emits `skill.filePath` **verbatim into `<location>` and never reads the file**.
  So a **custom Pi `ResourceLoader`** returning `{name, description,
  filePath:"/workspace/skills/<name>/SKILL.md", baseDir, disableModelInvocation:
  false}` — metadata from the OMA store — advertises the container path with
  **zero host I/O**. No host staging needed. (Details in D5.)
- **Provision, don't execute [Obs]:** the model ran the skill via its own bash;
  there is no skill executor to build.
- **System-prompt gate — CONFIRMED (Opus/Sonnet source read):** Pi injects
  `<available_skills>` iff the literal tool name `"read"` is in the selected
  tools (`system-prompt.js:34,66,115`). OMA registers the tool as `"read"`
  (`provider.ts:330`) and passes it (`runner.ts:975`) — the block renders.
  Corollary: disabling `read` silently drops all skills, which is exactly why
  D6's explicit session-create rejection is load-bearing.

## 4. Design decisions

### D1 — Skill storage contract: a DEDICATED private store

The skill *reference* (`{type, skill_id, version}`) already lives on the agent
row (`agents/store.ts:20`). The gap is skill *content* — and two consecutive
external storage reviews established it needs a **contract of its own**, not
reuse-by-analogy of the `files/` machinery (which is public, 20 MiB-capped,
100 MiB-quota-shared, and commits per-file with no multi-file transaction). This
section is that contract; D4/D8/D9 build on it.

**Decision [OMA] — explode at upload into a dedicated PRIVATE `SkillContentStorage`.**
The zip is never stored as a blob; at upload it is validated and exploded into
individual files. But each file goes to a **new private content store**, NOT
`FileStorage.create()` (which produces public `/v1/files` records — listable and
deletable there; review round 4, external F2). `SkillContentStorage` is a
separate object namespace with its own retrieval (internal-only, by
`(skill_id, version, path)`), invisible to `/v1/files`, following the
`files/store-{local,memory}` backend shape but as its own class.

**Tables (owner/version split — external F6):**
- **`skills`** (owner): `workspace_id, skill_id, name, display_title, source,
  latest_version, created_at`. `name` and `display_title` are **UNIQUE per
  workspace HERE** — not on version rows, so a 2nd version of a skill does not
  self-collide.
- **`skill_versions`**: `skill_id, version, description, directory, file_count,
  total_bytes, manifest_sha256, created_at`.
- **`skill_files`**: `(skill_id, version, path)` → `size, sha256,
  content_object_id`. This is the manifest the loader + recovery read after the
  source skill is deleted (`description` on the version row, files here).

**Aligned size caps [external F1]:** the per-file cap is **20 MiB**, matching the
platform's `MAX_UPLOADED_FILE_BYTES` (`files/types.ts:15`) — NOT the earlier
25 MB, which would upload then deterministically fail the 20 MiB snapshot copy at
session create. Per-version total ≤ 100 MB, ≤ 500 files (D2).

**Multi-file atomic publish + crash-safe rollback [external F3]:** exploding a
skill is a multi-object write (N content objects + N `skill_files` rows + a
`skill_versions` row + `skills.latest_version` bump). The existing per-file
create commits each object individually — insufficient. Design:
1. Preallocate every content-object ID and insert its
   `pending_skill_content_rollbacks` intent **before the corresponding external
   object write** (batching all intents in one transaction before any writes is
   also valid). This closes the object-written/intent-not-recorded crash window.
2. Write the objects to the private namespace. An object-write failure leaves
   its already-recorded intent for immediate/best-effort cleanup and the startup
   sweep.
3. Commit `skill_versions` + all `skill_files` + the `skills` upsert **and delete
   the matching rollback intents in the SAME SQLite transaction**. Metadata
   publication and intent retirement are one atomic state transition; a crash
   can neither orphan an unpublished object nor let the sweep delete published
   content.
4. On failure before publish, sweep the still-present intents (mirrors the
   existing `pending_internal_snapshot_create_rollbacks` ordering in
   `sessions/service.ts:851-875`).
Delete uses a symmetric **`pending_skill_content_deletes`** outbox: insert every
object ID into the outbox in the **same transaction** that deletes the
`skill_files`/`skill_versions` rows, recomputes `latest_version`, and (when
applicable) deletes the owner. Object reclamation happens afterward via the
retryable startup/runtime sweep.

### D2 — Custom upload = the Skills resource; body-limit + zip safety

Uploads go to `/v1/skills` (not Files) [Doc]. Multipart is already supported in
OMA's Hono stack (`files/routes.ts:129`), **but four concrete transport gaps
(review: Sonnet r1 + r2, Codex-adv r2):** (1) repeated `files[]` needs
`req.parseBody({ all: true })` or Hono keeps only the last file; (2) the `files/`
bodyLimit is 24 MiB and the global default is 1 MiB with a bypass only for
`POST /v1/files` (`app.ts` body-limit middleware) — **the skills route needs its
own larger `bodyLimit` constant AND a global-limit bypass**, or a 30 MB upload is
rejected at the transport layer before validation runs. (3) **Reserve an
`AdmissionLimits` in-flight upload slot BEFORE `bodyLimit`** — the files route
does this deliberately (`files/routes.ts:23-38`, `admission.ts` `InFlightGauge`)
because `bodyLimit` eagerly buffers the whole body when `content-length` is
absent; skipping it lets N concurrent large uploads buffer 30 MB each (a
buffering-DoS worse than files' 24 MiB). (4) **Register `/v1/skills` in the route
classifier** — add it to `isManagedAgentsRoute` / `routeClassForPath` (v1 class)
/ `hasRequiredBeta` (`skills-2025-10-02`) in `app.ts`, or the route falls outside
auth/beta/metrics classification and behaves inconsistently with every other
`/v1` endpoint. Slice 1 has an explicit task + tests for the classifier, the beta
gate, the body-limit bypass, and the admission gate.

**Zip parser [OMA — the repo has no zip dependency today; review round 3-4,
external F4]:** add **`yauzl@3.4.0`** (exact pin), a vetted streaming zip
reader that inspects entries WITHOUT auto-extracting. Mandate its security-
relevant usage (npmjs.com/package/yauzl): `lazyEntries: true` (process entry by
entry, never inflate the whole archive); reject entries whose
`compressedSize`/`uncompressedSize` breach the bomb caps BEFORE opening a read
stream; **reject encrypted entries** (`generalPurposeBitFlag & 0x1`); inspect the
Unix mode in `externalFileAttributes` and **reject non-regular-file/dir types**
(symlink `0xA000`, device, fifo); cap **observed** decompressed bytes per entry
as the stream flows (defend against a lying header); and `close()`/destroy on any
error. No zip-*builder* is needed — content is exploded and stored per-file,
never re-zipped.

Upload → explode pipeline, layered (all at upload, streaming through yauzl —
nothing deferred to materialize time):
- **Request-size parity [Obs, probe 56b]:** reject > **30 MB** request with HTTP
  **413** `request_too_large` and the hosted message, at the dedicated bodyLimit
  BEFORE parsing.
- **Zip-bomb guards [OMA defaults]:** total-uncompressed ≤ 100 MB, **per-file
  ≤ 20 MiB** (aligned to the storage cap, D1 — NOT 25 MB), file-count ≤ 500,
  enforced incrementally as yauzl streams each entry (abort on breach — never
  inflate the whole archive first).
- **Hostile-entry rejection (review: Fable + External + Codex-adv):** reject any
  entry whose type is not a regular file or directory (**symlink/hardlink/device
  → reject**), or whose name has `..`, absolute path, leading `/`, backslash,
  NUL, duplicate-normalized, or case-fold collision. Upload-time rejection.
- **Layout [Obs, probe 56b]:** require exactly one UTF-8 `SKILL.md` under a
  **single top-level folder** — root-level SKILL.md rejected (400), matching
  hosted; reject multi-folder or missing. Also accept the path-qualified
  individual-`files[]` form and normalize it to the same per-file records.
- **SKILL.md naming rules:** port the `skills-ref` validator rules (`name`
  ≤64/`[a-z0-9-]`/no leading-trailing-consecutive hyphen/reserved
  `anthropic`,`claude` forbidden; `description` ≤1024). **Enforce name ==
  directory** — hosted 400s a mismatch (probe 56b) — so the mount root is
  unambiguous (D8). `display_title` derives from `name` when omitted [Obs].
- **Then explode:** write each validated entry as a private
  `SkillContentRecord` (D1); publish the owner/version/manifest through D1's
  staged-object protocol. The uploaded archive is discarded after explode —
  nothing stores it.

### D3 — Prebuilt (`anthropic`) skills: LICENSING BLOCKER — do not vendor

**Blocking (review: External).** Anthropic's document skills (`xlsx/docx/pptx/
pdf`) are **source-available, not open source** — the
[license](https://github.com/anthropics/skills/blob/main/skills/docx/LICENSE.txt)
prohibits retaining, reproducing, distributing, sublicensing, and derivatives.
OMA is a distributable repo, so **vendoring them is impermissible**, and they are
executable scripts + env deps, not "inert data."

**Decision [OMA]:**
- Drop the vendored anthropic catalog from v1. Meet the exit criterion with an
  **OMA-owned example skill** (Apache-2.0, authored in-repo, e.g. a trivial
  "hello-skill" whose SKILL.md instructs a bash echo).
- Hosted `anthropic`-catalog *parity* (surfacing `xlsx/…` in ListSkills, resolving
  `type:"anthropic"` attaches) is **deferred** pending an explicit redistribution
  arrangement. Until then, `type:"anthropic"` attaches are rejected with a clear
  "anthropic prebuilt skills are not available on this deployment" 400 [OMA].
- The custom-upload end-to-end path (not prebuilt parity) is the milestone.

### D4 — Session skill snapshot: resolve to immutable versions at create

**New (review: External + Fable — reproducibility).** OMA does not retain
historical agent versions, and skills are delete-only + mutable via new versions.
Resolving `agent.skills` live at runtime (or after a restart/eviction) would run
different content than the session started with, or fail after deletion.

**Decision [OMA] — COPY per-file into the session snapshot, adapting the private
content store to the existing snapshot machinery (review round 2: Opus + Sonnet;
rounds 3-5, external: made concrete).** D1 exposes an internal-only byte stream
for each `SkillContentRecord`. At session create, resolve each attached skill to
a concrete `(skill_id, version)`, open each private record, then **copy it into a
session-scoped internal snapshot** via
`createInternalSnapshot` — the same call `prepareFileResources` uses
(`sessions/service.ts:849-890`), now a genuine fit (per-file, not a 30 MB
archive against the 20 MiB single-file cap). Consequences:
- reproducibility holds (restart/evict-recreate materialize from the snapshot;
  recovery reads snapshot rows, never the agent store — `createFileMountResolver`
  `wiring.ts:59-94`, recovery `runner.ts:655-658`);
- the SkillsStore records are **freely deletable** — no refcount/GC/session-end
  trigger;
- **crash-safety + cleanup reuse the existing outbox as-is** — the
  `pending_internal_snapshot_deletes` / `…_create_rollbacks` rows are file-shaped
  (`resource_id, file_id, mount_path`, `sessions/store.ts:60-72`), which now
  matches because skill snapshot entries ARE file mounts (kind `"skill"`, D8),
  not a bespoke archive. Session deletion promotes them through the same path.
`"latest"` is resolved **once, at session create**.

**Snapshot association + kind persistence [external F5].** The existing
`session_file_mount_snapshots` row has no `kind`/`skill_id`/`version`, so after a
restart, recovery cannot tell a skill mount from an upload mount, nor which skill
a file belongs to. Add:
- a **`kind` column on the snapshot mount rows** (persisted, read by recovery so
  it re-materializes each mount to the right root — D8);
- a **`session_skill_snapshots` grouping row** (`workspace_id, session_id,
  skill_snapshot_id, skill_id, version, name, description`), plus nullable
  **`skill_snapshot_id` on every `session_file_mount_snapshots` row** belonging
  to that skill. The grouping row owns the one-to-many association the loader
  and recovery path need; upload mounts keep it `NULL`.
Insert the session row, grouping rows, and all file-snapshot rows in the same
session-create transaction. On session deletion, first promote every file row
to `pending_internal_snapshot_deletes`, then delete file rows and grouping rows
in that same transaction (FK from file row to grouping row; restrict during the
promotion/delete transaction, cascade is not relied on for object cleanup).
The ResourceLoader (D5) reads name/description from this join and points
`filePath` at the materialized container path; bytes come from the snapshot's file
entries. Nothing reads the live store at runtime.

### D5 — Advertising to Pi: custom synthetic `ResourceLoader` (RESOLVED)

**Confirmed against pinned Pi 0.80.6 by three independent source reads (Opus,
Fable, External).** Wire a **fully custom `ResourceLoader`** into
`createAgentSession` (`runner.ts:969`; today it passes none, so Pi's
`DefaultResourceLoader` would scan the host cwd — wrong). Requirements:
- Implement **all 9 `ResourceLoader` methods** (`resource-loader.d.ts:24-48`).
  The non-skill methods return empties **except `getExtensions()`** (review
  round 2: Opus) — a bare `{extensions:[]}` **crashes at construction**
  (`agent-session.js:1884-1890` builds an `ExtensionRunner` from a real
  `ExtensionRuntime`). Return a structurally-complete `LoadExtensionsResult` via
  the exported `createExtensionRuntime()` (`extensions/loader.js:119`), **or**
  delegate the non-skill methods to an internal
  `DefaultResourceLoader({ noSkills:true, noExtensions:… })`. Name the factory in
  code; do not hand-roll empties.
- `getSkills()` returns one entry per **snapshotted** skill (D4) — name/description
  from the snapshot, `filePath = /workspace/skills/<name>/SKILL.md`, `baseDir =
  /workspace/skills/<name>` (deref'd at `agent-session.js:853`).
  `formatSkillsForPrompt` emits `filePath` into `<location>` with **no host read**
  — progressive disclosure via the container `read` tool.
- **Do NOT use `additionalSkillPaths`/`DefaultResourceLoader` for skills** (all
  four reviewers) — those do host-side `existsSync`+`readFileSync` (`skills.js:368`)
  and would drop container paths.
- **Named limitation [OMA]:** Pi's `/skill:<name>` explicit-invocation path does a
  host-side `readFileSync(filePath)` (`agent-session.js:851`), reached only when a
  user message literally starts with `/skill:` (not every `followUp`). Under
  container-only paths it errors and passes the text through unexpanded (graceful
  no-op). So **`/skill:` explicit invocation is unsupported under OMA**; only
  model-driven discovery works. Non-goal below.

### D6 — Read-tool coupling at session-create; one shared policy evaluator

Reject a session whose effective (root-agent) config has non-empty skills but the
`read` tool absent or denied, with the verbatim hosted message: *"Missing
required tool: skills require the read tool to be usable (enabled and not
always_deny) on the session's `agent_toolset`"* [Obs].

Two implementation constraints (review: Sonnet r1 + r2):
- **One evaluator, mandated refactor.** Only lines 500-501 of
  `createStoreBackedBuiltinToolAccessResolver` (`tool-permissions.ts:495-522`) are
  session-scoped (session→agentId); the config→access computation (`:505-521`) is
  a pure function of the agent. Extract `resolveBuiltinToolAccessForAgent(agent,
  toolName)` and **rewrite the existing resolver to call it internally** (not two
  parallel call sites that merely start identical); session-create validation
  calls the same helper. (The chicken-and-egg is soft: the resolver already has a
  `context?.agentId` fallback (`:501`) and `retrieveAny` returns `undefined` not
  throw — so the pure factoring is the clean fix, not a hard prerequisite.)
- **State mapping:** hosted `always_deny` ≈ OMA `never_allow` → `deny`
  (`tool-permissions.ts:527-530`); rule = `enabled && permission !== "deny"`.
  Reuse the existing literal; do not add a new one.

### D7 — Attachment validation hardening (root agent)

In `skillArrayField` (`agents/service.ts:246`): `type ∈ {anthropic, custom}`;
duplicate-`skill_id` → 400 with the hosted-shaped message [Obs]; a **20-cap per
agent** (mirror `MAX_MCP_SERVERS`, `service.ts:264-277`) with an OMA-chosen
message; custom `skill_id` existence against the SkillsStore; `anthropic`
attaches rejected while the catalog is deferred (D3). Cross-reference asserts
mirror MCP's (`service.ts:344-372`). Cap is per the root agent's own list (§2.2
scope); cross-agent aggregation is deferred.

**Version resolution [Obs, probe 58]:** agent-create resolves an explicit
`version` (or `"latest"` when omitted) and rejects a missing version with the
hosted error shape. Session-create resolves every attachment again, because a
version may have been deleted after the agent was stored; a missing version is
rejected with `Could not resolve one or more skills: skill "…" version "…" not
found`. Slice 3 reuses this admission boundary while copying the resolved bytes
into the durable session snapshot.

### D8 — Discriminated mount contract + skill mount root

**Rewritten for a concrete, safe contract (review: Codex-adv + Opus + External +
Fable).** `RuntimeSessionFileMount` gains an **internal, non-public**
`kind: "upload" | "skill"` discriminant; the destination root is derived from
`kind` in the sandbox impl and **never from session/public input**:
- `upload` → `uploadsPath` (`/mnt/session/uploads`), unchanged.
- `skill` → `/workspace/skills` (rw,exec — required, since skill `scripts/` are
  meant to run; uploads is `noexec` AND outside `/workspace`, so it is genuinely
  unusable for skills — the generalization is mandatory, not stylistic).
Because D1 stores skills as per-file records, **materialization is the existing
`materializeFileResources` per-file path** (`docker.ts:360-393`) — each skill
file is a `RuntimeSessionFileMount` with `kind:"skill"` and `mountPath` under the
skill root, delivered by the same tar→extract→normalize. The pipeline runs **once
per distinct root** (Opus — group mounts by `kind`, extract + normalize each
root: `uploadsPath` for uploads, `/workspace/skills` for skills). Generalize the
uploads-hardcoded steps in `docker.ts` (guard, extract destination,
chown/normalize) and the microsandbox impl, each keyed by `kind`. Also:
- **Mount `/workspace/skills` as its own `--tmpfs`, explicitly sized** (review
  round 2: Opus + Fable; round 3, external F3). Owning the *directory contents*
  root-owned is not enough: `/workspace` is the sandbox user's writable tmpfs
  (`docker.ts:722`, uid 65534, 0700), so it can `mv /workspace/skills aside`. A
  dedicated tmpfs **mountpoint** cannot be renamed/unlinked by the sandbox user.
  Use a fixed **64 MiB skills tmpfs**: the runner creates the sandbox before it
  resolves mounts (`runner.ts:645-658`), so per-session dynamic sizing would
  require an unnecessary preparation-order refactor. The shared 50 MiB content
  ceiling leaves 14 MiB for filesystem metadata/headroom. **Microsandbox
  asymmetry:** its normalize is `chmod 444` only, no `chown`-to-root and no tmpfs
  seam (`microsandbox.ts:881`) — the tamper-proof property is Docker-only in v1;
  a noted per-provider limitation.
- **Materialized-size admission — SHARED budget + memory headroom [external F3 +
  F7].** Upload guards bound one version (≤100 MB); they do NOT bound what a
  *session* unpacks (20 skills × 100 MB = 2 GB into a 64 MiB tmpfs). The existing
  `MAX_SESSION_MOUNTED_BYTES = 50 MiB` (`sessions/service.ts:56`) is the budget —
  but it must be **shared across uploads + skills**, not 50 MiB each: at session
  create, sum file-mount `total_bytes` + snapshotted skills' `total_bytes` and
  reject the combined total over budget. The fixed skills tmpfs is a **fourth
  tmpfs**, so
  `assertTmpfsMemoryHeadroom` (`docker.ts:685`, today validates uploads + outputs
  against `--memory`) must add the skills tmpfs to its sum, or container start
  fails or over-commits memory. Extend that assert; a headroom test pins it.
- **Executable bit is SET by path, not "preserved"** (review round 2: Opus —
  host temp files are `0644`, there is no bit to carry). A skills-specific
  normalize sets `scripts/*` → `0755`, `SKILL.md`/refs → `0644`, contents
  root-owned.
- Path guards reject `..`/absolute (already present, `docker.ts:1033`); the
  `name`==`directory` rule (D2) is a second layer.
- **No atomic-rename mechanism needed** (review round 2: Opus). The container is
  **disposed on any materialize failure** (`docker.ts:374-376`), so create /
  evict-recreate always start from a fresh container — a half-populated
  `/workspace/skills` cannot survive into a live session. Drop the earlier
  temp-dir→rename requirement; a mixed upload+skill mount test still pins both
  roots and the dispose-on-failure path.

### D9 — Uniqueness, quota domain, lifecycle

(Uniqueness, atomicity, and rollback are specified in D1. This decision covers
the quota domain and the version-lifecycle edges.)
- **Separate quota domain [external F4].** Because skill content lives in the
  dedicated `SkillContentStorage` (D1), NOT the `files/` store, its bytes do
  **not** count toward `MAX_WORKSPACE_FILE_BYTES` (100 MiB) — a `SkillContentStorage`
  workspace-bytes accountant enforces its own `OMA_SKILLS_WORKSPACE_MAX_BYTES`
  default **1 GiB**, and a per-skill retained-version cap `OMA_SKILLS_MAX_VERSIONS`
  default **20**. Session snapshot copies do not count against the skills quota,
  but they **do** use the existing FileStorage workspace quota and are reclaimed
  on session **DELETE** (not merely idle/terminated/archive), matching current
  file-mount snapshot semantics. Operators must delete retained sessions to
  reclaim those copies.
- **Delete-latest-version [external F6]:** deleting the version a skill's
  `latest_version` points at **recomputes `latest_version` from the newest
  remaining version** in the same transaction. Deleting the sole version sets
  `latest_version: null`, an explicit empty state that preserves the observed
  version-first-then-skill delete sequence without leaving a dangling pointer.
  A `version:"latest"` lookup returns not-found while the pointer is null.

## 5. Slice order (each testable in isolation)

0. **Probes 56/57 — DONE** (57 re-run 2026-07-10 with auditable capture).
1. **Skills resource + store** (D1, D2, D9). Dedicated **private
   `SkillContentStorage`** + `skills`/`skill_versions`/`skill_files` tables +
   the staged-commit / rollback + delete outbox ledgers (D1); `/v1/skills`
   multipart upload → **pinned-`yauzl` explode-and-validate → private per-file
   store**, with the **route/beta classifier + body-limit bypass + admission gate**
   (D2), `parseBody({all:true})`, layered 30 MB/bomb(≤20 MiB per file)/hostile-entry
   validation, SKILL.md parse + name==dir + owner-table name/display_title
   uniqueness, versioning, list/get/delete, delete-only + latest-recompute,
   separate 1 GiB quota. **Custom-only** — independent of sessions and of the
   anthropic catalog (D3 deferred), so slice-1 parity tests do NOT assert
   prebuilts. This is the milestone path.
2. **Attachment validation** (D7) + **session-create read-tool coupling** (D6,
   the shared pure evaluator). Root-agent scope only.
3. **Session skill snapshot + runtime delivery** (D4 copy-snapshot + D8 + D5):
   copy the skill's per-file records into a session snapshot at create + enforce
   the materialized-size budget → materialize at `/workspace/skills/<name>/` via
   the discriminated per-file mount (sized `--tmpfs`, root-owned, path-based
   exec bits) → custom ResourceLoader → wire into `createPiSession`
   (`runner.ts:969`).
   **Implemented on `arc-skills` (slice 3):** concrete-version copy snapshots,
   persisted kind/grouping metadata, shared upload+skill byte admission,
   Docker/microsandbox skill materialization, and synthetic Pi ResourceLoader
   delivery are test-pinned including real Docker permission behavior.
4. **Live smoke 58** (the exit criterion): OMA end-to-end with an **OMA-owned
   Apache example skill** — agent + attached skill → session → model `read`s
   `/workspace/skills/<name>/SKILL.md` (assert via the bash/read tool_result, per
   probe 57's method) and uses it; event vocabulary unchanged; a leak sweep whose
   "intended" surface is explicitly defined (D-trust below).
   **Completed as smoke 59** (`scratch/59-skills-live-smoke.ts`): real Docker,
   real model `read` + `bash` tool evidence, source-version deletion before the
   turn, no new event vocabulary, host-secret/egress leak sweep, non-writable
   files, immovable mountpoint, and verified container cleanup. Raw evidence is
   persisted under `scratch/artifacts/59-skills-live-smoke.json`.
5. **Deferred, named:** anthropic prebuilt catalog (pending redistribution — D3);
   `agent_with_overrides` + multi-agent cap aggregation (§2.2); console
   browsing/upload (mirrors plan 0125).

## 6. Test plan (highlights beyond per-slice units)

- Wire parity: CreateSkill multipart→exact response shape; version object incl.
  `directory` + microsecond version string; ListSkills envelope; delete-only 400
  then version-first success.
- Upload safety: dedicated bodyLimit accepts 30 MB / global bypass; `parseBody
  {all:true}` keeps every `files[]`; bomb guards (oversized total/file/count);
  **zip-slip battery** (`..`, absolute, backslash, NUL, symlink, dup-normalized,
  case-fold); missing/duplicate/non-UTF-8 SKILL.md; multi-folder; name≠dir;
  name-collision across skills/versions; concurrent same-name upload race;
  atomicity (intent exists before every object write; object-write failure →
  swept intent; crash before publish → no orphan; crash after publish → committed
  metadata and no rollback intent); delete-outbox insertion is atomic with
  version deletion/latest recomputation.
- Validation: bad type, unknown custom id, duplicate skill_id, 20-cap per agent,
  `anthropic`-attach-rejected-while-deferred, and the session-create
  read-tool-coupling 400 with the **verbatim** message (via the shared evaluator);
  bogus explicit version rejected at agent-create and deleted-latest rejected at
  session-create (probe 58).
- Snapshot/repro: `"latest"` resolved at create; a new version uploaded
  mid-session does not change the running session; a version deleted after
  snapshot still materializes from snapshot bytes; restart + eviction/re-create
  materialize identical content from the manifest; grouping-to-file association
  and `kind` survive restart; session DELETE promotes every skill file to the
  existing cleanup outbox before deleting grouping rows.
- Runtime: discriminated mount lands skills at `/workspace/skills`, uploads at
  `/mnt/session/uploads` (mixed-mount test); `scripts/*` executable, `SKILL.md`
  0644, root-owned; shared 50 MiB boundary fits the fixed 64 MiB skills tmpfs;
  the fourth tmpfs participates in memory-headroom validation;
  partial-materialization failure rolls back; smoke 58 proves
  read via tool_result; no new event types emitted.

## 7. Non-goals (v1)

- **Anthropic prebuilt catalog** — deferred on the licensing blocker (D3).
- **`agent_with_overrides` + multi-agent** skill attach/cap-aggregation (§2.2).
- **`/skill:<name>` explicit invocation** — unsupported under the host↔container
  split (D5); only model-driven discovery works.
- Enforcing `allowed-tools` (advisory; hosted/SDK don't — §0).
- Skill *execution engine* — the model runs scripts via bash; OMA only provisions.
- Custom-skill console UI (deferred).
- Memory-store / GitHub-repo resources (separate `resources` surface).

## 7a. Trust model (review: Fable)

Skills are **operator-trusted admin uploads**, not attacker-controlled content: a
SKILL.md body is model-directed instructions injected into the system prompt AND
its `scripts/` run in the sandbox — an uploaded skill is, by design, a
prompt-shaping + sandbox-code channel. This is acceptable because upload is
gated by workspace auth and skills are the operator's own; it is NOT a boundary
against a hostile skill author. Slice-4's leak sweep defines "intended surface"
as: the skill's own files under `/workspace/skills/<name>` — and asserts NO
workspace **secrets/vault/egress** material leaks through skill materialization,
and that skills are **not replaceable by the sandbox user** via the dedicated
`--tmpfs /workspace/skills` mountpoint (D8; Docker-only in v1 — microsandbox is a
noted per-provider limitation). Skill scripts inherit the session's existing
egress/secret posture (they run as ordinary sandbox bash — no new exposure, no
special grant). "Whatever the model chooses to surface from its own inputs" is
out of scope for the leak assertion (operator-trust boundary above).

## 8. Reusable seams (file:line — verified)

| Need | Seam | Anchor |
|---|---|---|
| Resource store pattern | `files/` trio + backends | `src/control-plane/files/{store,service,types,routes}.ts` |
| Attachment already stored | agent `skills` column | `agents/store.ts:20,127,228`; `types/agents.ts:58-62` |
| Attachment validation template | `MAX_MCP_SERVERS` + cross-ref asserts | `agents/service.ts:246,264-277,344-372` |
| Deliver files to container | `materializeFileResources` | `sandbox/provider.ts:64`; `docker.ts:360`; called `runner.ts:655-663` |
| Mount-root guard to generalize | `assertInsideUploadsPath` | `docker.ts:368,1033` |
| Advertise skills to Pi | `createAgentSession` call (no loader today) | `runner.ts:969` |
| Read-tool coupling enforcement | tool permissions (factor a pure evaluator) | `sessions/pi/tool-permissions.ts:495-522,527-530` |
| Session snapshot copy machinery | `prepareFileResources` + internal snapshot + durable retry-queue tables | `sessions/service.ts:849-890,189,445,726-745`; `sessions/store.ts:52-96` |
| Upload admission gate | in-flight upload reservation before bodyLimit | `files/routes.ts:23-38`; `admission.ts` `InFlightGauge` |
| Wiring/lifecycle pattern | MCP store-backed provider | `mcp/bridge.ts:472`; consumed `runner.ts:668` |
| Body-limit + bypass to mirror | files upload bodyLimit + global bypass | `files/routes.ts:15,42-48`; `app.ts` body-limit middleware |
| Session-scoped snapshot precedent | file-resource snapshotting | `sessions/service.ts` `prepareFileResources` |
| Session agent shape (no overrides today) | `agentField` | `sessions/request.ts` (`agent: string \| {type:"agent"}`) |

## 9. Open questions — remaining [Unk]

Probe 56b (2026-07-10) closed most of the wire unknowns — root-zip rejected,
name==directory enforced, per-file multipart accepted, derived/duplicate
`display_title`, the 30 MB→413 cap, and referenced-skill deletion are now
**[Obs]** and folded above. Remaining:

1. **20-cap over-cap error message** (slice 2) — needs 21 *distinct* skill_ids;
   OMA picks its own message, parity probe optional.
2. **ListSkills pagination semantics** (slice 1) — probe 56b recorded `limit=1`
   → `has_more=false`, `next_page=null` (the probe did not capture the returned
   `data` length or the account's skill count, so "unexpected" is inferred, not
   evidenced). Hosted paging behavior is unclear; low-stakes since OMA implements
   its own cursor. A parity probe if wire-exact paging is wanted.
3. **`anthropic` catalog** (deferred) — resolution/versioning only relevant once
   a redistribution arrangement unblocks D3.

## 10. Review log

- **Research + probes (2026-07-10):** 4 subagent threads + 3 live hosted probes
  (56 wire, 57 execution w/ auditable re-run, 56b wire-unknowns). Probe 56b
  closed root-zip/name==dir/per-file/display_title/30 MB-413/referenced-deletion.
- **Adversarial panel (2026-07-10):** Codex-adversarial, Sonnet, Opus, Fable +
  one independent external review. Folded into this revision:
  - **Blocker:** anthropic doc-skill licensing → D3 rewritten (deferred, use an
    OMA-owned example).
  - **Scope:** `agent_with_overrides`/multi-agent don't exist in OMA → §2.2 +
    D7 narrowed to the root agent; overrides/aggregation named as later parity.
  - **Reproducibility:** no agent-version history → D4 session skill snapshot.
  - **D5 resolved** against pinned Pi 0.75.4 (three source reads): custom
    9-method ResourceLoader, container path, no host staging, `additionalSkillPaths`
    dropped, `/skill:` documented unsupported.
  - **D6:** chicken-and-egg + `always_deny`→`never_allow` mapping → shared pure
    evaluator, agent-only helper.
  - **Storage/upload:** raw-zip-blob shape (D1), bodyLimit + `parseBody{all:true}`
    + layered limits (D2), quota/atomicity/reclamation (D9).
  - **Security:** discriminated `kind` mount + exec-bit + root-owned + rollback
    (D8), zip-slip battery (D2), name-uniqueness (D9), trust model (§7a).
  - **Evidence hygiene:** four-way [Obs]/[Doc]/[OMA]/[Unk] labeling; corrected
    docx/pdf-unobserved and the 20-cap/`across-all-agents` overclaims; re-ran
    probe 57 for auditable tool-output evidence.
  - **Confirmed-solid (kept):** two-layer split, `/workspace/skills/<name>/`,
    progressive disclosure via custom loader + container `read`, provision-not-
    execute, read-tool coupling at session-create, no new event vocabulary,
    `allowed-tools` advisory, D8 mount-root premise, files/ store pattern.
- **Panel round 2 (2026-07-10):** re-review of the folded plan by the same four +
  a probe-56b re-run. Verdict: implementation-ready modulo a bounded fix set (no
  blockers, no redesign) — three source reads re-confirmed the Pi 0.75.4 claims,
  D4-recovery-reads-snapshot and D6-evaluator-factorable confirmed. Folded:
  - **Honesty (unanimous):** the name==directory enforcement was asserted from a
    manual call, not the committed artifact → **re-ran probe 56b with the
    `name_dir_mismatch` case**; the exact 400 message is now in the artifact.
    Softened the §9.2 pagination framing; relabeled the anthropic date-version to
    [Obs]; fixed anchor drifts (`baseDir` deref at `agent-session.js:853`;
    `always_deny`→`deny` at `tool-permissions.ts:527-530`).
  - **Storage keystone:** D4/D9 → **copy-snapshot** (copy the skill's content into
    a session-scoped internal snapshot at create — round 2 said "the blob"; round 3
    below refined this to per-file), reusing the existing durable retry-queue
    tables. Collapses the D4↔D5 source contradiction, retention/session-end
    semantics, crash-safe durability, and quota-reclamation into proven machinery.
  - **Upload:** added the pre-`bodyLimit` **admission in-flight gate** (buffering
    DoS) and the **`/v1/skills` route/beta classifier + body-limit bypass** as an
    explicit slice-1 task (D2).
  - **Mechanism:** D5 `getExtensions` must return a real `ExtensionRuntime`
    (`createExtensionRuntime`) or delegate to `DefaultResourceLoader` — a bare
    empty crashes at construction; D6 mandates rewriting the resolver to call the
    pure helper; D8 simplified (drop atomic-rename — container-dispose-on-failure
    covers it; path-based `0755` not "preserve"; per-root loop; **`--tmpfs
    /workspace/skills`** for real non-writability; microsandbox tamper-proofing a
    noted per-provider gap); D9 quota defaults named (1 GiB / 20 versions).

- **External storage review (round 3, 2026-07-10):** a second independent lane
  found a bounded gap cluster in the storage/materialization layer that both
  panel rounds under-stressed — verified against code and folded (rev 4):
  - **D1 flipped from raw-zip-blob → explode-and-validate per-file at upload.**
    This realigns snapshot (D4), materialization (D8), and the cleanup outbox to
    the existing **per-file** machinery, dissolving three findings at once: the
    zip-to-directory materialization gap (no bespoke unzip path), the 20 MiB
    internal-snapshot cap (applies per-file, not to a 30 MB archive), and the
    file-shaped outbox tables (now a genuine fit).
  - **Materialized-size admission (F3):** upload caps bound one version, not a
    session's total unpack — added an aggregate uncompressed skill budget
    (reuse `MAX_SESSION_MOUNTED_BYTES`) and sized the skills `--tmpfs` to it
    (default `/workspace` tmpfs is 64 MiB).
  - **Zip parser (F4):** `yauzl` chosen — streaming, no auto-extract, the right
    primitive for hostile-entry defense (the repo had no zip dep).
  - **Owner-vs-version schema (F6):** name/`display_title` uniqueness on the
    `skills` owner table, not version rows (a 2nd version must not self-collide).
  - **F7:** corrected the probe-56 `.md` docx/pdf overclaim to xlsx+pptx-observed.
  - Endorsed sound: wire contract, licensing, read-tool coupling, custom Pi
    loader, dedicated-mountpoint defense.
- **External storage review (round 4 → rev 5, 2026-07-10):** the second storage
  lane found that the rev-4 "reuse the `files/` per-file machinery" was still
  analogy, not a contract. All 7 verified against code and folded — D1 rewritten
  as a **dedicated storage contract**:
  - **Private store (F2):** skill content goes to a new `SkillContentStorage`, NOT
    `FileStorage.create()` (which yields public `/v1/files` records).
  - **Aligned caps (F1):** per-file cap 20 MiB (was 25) to match
    `MAX_UPLOADED_FILE_BYTES`, so a valid upload can't fail the snapshot copy.
  - **Multi-file atomicity (F3):** staged-object + `pending_skill_content_rollbacks`
    ledger + single-txn publish + delete outbox (mirrors the existing internal-
    snapshot rollback pattern) — no orphan objects, no partial versions.
  - **Quota domain (F4):** skills bytes are their own 1 GiB accountant, not the
    shared 100 MiB `MAX_WORKSPACE_FILE_BYTES`.
  - **Snapshot association (F5):** persist `kind` on snapshot mount rows +
    a `session_skill_snapshots` join, so recovery re-materializes to the right root.
  - **Shared budget + memory (F7):** the 50 MiB mounted budget is shared across
    uploads+skills, and the new fourth `--tmpfs` is added to `assertTmpfsMemoryHeadroom`.
  - **Delete-latest (F6):** recompute `latest_version` from the newest remaining.
  - **yauzl usage contract:** pinned version + lazy entries, header-size + observed-
    byte caps, encrypted-entry + non-regular-type rejection, error cleanup.
  - **Honest note:** two consecutive storage reviews each found a fresh gap set,
    because the storage layer was specified by analogy. Rev 5 replaces the analogy
    with a designed contract; a focused storage-only review (or building slice 1
    behind tests, which surfaces impedance faster than plan review) is the
    recommended close before green-light.

*(The independent external reviews (Appendix A + the two storage lanes) are folded
into this log and the D-decisions; raw text preserved in PR 174 history.)*
