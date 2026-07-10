# Plan 0126 — Skills: `/v1/skills` resource + runtime execution

Date: 2026-07-10
Parent: [appliance product roadmap](0114-appliance-product-roadmap.md) —
capability track item 2 ("skills execution"), the remaining half of the
capability exit criterion now that MCP (0122 M1–M3) has shipped.
Grounded in: 4 research threads (Pi runtime, hosted wire, OMA current state,
prior art) + 2 live hosted probes (56 = `/v1/skills` wire, 57 = execution
trace). Probe artifacts: `scratch/artifacts/56-…json`, `…57-…json`.

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
  **[Obs]** a zip under a single top-level folder + explicit `display_title` → 200
  `{ id: "skill_…", display_title, latest_version, source: "custom",
  type: "skill", created_at, updated_at }`; wire discriminator is
  **`type: "skill"`**, `source ∈ {custom, anthropic}`. **[Doc]** also accepts a
  root-level SKILL.md zip, path-qualified individual `files[]`, and derives
  `display_title` from SKILL.md when omitted; ≤30 MB total; `display_title`
  unique among workspace custom skills. **[Unk]** root-zip acceptance,
  per-file multipart, derived/uniqueness of `display_title`, the 30 MB boundary
  — none exercised by probe 56 (§9).
- **Version object** **[Obs]** `{ id: "skill_version_…", skill_id, version, name,
  description, directory, type: "skill_version", created_at }`. `name`/
  `description` parsed from SKILL.md; **`directory`** = the zip top-level folder
  (probe 56 sent name==directory, so their independence is **[Unk]**). Custom
  `version` = **microseconds-since-epoch string** (16 digits; e.g.
  `1783682001075540` = 2026-07-10T11:13:21.075540Z) **[Obs]**; anthropic =
  date string (`"20260203"`) **[Doc]**; both accept `"latest"` **[Doc]**.
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
  entities — agents/sessions/envs — archive). Referenced-skill/version deletion
  behavior is **[Unk]** (§9, probe before finalizing lifecycle).

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
  same path from `find`. Because the probe used name==directory, whether the
  mount uses frontmatter `name` or the zip `directory` is [Unk]; **OMA sidesteps
  it by enforcing name==directory at upload (D2) and mounting at
  `/workspace/skills/<name>/` [OMA].**
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

### D1 — Storage: new `SkillsStore`; store the raw zip blob per version

The skill *reference* (`{type, skill_id, version}`) already lives on the agent
row (`agents/store.ts:20`). The gap is skill *content*. Add a `SkillsStore`
(interface + sqlite/blob impl + service + routes), patterned on
`src/control-plane/files/` for the *trio/backends shape* — **but note `files/`
models one file per record** (`FileStorageRecord`, single `UploadedFileInput`;
review: Sonnet), whereas a skill is N files per (skill_id, version).

**Decision [OMA]: store the validated raw zip blob per version, unzip lazily at
materialize time.** Rationale: (a) one blob per version keeps atomicity simple
(one object write + one SQLite row); (b) the manifest + SKILL.md metadata are
parsed once at upload for listing/validation and stored alongside; (c) bomb
guards run at upload against the zip, and again defensively at unzip. Per version
row: `skill_id, version, name, directory, display_title, description,
byte_size, sha256(zip), file_manifest (paths+per-file size+sha256), created_at`,
plus the blob in file storage. `openInternalSnapshotBytes`-style access reads
the blob for materialization.

### D2 — Custom upload = the Skills resource; body-limit + zip safety

Uploads go to `/v1/skills` (not Files) [Doc]. Multipart is already supported in
OMA's Hono stack (`files/routes.ts:129`), **but two concrete gaps (review:
Sonnet):** (1) repeated `files[]` needs `req.parseBody({ all: true })` or Hono
keeps only the last file; (2) the `files/` bodyLimit is 24 MiB and the global
default is 1 MiB with a bypass only for `POST /v1/files` (`app.ts` body-limit
middleware) — **the skills route needs its own larger `bodyLimit` constant AND a
global-limit bypass**, or a 30 MB upload is rejected at the transport layer
before validation runs.

Upload validation, layered:
- **Request-size parity:** reject > **30 MB** compressed request (hosted cap)
  [Doc] BEFORE unzip.
- **Zip-bomb guards [OMA defaults, not carried from prior art — review: Sonnet]:**
  total-uncompressed ≤ 100 MB, per-file ≤ 25 MB, file-count ≤ 500, checked
  incrementally during unzip.
