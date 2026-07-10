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
  part; its one hard constraint (the host↔container split) is now resolved by
  probe 57.

Roadmap exit criterion ("an agent can use at least one skill") is met by the
runtime layer + one seeded prebuilt skill — it does not require the custom
upload API, so the layers can ship in either order (recommended: wire first).

## 2. Wire contract (from probe 56 — VERIFIED against hosted)

Beta header `skills-2025-10-02`. All shapes below are probe-verified.

### 2.1 Resource

- **CreateSkill** `POST /v1/skills` — **`multipart/form-data`**, field `files[]`
  = a zip (SKILL.md at root or under a single top-level folder) OR
  path-qualified individual files; optional `display_title` (unique among
  workspace custom skills; derived from SKILL.md if omitted). ≤30 MB total.
  → 200 `{ id: "skill_…", display_title, latest_version, source: "custom",
  type: "skill", created_at, updated_at }`.
  **Wire discriminator is `type: "skill"`**; `source ∈ {custom, anthropic}`.
- **Version object** (`GET …/versions/{v}`, list entries):
  `{ id: "skill_version_…", skill_id, version, name, description, directory,
  type: "skill_version", created_at }`. `name`/`description` are parsed from the
  uploaded SKILL.md; **`directory`** = the zip's top-level folder. Custom
  `version` = epoch-timestamp string; anthropic = date string (`"20260203"`);
  both accept `"latest"`.
- **GetSkill** `GET /v1/skills/{id}` = the CreateSkill shape (no inline versions).
- **ListSkills** `GET /v1/skills` → `{ data: [...], has_more: bool,
  next_page: string|null }`. **Anthropic prebuilts appear here** (`xlsx`/`pptx`/
  `docx`/`pdf`, `id` = short name, `source: "anthropic"`, date version).
- **CreateVersion** `POST /v1/skills/{id}/versions` (same multipart body);
  **ListVersions** `GET …/versions` → `{ data, has_more, next_page }`;
  **GetVersion** `GET …/versions/{v}`.
- **Lifecycle is delete-only** (no archive): `DELETE /v1/skills/{id}` while any
  version exists → 400; delete each `DELETE …/versions/{v}` → 200, then the
  skill → 200. (Deliberate divergence from OMA's usual archive-then-delete;
  matches hosted.)

### 2.2 Attachment (already modelled in OMA, needs hardening)

Skills attach on the **agent** (`skills[]`), or session-locally via
`agent_with_overrides`. Entry `{ type: "anthropic"|"custom", skill_id,
version? }` — already `ManagedAgentsSkill` in `types/agents.ts:58-62`.
Probe-verified validation behavior to match:

- `anthropic` + `version` → **accepted & echoed** (NOT rejected — corrects the
  docs' "custom only" note).
- bad `type` → 400 invalid_request_error.
- unknown custom `skill_id` → 400.
- **duplicate `skill_id` → 400** "Agent has invalid configuration: duplicate
  skill_id \"…\"" (a rule the docs never stated — probe 56 found it).
- skills + `tools: []` at **agent-create** → accepted (coupling NOT here).
- Cap: **20 skills per session**, counted across all agents in a multi-agent
  session. (Value documented; exact over-cap message unprobed — §9 open item.)

### 2.3 Read-tool coupling (from probe 57 — VERIFIED, exact message)

At **session create** with `agent_with_overrides` clearing `tools: []` while
skills are attached → **400**: *"Missing required tool: skills require the read
tool to be usable (enabled and not always_deny) on the session's
`agent_toolset`"*. Enforced at session-create, **not** agent-create. Rule: skills
require the `read` tool **enabled and not `always_deny`** on the effective
agent_toolset.

### 2.4 Events (from probe 57 — VERIFIED)

**No skill-specific events.** A skill invocation is ordinary `agent.tool_use` /
`agent.tool_result` (bash/read) traffic; distinct event set over a full run was
`user.message`, `agent.thinking`, `agent.tool_use/result`, `agent.message`,
`session.status_*`, `session.thread_status_*`, `span.model_request_*`. **OMA
needs zero new event vocabulary.**

## 3. Runtime execution model (from probes 57 + Pi thread — VERIFIED)

- **Mount path:** hosted mounts each skill at **`/workspace/skills/<directory>/`**
  (probe 57: `/workspace/skills/probe57-…/SKILL.md`), under the **workspace root**
  — precisely where Pi's sandboxed `read` tool (guarded to `/workspace`) can open
  it. `<directory>` = the frontmatter `name`. **OMA must mount at
  `/workspace/skills/<name>/` for byte-parity** of skills that reference their own
  bundled files by relative path.
- **The host↔container split (the crux, now resolved):** Pi's agent loop runs in
  the OMA control-plane process, but `read`/`bash` are proxied into the sandbox
  container and guarded to `/workspace` (`docker.ts:427-439`). Pi advertises each
  skill in the system prompt via `formatSkillsForPrompt` as an
  `<available_skills>` block whose `<location>` is the SKILL.md path, and the
  model opens it with the container-side `read` tool. So skills need to be
  **materialized in the container** at a `/workspace`-relative path AND
  **advertised to Pi with that same container path as `<location>`**. Because the
  advertised path is just a string Pi emits into the prompt (not a file Pi itself
  reads — to be confirmed, §9 probe), a **custom Pi `ResourceLoader`** returning
  skill metadata (name/description from the OMA store) with `filePath =
  /workspace/skills/<name>/SKILL.md` satisfies both without staging bytes
  host-side.
- **Provision, don't execute** (verified probe 57 + prior art): the model runs
  bundled `scripts/` itself via its own bash. There is no skill executor to
  build.
- **System-prompt injection is gated on the `read` tool being present**
  (`system-prompt.js:33`) — consistent with the §2.3 coupling. OMA uses
  `noTools:"builtin"` + an explicit allowlist (`runner.ts:972`); the sandbox
  toolset includes `read` (`provider.ts:217`) — confirm the gate passes (§9).

## 4. Design decisions

### D1 — Storage: new content store, template `files/` (not vaults)

The skill *reference* (`{type, skill_id, version}`) is already stored on the
agent row (`agents/store.ts:20`). The gap is skill *content*. Add a
`SkillsStore` (interface + sqlite/blob impl + service + routes) modelled on
`src/control-plane/files/` (which already has the trio + local/memory backends +
`openInternalSnapshotBytes`). It stores, per (skill_id, version): the file
manifest + bytes (base64/blob for binary safety), and the parsed SKILL.md
metadata (name, description, directory). One SQLite store + the existing file
storage — no new substrate (explicitly avoiding open-ma's KV+R2 five-backend
model, against the appliance constraint).

### D2 — Custom upload = the Skills resource, NOT the Files API

Probe/docs confirm hosted uploads go to `/v1/skills`, not Files. OMA mirrors
that: multipart-zip upload into the SkillsStore. Zip handling gets **bomb
guards** (from open-ma, adapted): total-uncompressed ≤ 100 MB, per-file ≤ 25 MB,
file-count ≤ 500, checked incrementally during unzip; require a UTF-8 `SKILL.md`
at root or single top-level folder; reject otherwise. Port the ~10 SKILL.md
naming rules from the `skills-ref` validator.

### D3 — Prebuilt (`anthropic`) skills: vendor anthropics/skills, read-only catalog

`xlsx/docx/pptx/pdf` are not bespoke code — vendor the public
[anthropics/skills](https://github.com/anthropics/skills) content into the repo
and seed them as a **read-only catalog** resolvable by short name, surfaced in
ListSkills with `source:"anthropic"`. This is the fastest path to a demoable
skill and decouples the exit-criterion demo from the custom-upload API. Catalog
is inert data + a resolver; no document-tooling code. Versioning: pin the
vendored snapshot; a single date-version per prebuilt is enough for v1.

### D4 — Runtime delivery: retarget `materializeFileResources` to a skills root

Resolve `agent.skills` → bundles → `RuntimeSessionFileMount[]` at
`/workspace/skills/<name>/…`, delivered by the existing
`sandbox.materializeFileResources` (`provider.ts:64`, `docker.ts:360`) called at
`runner.ts:655-663`. **Constraint:** that path currently pins mounts under
`uploadsPath` via `assertInsideUploadsPath` (`docker.ts:368`, `:1033`) — skills
need a **distinct workspace-relative root**. Decision: generalize the
materialization target (a mount carries its own validated root: uploads root for
file resources, skills root for skills) rather than forcing skills through the
uploads guard. Both Docker and microsandbox impls updated; a mixed-mount test
pins the two roots.

### D5 — Advertising to Pi: custom ResourceLoader, progressive disclosure

Wire a custom Pi `ResourceLoader` (or `additionalSkillPaths`) into
`createAgentSession` at `runner.ts:969` (today it passes none, so skills never
load and the default loader would scan the host cwd). `getSkills()` returns one
entry per attached skill with name/description from the SkillsStore and
`filePath = /workspace/skills/<name>/SKILL.md`. This preserves **progressive
disclosure** (matches hosted's on-demand model + token economy) and needs no
host-side byte staging — chosen over open-ma's "inline the whole SKILL.md into
the system prompt." Fallback if Pi's loader insists on reading the file
host-side (§9 probe): also stage SKILL.md host-side in a temp dir; keep bytes
container-side for the read tool.

### D6 — Read-tool coupling enforced at session-create

Match §2.3 exactly: reject a session whose effective config has non-empty skills
but the `read` tool absent/`always_deny`, with the verbatim hosted message.
Enforcement lives in session-create validation + the tool-permission state
(`tool-permissions.ts`), NOT agent-create (which accepts it, per probe 56).

### D7 — Attachment validation hardening

In `skillArrayField` (`agents/service.ts:246`) and the session-override path:
add the 20-cap (mirror `MAX_MCP_SERVERS`, `service.ts:264-277`), `type` ∈
{anthropic, custom}, duplicate-`skill_id` rejection (probe 56), custom
`skill_id` existence against the SkillsStore, anthropic `skill_id` against the
vendored catalog. Cross-reference asserts mirror MCP's (`service.ts:344-372`).

## 5. Slice order (§7B.9-style; each testable in isolation)

0. **Probes 56/57 — DONE** (this branch).
1. **Skills resource + store.** `SkillsStore` + `/v1/skills` (multipart upload,
   versioning, list/get/delete, delete-only lifecycle, zip-bomb guards,
   SKILL.md parse/validate). Independent of sessions.
2. **Attachment validation** (D7) + **session-create read-tool coupling** (D6).
3. **Runtime delivery** (D4 + D5): resolve → materialize at `/workspace/skills/`
   → custom ResourceLoader → wire into runner/`createPiSession`.
4. **Prebuilt catalog** (D3): vendor anthropics/skills, seed pptx/xlsx/docx/pdf,
   surface in ListSkills. (Alone with slice 3, meets the exit criterion.)
5. **Live smoke 58**: OMA end-to-end — agent + attached skill → session → model
   reads `/workspace/skills/<name>/SKILL.md` and uses it; assert no secret/skill
   leakage beyond intended, event vocabulary unchanged, mount path correct.
6. **Console surface (deferred, named):** skills browsing/upload in the operator
   console — its own slice after the API proves out (mirrors the vaults console
   arc, plan 0125).

## 6. Test plan (highlights beyond per-slice units)

- Wire parity: CreateSkill multipart→exact response shape; version object incl.
  `directory`; ListSkills envelope incl. anthropic prebuilts; delete-only 400
  then version-first success.
- Validation: bad type, unknown custom id, duplicate skill_id, >20 cap, and the
  session-create read-tool-coupling 400 with the verbatim message.
- Zip safety: bomb guards (oversized total, oversized file, too many files,
  missing/duplicate SKILL.md, non-UTF-8 SKILL.md, nested-not-single-folder).
- Runtime: mixed mount roots (uploads vs skills) materialize to the right paths;
  a skill's `<location>` equals the in-container path; session with a seeded
  prebuilt skill runs and the model can `read` it (smoke 58).
- Negative: skills present + read tool `always_deny` → session 400.
- No new event types emitted (assert the event set is unchanged).

## 7. Non-goals (v1)

- Enforcing `allowed-tools` (advisory; hosted/SDK don't — §0). If wanted later,
  `tool-permissions.ts` is the seam.
- Skill *execution engine* — the model runs scripts via bash; OMA only
  provisions.
- Custom-skill console UI (slice 6, deferred).
- Full version-management UX — v1 supports upload/new-version/pin-by-version/
  latest; richer lifecycle later.
- Memory-store / GitHub-repo resources (separate `resources` surface).

## 8. Reusable seams (file:line — verified)

| Need | Seam | Anchor |
|---|---|---|
| Resource store pattern | `files/` trio + backends | `src/control-plane/files/{store,service,types,routes}.ts` |
| Attachment already stored | agent `skills` column | `agents/store.ts:20,127,228`; `types/agents.ts:58-62` |
| Attachment validation template | `MAX_MCP_SERVERS` + cross-ref asserts | `agents/service.ts:246,264-277,344-372` |
| Deliver files to container | `materializeFileResources` | `sandbox/provider.ts:64`; `docker.ts:360`; called `runner.ts:655-663` |
| Mount-root guard to generalize | `assertInsideUploadsPath` | `docker.ts:368,1033` |
| Advertise skills to Pi | `createAgentSession` call (no loader today) | `runner.ts:969` |
| Read-tool coupling enforcement | tool permissions | `sessions/pi/tool-permissions.ts` |
| Wiring/lifecycle pattern | MCP store-backed provider | `mcp/bridge.ts:472`; consumed `runner.ts:668` |

## 9. Open questions / probes before or during implementation

1. **20-skills cap error message** — unprobed (probe 56's dup test tripped the
   duplicate-skill_id rule first). Needs 21 *distinct* skill_ids. Low priority;
   pick a sensible invalid_request_error message and revisit if a probe runs.
2. **Does Pi's `ResourceLoader.getSkills()` require the SKILL.md to exist
   host-side?** D5 assumes it only needs metadata + a path string. If Pi
   validates/read the file host-side, add host staging (D5 fallback). Verify
   against `@earendil-works/pi-coding-agent` source before slice 3.
3. **System-prompt gate** — confirm OMA's sandbox `read` tool name matches Pi's
   gate (`system-prompt.js:33`) so `<available_skills>` renders.
4. **Anthropic prebuilt resolution parity** — the vendored snapshot's version
   string vs hosted's date versions; ensure ListSkills/attach accept `"latest"`
   and the pinned date.
5. **GetSkill/ListSkills pagination bounds** beyond one page — not exercised.
6. **Multipart accept details** — raw-zip vs per-file `files[]`, 30 MB
   enforcement/error shape.

## 10. Review log

Pre-implementation research (2026-07-10): 4 subagent threads (Pi runtime, hosted
wire, OMA current state, prior art) + 2 live hosted probes (56 wire, 57
execution). Key probe corrections to doc inferences: wire discriminator is
`type:"skill"` (not custom); anthropic+version accepted; duplicate skill_id
rejected; mount path `/workspace/skills/<name>/`; read-tool coupling at
session-create (not agent-create) with exact message; no skill-specific events.
Awaiting adversarial panel review of this plan before implementation.

## Appendix A — Independent adversarial review (2026-07-10)

Reviewed PR 174 on `arc-skills` against `origin/main`, including plan 0126,
both probe scripts and artifacts, the PR body, current OMA session/runtime code,
and the pinned Pi implementation.

**Verdict: request changes before implementation.** The core direction is good,
but the plan is not yet decision-complete.

### Blocking findings

#### 1. D3 cannot legally vendor the four Anthropic document skills

[Plan D3](#d3--prebuilt-anthropic-skills-vendor-anthropicsskills-read-only-catalog)
proposes copying `xlsx/docx/pptx/pdf` into this distributable repository.

Anthropic explicitly describes these document skills as source-available rather
than open source. Their license prohibits retaining, reproducing, distributing,
sublicensing, and creating derivative works.
[Anthropic's repository](https://github.com/anthropics/skills),
[document-skill license](https://github.com/anthropics/skills/blob/main/skills/docx/LICENSE.txt).

Practical resolution:

- Remove D3 and slice 4 in their current form.
- Meet the exit criterion using an OMA-owned test/prebuilt skill or a clearly
  Apache-licensed example.
- Treat hosted `anthropic` catalog parity as deferred unless there is an
  explicit redistribution agreement.
- Do not describe these skills as “inert data”; they contain executable scripts
  and environment dependencies.

#### 2. Probe 56 does not establish several “VERIFIED” claims

[Section 2](#2-wire-contract-from-probe-56--verified-against-hosted) says every
listed shape is probe-verified, but the probe exercised only:

- A zipped upload under one top-level directory.
- Explicit `display_title`.
- One three-item ListSkills page.
- Two versions of the same skill.
- A few attachment validations.

It did not test:

- Root-level `SKILL.md`.
- Path-qualified individual multipart files.
- Derived `display_title`.
- Title uniqueness.
- The 30 MB boundary.
- Skills-only versus combined beta headers.
- Pagination continuation.
- Different frontmatter name versus ZIP directory.
- Referenced skill/version deletion.

The artifact contains only `xlsx` and `pptx`; it does not establish that hosted
ListSkills returned `docx` and `pdf`. The PR body repeats that unsupported
claim.

The plan should distinguish:

- Observed by probe.
- Taken from documentation/specification.
- Chosen OMA behavior.
- Still unknown.

#### 3. Probe 57's runtime evidence is not independently auditable

The polling loop fetches the complete page repeatedly and increments counts
again without deduplicating event IDs (`scratch/57-skills-execution-probe.py`,
loop beginning around line 168). The artifact reports four `user.message`
events even though only one was sent, demonstrating the double counting.

The mount evidence retained in the artifact is the final `agent.message`, not
the underlying bash tool result (`scratch/artifacts/57-skills-execution-probe.json`,
`mount_evidence`). It is plausible, but a reviewer cannot distinguish genuine
tool output from model repetition or hallucination.

Before calling this fully verified, revise the probe to:

- Deduplicate by event ID or advance the cursor.
- Persist the relevant `agent.tool_use` and `agent.tool_result`.
- Capture the exact command, exit status, and stdout containing the path.
- Keep the distinct event-type set separately from event counts.

### Major design gaps

#### 4. The plan assumes session overrides and multi-agent behavior that OMA does not implement

[Section 2.2](#22-attachment-already-modelled-in-oma-needs-hardening) and
[D7](#d7--attachment-validation-hardening) refer to an existing
session-override path.

There is no such path. OMA's session API currently accepts only an agent string
or `{type:"agent"}` and rejects `agent_with_overrides`
(`src/control-plane/sessions/request.ts`, `agentField`).

Likewise, multi-agent configuration is stored but has no runtime
implementation. Therefore “20 skills counted across all agents” cannot be
implemented as a small attachment-validation change.

Practical choice:

- Scope v1 to skills attached to the root persisted agent.
- Enforce the cap and read-tool coupling for that effective configuration.
- Name `agent_with_overrides` and multi-agent aggregation as later parity work.

Otherwise this arc silently expands into session override and multi-agent
execution work.

#### 5. Session reproducibility and deletion semantics are undefined

The plan says to resolve `agent.skills` and mount bundles, but does not say when
`"latest"` becomes a concrete version or what survives:

- New skill versions.
- Agent changes.
- Skill/version deletion.
- Process restart.
- Runtime eviction and re-creation.
- Session-create rollback.

OMA does not retain historical agent versions even though sessions record a
version number. Resolving from the current agent/skill store later would make an
existing session run different content or fail after deletion.

Resolve each attachment to a concrete immutable version at session creation and
persist a session skill snapshot or durable manifest. Runtime recovery must use
that snapshot, not current `"latest"`.

The plan also needs explicit behavior for deleting a version referenced by an
active agent or session.

#### 6. Storage limits and atomicity are incomplete

A 30 MB upload currently cannot reach a new Skills route without
application-level work: OMA's default request limit is 1 MiB, with a special
bypass only for `POST /v1/files` (`src/control-plane/app.ts`, body-limit
middleware).

Skills need:

- A route-specific body limit and global-limit bypass.
- The existing bounded upload-admission gate.
- A per-workspace durable skill-content quota.
- Atomic metadata/object publication.
- Rollback and orphan cleanup when object writes or SQLite commits fail.
- Delete reclamation.
- Limits on retained versions or total workspace bytes.

A 100 MB uncompressed limit per version with unlimited versions remains a
straightforward disk-exhaustion path.

#### 7. Mount collisions are unspecified

Duplicate `skill_id` does not prevent two distinct skills or versions from
declaring the same frontmatter name. Both would map to:

`/workspace/skills/<name>/`

Custom skills could also collide with a prebuilt name such as `xlsx`.

The plan must either:

- Enforce workspace-wide uniqueness of the canonical skill name and prevent
  name changes across versions; or
- Reject collisions when resolving the effective session skill set.

This needs store constraints and concurrency tests, not only an in-memory
check.

#### 8. Generalizing mount roots needs a stricter security design

[D4](#d4--runtime-delivery-retarget-materializefileresources-to-a-skills-root)
says each mount carries a validated root. That root must never be influenced by
public session input.

Use an internal discriminated type such as `kind: "upload" | "skill"` and
derive the destination from the kind. Also specify:

- Reject ZIP symlinks, hardlinks, devices, absolute paths, `..`, NULs,
  duplicate normalized paths, and case-fold collisions.
- Materialize skill files root-owned and non-writable by the sandbox user.
- Decide whether executable bits are preserved. Current materialization
  normalizes every file to `0644`, while some skills expect executable scripts.
- Group extraction by trusted root and verify mixed-root rollback.
- Prevent partially materialized skills from surviving preparation failure.

### D5 result

The sharpest stated open question is now resolved.

The pinned Pi source supports synthetic skills with virtual paths, and normal
prompt construction reads `name`, `description`, and `filePath` from
`ResourceLoader.getSkills()` without opening `SKILL.md` host-side. `filePath`
is formatted directly into `<location>`.

Therefore:

- A custom synthetic `ResourceLoader` is the right approach.
- Host-side staging is unnecessary for normal model-driven activation.
- `additionalSkillPaths` is not equivalent—it would cause host-side discovery.
- Remove D5 from the open-question list and pin the finding to Pi version
  `0.75.4`.
- Implement a small complete `ResourceLoader` with no-op results for unrelated
  resource types.

The system-prompt gate is also straightforward: Pi includes skills when `read`
appears in selected tools. Session validation must share the same pure
effective-tool-policy evaluator as runtime so those decisions cannot drift.

### Additional corrections

- Specify the `/v1/skills` beta-header matrix and update the known `/v1`
  route/auth classifier.
- Probe referenced-skill and referenced-version deletion before fixing
  lifecycle semantics.
- Define whether a new version may change `name` or `directory`.
- Preserve upload ordering and exact pagination cursor semantics.
- Add a manifest-level SHA-256 and verify every file before materialization.
- Make the custom-upload end-to-end smoke the milestone. Prebuilt parity should
  not block useful skill execution.

### What is solid

The following decisions should remain:

- Separate wire-resource and runtime-delivery layers.
- `/workspace/skills/<name>/` as the container path.
- Progressive disclosure through Pi metadata plus container-side `read`.
- Provisioning instead of inventing a skill execution engine.
- Read-tool coupling at session creation.
- No new skill event vocabulary.
- Treating `allowed-tools` as advisory rather than a security boundary.

Overall: strong foundation, but implementation should wait until the licensing
blocker, evidence labeling, session snapshot semantics, absent override scope,
storage quotas, and name-collision policy are resolved.