- **Zip-slip / hostile-entry rejection (review: Fable + External + Codex-adv):**
  reject any entry with `..`, absolute path, leading `/`, backslash, NUL,
  symlink/hardlink/device entries, duplicate normalized paths, or case-fold
  collisions. Upload-time rejection — not deferred to materialize time.
- **Layout:** require exactly one UTF-8 `SKILL.md` at the zip root or under a
  single top-level folder; reject multi-folder or missing.
- **SKILL.md naming rules:** port the `skills-ref` validator rules (`name`
  ≤64/`[a-z0-9-]`/no leading-trailing-consecutive hyphen/reserved
  `anthropic`,`claude` forbidden; `description` ≤1024). **Enforce name ==
  directory** (spec rule) so the mount root is unambiguous (D8).

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

**Decision [OMA]: at session create, resolve every attached skill to a concrete
immutable `(skill_id, version, sha256)` and persist a per-session skill
manifest** (a new session-scoped snapshot, alongside the existing file-resource
snapshotting). `"latest"` is resolved **once, at session create**, to the
then-current version. Runtime delivery, restart recovery, and runtime eviction/
re-create all materialize from the **session manifest**, never from the current
store. A version deleted after snapshot remains materializable from the snapshot
bytes (the store must retain blobs referenced by any live session — see D9
reclamation). This makes a session reproducible and decouples it from later
uploads/deletes.

### D5 — Advertising to Pi: custom synthetic `ResourceLoader` (RESOLVED)

**Confirmed against pinned Pi 0.75.4 by three independent source reads (Opus,
Fable, External).** Wire a **fully custom `ResourceLoader`** into
`createAgentSession` (`runner.ts:969`; today it passes none, so Pi's
`DefaultResourceLoader` would scan the host cwd — wrong). Requirements:
- Implement **all 9 `ResourceLoader` methods** (`resource-loader.d.ts:24-48`);
  return empty for the non-skill ones. `AgentSession` calls each.
- `getSkills()` returns one entry per snapshotted skill with name/description
  from the manifest, `filePath = /workspace/skills/<name>/SKILL.md`, and a
  populated `baseDir = /workspace/skills/<name>` (`agent-session.js:853,1702`
  dereference `baseDir`). `formatSkillsForPrompt` emits `filePath` into
  `<location>` with **no host read** — progressive disclosure via the container
  `read` tool.
- **Do NOT use `additionalSkillPaths`/`DefaultResourceLoader`** (review: all
  four) — those do host-side `existsSync`+`readFileSync` (`skills.js:368`) and
  would silently drop container paths. No host staging; no fallback needed.
- **Named limitation [OMA]:** Pi's `/skill:<name>` explicit-invocation path does
  a host-side `readFileSync(filePath)` (`agent-session.js:851`, run on every
  `followUp`), which under container-only paths errors and passes the text
  through unexpanded (graceful no-op, not a crash). So **`/skill:` explicit
  invocation is unsupported under OMA**; only model-driven discovery works. Add
  to non-goals.

### D6 — Read-tool coupling at session-create; one shared policy evaluator

Reject a session whose effective (root-agent) config has non-empty skills but the
`read` tool absent or denied, with the verbatim hosted message: *"Missing
required tool: skills require the read tool to be usable (enabled and not
always_deny) on the session's `agent_toolset`"* [Obs].

Two implementation constraints (review: Sonnet):
- **Chicken-and-egg:** the existing resolver
  (`createStoreBackedBuiltinToolAccessResolver`, `tool-permissions.ts:495-521`)
  looks up an *existing* session row to find the agent — unavailable during
  session-create validation. **Factor the toolset-config→permission logic
  (`:513-521`) into a pure agent-only helper** callable from `sessions/service.ts`
  before the row is inserted. Runtime and validation must call the **same pure
  evaluator** so decisions cannot drift.
- **State mapping:** hosted's `always_deny` ≈ OMA's `never_allow` policy →
  `deny` permission (`tool-permissions.ts:16,527-530`). Reuse the existing
  literal; do not add a new one.

### D7 — Attachment validation hardening (root agent)

In `skillArrayField` (`agents/service.ts:246`): `type ∈ {anthropic, custom}`;
duplicate-`skill_id` → 400 with the hosted-shaped message [Obs]; a **20-cap per
agent** (mirror `MAX_MCP_SERVERS`, `service.ts:264-277`) with an OMA-chosen
message; custom `skill_id` existence against the SkillsStore; `anthropic`
attaches rejected while the catalog is deferred (D3). Cross-reference asserts
mirror MCP's (`service.ts:344-372`). Cap is per the root agent's own list (§2.2
scope); cross-agent aggregation is deferred.

### D8 — Discriminated mount contract + skill mount root

**Rewritten for a concrete, safe contract (review: Codex-adv + Opus + External +
Fable).** `RuntimeSessionFileMount` gains an **internal, non-public**
`kind: "upload" | "skill"` discriminant; the destination root is derived from
`kind` in the sandbox impl and **never from session/public input**:
- `upload` → `uploadsPath` (`/mnt/session/uploads`), unchanged.
- `skill` → `/workspace/skills` (rw,exec — required, since skill `scripts/` are
  meant to run; uploads is `noexec` AND outside `/workspace`, so it is genuinely
  unusable for skills — the generalization is mandatory, not stylistic).
Generalize the three currently uploads-hardcoded steps in `docker.ts`
(`assertInside*` guard, the tar-extract destination, and the chown/normalize)
plus the microsandbox impl, each keyed by `kind` with a per-root assert. Also:
- Create `/workspace/skills` and chown before extraction (else the read tool hits
  a missing/denied dir).
- **Materialize skill files root-owned, not writable by the sandbox user**
  (skills are read-only inputs); **preserve the executable bit for `scripts/`**
  (current code normalizes to `0644` — decide per-file: `SKILL.md`/refs `0644`,
  `scripts/*` `0755`).
- Path guards reject `..`/absolute (already present, `docker.ts:1033`); the
  skill `name`==`directory` regex (D2) is a second layer.
- **Mixed-root rollback + no partial-materialization:** a failure part-way
  through must not leave a half-populated `/workspace/skills/<name>` a live
  session would treat as complete; extract per-skill atomically (temp dir →
  rename) and roll back on error. A mixed upload+skill mount test pins both roots
  and the rollback.

### D9 — Name uniqueness, quota, atomicity, reclamation

**New (review: External + Opus + Fable + Sonnet).**
- **Canonical-name uniqueness [OMA]:** two distinct skill_ids (or versions) whose
  frontmatter `name` collides would both mount at `/workspace/skills/<name>/` and
  clobber. Enforce **workspace-wide uniqueness of the canonical `name`** as a
  store constraint (unique index), and forbid `name`/`directory` changes across
  versions of a skill. A custom name colliding with a (future) prebuilt name is
  likewise rejected. Concurrency test for same-name races.
- **Atomicity:** object-blob write and SQLite metadata commit are published
  atomically; on failure, roll back and clean orphans (no dangling blob, no
  metadata row without bytes). Delete reclaims blob bytes.
- **Quota:** a per-workspace skill-content byte quota and a per-skill retained-
  version cap (100 MB/version × unlimited versions is a disk-exhaustion path —
  review: External). Blobs referenced by a live session snapshot (D4) are
  retained even if the skill/version is deleted, until the session ends.

## 5. Slice order (each testable in isolation)

0. **Probes 56/57 — DONE** (57 re-run 2026-07-10 with auditable capture).
1. **Skills resource + store** (D1, D2, D9-atomicity/quota). `SkillsStore` (raw
   zip blob per version + manifest), `/v1/skills` multipart upload with the
   dedicated bodyLimit + global bypass, `parseBody({all:true})`, layered
   size/bomb/zip-slip validation, SKILL.md parse + name==dir + name-uniqueness,
   versioning, list/get/delete, delete-only lifecycle. **Custom-only** —
   independent of sessions and of the anthropic catalog (D3 deferred), so slice-1
   parity tests do NOT assert prebuilts. This is the milestone path.
2. **Attachment validation** (D7) + **session-create read-tool coupling** (D6,
   the shared pure evaluator). Root-agent scope only.
3. **Session skill snapshot + runtime delivery** (D4 + D8 + D5): snapshot at
   create → materialize at `/workspace/skills/<name>/` via the discriminated
   mount (root-owned, exec-bit-preserving, atomic/rollback) → custom
   ResourceLoader → wire into `createPiSession` (`runner.ts:969`).
4. **Live smoke 58** (the exit criterion): OMA end-to-end with an **OMA-owned
   Apache example skill** — agent + attached skill → session → model `read`s
   `/workspace/skills/<name>/SKILL.md` (assert via the bash/read tool_result, per
   probe 57's method) and uses it; event vocabulary unchanged; a leak sweep whose
   "intended" surface is explicitly defined (D-trust below).
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
  atomicity (object write fails → no orphan row; commit fails → no orphan blob).
- Validation: bad type, unknown custom id, duplicate skill_id, 20-cap per agent,
  `anthropic`-attach-rejected-while-deferred, and the session-create
  read-tool-coupling 400 with the **verbatim** message (via the shared evaluator).
- Snapshot/repro: `"latest"` resolved at create; a new version uploaded
  mid-session does not change the running session; a version deleted after
  snapshot still materializes from snapshot bytes; restart + eviction/re-create
  materialize identical content from the manifest.
- Runtime: discriminated mount lands skills at `/workspace/skills`, uploads at
  `/mnt/session/uploads` (mixed-mount test); `scripts/*` executable, `SKILL.md`
  0644, root-owned; partial-materialization failure rolls back; smoke 58 proves
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
as: the skill's own files under `/workspace/skills/<name>` and whatever the model
chooses to surface — and asserts NO workspace **secrets/vault/egress** material
leaks through skill materialization, and `/workspace/skills` is not writable by
the sandbox user (D8). Skill scripts inherit the session's existing egress/secret
posture (they run as ordinary sandbox bash — no new exposure, no special grant).

## 8. Reusable seams (file:line — verified)

| Need | Seam | Anchor |
|---|---|---|
| Resource store pattern | `files/` trio + backends | `src/control-plane/files/{store,service,types,routes}.ts` |
| Attachment already stored | agent `skills` column | `agents/store.ts:20,127,228`; `types/agents.ts:58-62` |
| Attachment validation template | `MAX_MCP_SERVERS` + cross-ref asserts | `agents/service.ts:246,264-277,344-372` |
| Deliver files to container | `materializeFileResources` | `sandbox/provider.ts:64`; `docker.ts:360`; called `runner.ts:655-663` |
| Mount-root guard to generalize | `assertInsideUploadsPath` | `docker.ts:368,1033` |
| Advertise skills to Pi | `createAgentSession` call (no loader today) | `runner.ts:969` |
| Read-tool coupling enforcement | tool permissions (factor a pure evaluator) | `sessions/pi/tool-permissions.ts:495-521,527-530,16` |
| Wiring/lifecycle pattern | MCP store-backed provider | `mcp/bridge.ts:472`; consumed `runner.ts:668` |
| Body-limit + bypass to mirror | files upload bodyLimit + global bypass | `files/routes.ts:15,42-48`; `app.ts` body-limit middleware |
| Session-scoped snapshot precedent | file-resource snapshotting | `sessions/service.ts` `prepareFileResources` |
| Session agent shape (no overrides today) | `agentField` | `sessions/request.ts` (`agent: string \| {type:"agent"}`) |

## 9. Open questions — [Unk], resolve before/within the noted slice

1. **20-cap over-cap error message** (slice 2) — probe 56's dup-test tripped the
   duplicate rule; needs 21 *distinct* skill_ids. OMA picks its own message; a
   parity probe is optional.
2. **`directory` vs `name` when they differ** (slice 1/3) — probe used name==dir.
   OMA enforces name==dir at upload (D2), sidestepping it; a probe with a
   name≠dir zip would confirm hosted's mount choice if parity is later wanted.
3. **Root-zip / per-file multipart / derived `display_title` / uniqueness / 30 MB
   boundary / pagination continuation** (slice 1) — [Doc]/[Unk]; a short probe-56b
   would settle the accept-shapes and the 30 MB error before finalizing the route.
4. **Referenced-skill/version deletion semantics** (slice 1) — hosted behavior
   when deleting a version an active agent/session references is [Unk]; probe
   before finalizing lifecycle. OMA's own answer is D4 (snapshot retains bytes).
5. **`anthropic` catalog** (deferred) — resolution/versioning only relevant once
   a redistribution arrangement unblocks D3.

## 10. Review log

- **Research + probes (2026-07-10):** 4 subagent threads + 2 live hosted probes
  (56 wire, 57 execution; 57 re-run with auditable tool-output capture).
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

*(The independent external review that was appended here as Appendix A
has been folded into §10 and the D-decisions above; the raw review is
preserved in the PR 174 history at commit 72f2daa.)*

