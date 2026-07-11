# OMA ↔ Claude Managed Agents — Product Parity

Living tracker of where OMA (open-managed-agents) stands against Anthropic's
Claude Managed Agents (CMA) product surface. Source of truth for the ongoing
parity work: pick items from **Pile B** (actionable), leave **Pile A**
(deliberately deferred) until their arc is scheduled.

- **Baseline:** OMA `main` @ `26f754d` · CMA docs snapshot 2026-07-11 (25 pages under `managed-agents/`)
- **Method:** 10-domain audit (one reviewer per doc cluster) cross-checked against the codebase; Tier-1 items independently re-verified.
- **Scope note:** OMA is a self-hostable, wire-compatible clone. "Parity" = a client written against the CMA docs/SDK behaves the same against OMA. Deliberate self-hosted reinterpretations (egress, sandbox security) are noted, not counted as gaps.

## Summary scorecard

| Domain | Parity | State |
|---|---|---|
| Skills | ~85% | Full `/v1/skills` CRUD/versioning, admission, snapshot, runtime delivery ✅ |
| MCP & vaults | ~80% | Connector + `static_bearer`/`mcp_oauth` + `mcp_oauth_validate` ✅; *exceeds* (SSRF guards, secret scrubbing) |
| Sessions & files | ~65% | Create/retrieve/list/archive ✅; update / overrides / `resources.*` missing; sharp edges |
| API reference & onboarding | ~65% | Auth / betas / error-envelope ✅; `prev_page` broken; no update/lifecycle endpoints |
| Tools & permissions | ~65% | Permission state-machine faithful ✅; toolset short 2 tools + `glob`→`find` rename |
| Agent config & outcomes | ~55% | Create/get/list/archive ✅; **no update/versioning**; outcomes deferred |
| Events, streaming & webhooks | ~55% | SSE / resume / idempotency ✅; webhooks 0%, deltas 0%, `agent.thinking` dead |
| Environments & sandboxes | ~35%\* | Thin *resource* (no packages/image/runtimes); **security *exceeds* CMA** |
| Multi-agent / GitHub / scheduled | ~5 / 0 / 0% | `multiagent` is an inert façade; GitHub & cron absent |
| Memory & dreams | ~0% | Absent (hard 400 at the session-resource boundary); deliberately deferred |

\* Environment *resource* surface is ~35%, but sandbox *security/egress* exceeds CMA — see "Where OMA exceeds CMA".

**Strategic shape:** OMA is strong and largely wire-faithful on the **synchronous single-agent core** (agent → session → sandbox → tools → skills → MCP → vaults → SSE) and near-zero on the **orchestration / automation / persistence layer** (multi-agent runtime, memory, deployments, webhooks, outcomes). Most of that second layer is deliberately deferred (Pile A) — scope, not rot. The near-term win is Pile B: making the surface OMA *already ships* honestly wire-compatible.

## Legend

`✅ DONE` wire-compatible · `🟡 PARTIAL` · `❌ MISSING` · `⏸️ DEFERRED` (by design, roadmap-tracked) · `🔵 OMA-reinterpretation` · `⚠️ ACCEPTED-BUT-INERT` (config round-trips, no runtime effect)

Checkboxes on Pile B items track fix progress. `(verified)` = re-checked directly against the code during the audit.

---

## Where OMA exceeds CMA

Stated so these are not mistaken for gaps and are preserved as deliberate strengths.

- **Sandbox security enforced by default** — `--cap-drop ALL`, `--security-opt no-new-privileges`, read-only rootfs, non-root UID 65534, `nosuid,nodev` tmpfs. CMA's self-hosted-sandboxes-security doc tells operators to implement these themselves; OMA bakes them in (`sessions/pi/sandbox/docker.ts`).
- **Default-deny egress policy engine** — host/port/path-scoped allowlist, opaque-tunnel opt-in, TLS-terminating MITM sidecar, boundary credential injection so real secrets never enter the sandbox (`egress/policy.ts`, `sessions/pi/sandbox/docker-egress.ts`). Materially more capable than CMA's binary `unrestricted`/`limited` model.
- **Two sandbox engines** (Docker + microsandbox) behind one fail-closed selection boundary — an isolation-strength choice CMA doesn't expose.
- **Skills-snapshot reproducibility** — a live session keeps its skill bytes even if the source skill/version is deleted (copy-at-create), more protective than hosted live-resolution.
- **SSRF guard on OAuth refresh endpoints**, secret scrubbing from MCP tool results/errors.

---

## Pile B — Actionable parity gaps

Not deliberate deferrals: bugs/divergences on the surface OMA already claims to support. Mostly small and independent. Clearing Tier 1+2 is the "wire-honesty" pass.

### Tier 1 — correctness / safety

- [ ] **`prev_page` missing from every list envelope** *(verified)*
  - CMA: `prev_page` is a documented, always-present field on every list response (`null` on the first page) for bidirectional pagination (`session-operations.md:270`).
  - OMA: `ManagedAgentsListPage<T>` = `{ data, has_more, next_page }` only — `prev_page` appears nowhere (`src/types/common.ts`; 0 hits in `src/`). Affects agents, sessions, environments, events, vaults, skills uniformly.
  - Fix: add `prev_page` to the shared page type + compute the backward cursor in the list stores. One shared type, cross-cutting payoff.

- [ ] **`DELETE /v1/sessions/{id}` on a running session is not blocked** *(verified)*
  - CMA: a running session cannot be deleted; interrupt first (`session-operations.md:578`).
  - OMA: `sessions/routes.ts` → `SessionService.delete()` has no status guard. Only the *archive* path guards (`events/service.ts:751,765` `assertSessionArchivable`); no `assertSessionDeletable`/`sessionNotDeletable` exists. Risk: silently tearing down a live sandbox mid-execution.
  - Fix: mirror `assertSessionArchivable` in the delete path; reject `running`/`rescheduling` with the CMA-shaped error.

- [ ] **`networking` accept-and-ignore trap** *(verified)*
  - CMA: `config.networking: {type:"unrestricted"}` / `{type:"limited", allowed_hosts:[…]}` grants the documented access (`environments.md:379`).
  - OMA: a CMA-shaped body is accepted and stored but silently yields the *opposite* — the sandbox stays `--network none` (`egress/policy.ts:97` comment states this explicitly). A client believes it enabled egress and gets full isolation.
  - Fix: reject the unrecognized hosted `networking` shape with a clear 400 (or translate it), instead of accept-and-ignore.

- [ ] **`grep` built-in tool is unwired** *(verified)*
  - CMA: `grep` (regex text search across files) is a documented built-in tool (`tools.md:26`).
  - OMA: the Pi library ships `createGrepToolDefinition` but it is never imported/wired; only `find` is (`sessions/pi/sandbox/provider.ts`). `docs/architecture.md:183` wrongly lists grep as done.
  - Fix: wire `createGrepToolDefinition` into `SandboxOperations`/`SandboxedBuiltinToolName` and the permission evaluator; fix the stale architecture-doc line.

### Tier 2 — silent no-ops / undocumented divergences

- [ ] **`glob` → `find` wire-name mismatch**
  - CMA: built-in tool is named `glob` (`tools.md:25`); doc example config uses `{"name":"glob", …}`.
  - OMA: the runtime tool is named `find` (`sessions/pi/sandbox/provider.ts:349` `createFindToolDefinition`); a `{"name":"glob"}` config never matches and silently no-ops.
  - Fix: expose the tool as `glob` on the wire (alias), or map `glob`↔`find` in the permission evaluator + event names.

- [ ] **No enum validation on `configs[].name` / `permission_policy.type`**
  - CMA: presumably rejects unknown tool names / policy types.
  - OMA: `agents/service.ts` (`optionalToolConfigsSpread` ~:540, `parsePermissionPolicy` ~:571) accept any string; unknown values are silently inert (this is the *root cause* that turns the `glob`/`grep`/`web_*` gaps into silent no-ops instead of 400s).
  - Fix: validate `configs[].name` against the known toolset and `permission_policy.type` against the enum; 400 on unknown.

- [ ] **File-mount cap is 10, not the documented 100**
  - CMA: up to 100 file mounts per session (`files.md:240`).
  - OMA: `MAX_SESSION_FILE_RESOURCES = 10` (`sessions/service.ts:58`, enforced ~:826). >10 → a 400 a hosted client wouldn't hit.
  - Fix: raise to 100 (revisit the 50 MiB shared mounted-byte budget accordingly), or document the divergence deliberately.

- [ ] **`agent.thinking` is a declared-but-dead event type**
  - CMA: `agent.thinking` is emitted for extended-thinking content (`reference.md:33`).
  - OMA: the type is in the union (`src/types/events.ts:23`) but never emitted (runtime emits nothing; topology doc self-admits). Extended-thinking clients are silently downgraded.
  - Fix: emit `agent.thinking` from the runtime when the model produces thinking content, or explicitly document it as unsupported.

- [ ] **`system.message` missing and untracked**
  - CMA: mid-session system-prompt update event, Opus-4.8 only (`events-and-streaming.md:2276`).
  - OMA: 0 hits in `src/`; not in the deferred table either — a silent, unrecorded gap.
  - Fix: decide support vs. explicit deferral; at minimum add to the deferred list so it's tracked.

- [ ] **5-minute tool-confirmation timeout, undocumented**
  - CMA: session "waits indefinitely" for a tool confirmation (`permission-policies.md:628`).
  - OMA: `DEFAULT_TOOL_CONFIRMATION_TIMEOUT_MS = 5*60*1000` auto-denies after 5 min (`sessions/pi/tool-permissions.ts:54,419`). A long human-in-the-loop review gets silently auto-denied.
  - Fix: make the timeout configurable + default to no-timeout (or document the deviation prominently).

### Tier 3 — contract divergences to document or fix

- [ ] **Mount-path rewriting + file_id identity**
  - CMA: files mount "at the exact path you specify"; a new session-scoped `file_id` is minted for the mounted instance (`files.md:238,673`).
  - OMA: mounts are rewritten under `/mnt/session/uploads/<segments>` (`sessions/resources.ts:24`, `SESSION_UPLOADS_ROOT`) and the echoed `file_id` is the original upload's id (deliberate ADR-0013, `docs/plans/0043-…:37,66`). The response `mount_path` reflects the rewritten path.
  - Fix: either honor literal `mount_path` + mint a session-scoped id, or surface the divergence explicitly in docs/response.

- [ ] **Agent create response omits implicit `default_config`**
  - CMA: response echoes `default_config.permission_policy: {type:"always_allow"}` even when omitted on create (`agent-setup.md:176`).
  - OMA: `optionalDefaultConfigSpread` (`agents/service.ts:511`) returns `{}` when omitted; a client reading `tools[0].default_config.permission_policy.type` gets `undefined`.
  - Fix: echo the implicit default in the create/get response.

- [ ] **Environment archive/delete endpoints missing**
  - CMA: `POST /v1/environments/{id}/archive`, `DELETE /v1/environments/{id}` (`environments.md:568,574`).
  - OMA: `environments/routes.ts` has only create/list/get; `archived_at` column exists but nothing sets it. Environments accumulate with no lifecycle path.
  - Fix: add archive + delete routes (delete only if unreferenced), mirroring the agents/sessions archive pattern.

- [ ] **`event_deltas[]` stream param silently ignored**
  - CMA: streaming text previews via opt-in `event_deltas[]`; unknown values 400 (`events-and-streaming.md:1074`).
  - OMA: the stream handler never reads the param (`events/routes.ts:80`); passing it yields a stream that silently never previews. (Full preview support is a larger feature — see Pile A "streaming deltas"; this item is just the defensive 400.)
  - Fix: at minimum validate/400 the param until preview deltas exist.

> **Related (skills-internal follow-ups, already filed):** GitHub issues #175 (`/skill:` host-read), #176 (`*/scripts/*` glob over-match), #177 (microsandbox tamper limitation), #178 (budget error text + `assertInsideMountRoot` dedup). Not CMA-parity gaps; tracked separately.

---

## Pile A — Deliberately deferred capability blocks

Known, roadmap-tracked. Leave until each is scheduled as its own arc. Grouped by block.

### Persistence
- ⏸️ **Memory stores** — `/v1/memory_stores`, `/memories`, `/memory_versions`, `resources[].type:"memory_store"` mount at `/mnt/memory/<slug>/`, beta `agent-memory-2026-07-22`. Currently a hard 400 at the session-resource boundary. Foundational (cross-session persistence). Roadmap: `docs/plans/0114-…:109,202`. **Highest-value deferred block.**
- ⏸️ **Dreams** — `/v1/dreams` async batch distillation over a memory store + past sessions. Sits *on top of* memory stores; moot until those exist. Research-preview, low priority.

### Orchestration
- ⚠️/⏸️ **Multi-agent runtime** — `multiagent` field round-trips through create/get/SQLite (`agents/service.ts:436`, `types/agents.ts:70`) but is **inert**: no delegation tool, no `/v1/sessions/{id}/threads`, no `session.thread_*`/`agent.thread_message_*` events, `session_thread_id` hardcoded `null` (`events/tool-persistence.ts:70`). Roster validation also looser than spec (no 20-cap, rejects `{type:"self"}`). Post-MVP.
- ⏸️ **Outcomes** — `user.define_outcome`, rubric/grader, `span.outcome_evaluation_*` events, `outcome_evaluations[]` on session get. 0 wire presence. Non-goal per `docs/plans/0084-…:101`.

### Automation & integration
- ❌ **Scheduled deployments** — `/v1/deployments`, `/deployment_runs`, cron schedule, pause/unpause/archive/manual-run. Entirely absent **and not in the roadmap gap table** — needs adding to tracking (see Doc-honesty). (Note: the repo's `deployment-*.ts` files are unrelated internal wiring, not this feature.)
- ⏸️ **GitHub integration** — `resources[].type:"github_repository"` repo mount/clone/PR, token rotation. Absent. Roadmap `0114:107` — now *unblocked* (egress + secrets shipped), unstarted. Most shovel-ready deferred item.
- ❌ **Webhooks** — no registration/delivery/signing/retry for any event family (session, vault, agent, deployment). Deferred: `docs/scope.md:61`, ADR-0004. Blocks any async-notification integration.

### Session / agent surface
- ❌ **Agent update + versioning** — `POST /v1/agents/{id}` (versioned update, 409 on stale `version`), `GET /v1/agents/{id}/versions`. `version` is permanently `1`. Core "iterate without recreating" workflow. Acknowledged `README.md:147`.
- ❌ **`agent_with_overrides` session form** — per-session `model`/`system`/`tools`/`mcp_servers`/`skills` override (`sessions.md:194`). No session-override surface at all. Tracked `0122`, `0126:648`.
- ❌ **Session update** — `POST /v1/sessions/{id}` to change `agent.tools`/`agent.mcp_servers` mid-session (idle). No route. Tracked `0122:938`.
- ⏸️ **`sessions.resources.*`** — add/list/delete file mounts on a running session. Non-goal `docs/plans/0043-…:50`.

### Tools & credentials
- ❌ **`web_fetch` / `web_search`** built-in tools — blocked on egress-proxy integration. `docs/architecture.md:184` `TBD`, ADR-0016. (Egress is now shipped, so re-evaluate.)
- ❌ **`environment_variable` vault credential type** — env-var secret substitution at egress (`vaults.md:486`). Absent. Deferred pending egress-proxy slice (`0122:638`, `0124:1579`).
- 🟡 **MCP long-output spill-to-file, tunnels, rich content blocks, `listChanged` subscriptions** — OMA byte-caps in place instead of token-spill-to-file; no tunnels; text/JSON only; tools-only. Named non-goals `docs/plans/0124-…:1566-1577`.
- 🔵 **Streaming text previews (`event_start`/`event_delta`)** — no live token-by-token; buffered `agent.message` only. (The defensive param-validation slice is in Pile B Tier 3.)

### Environments
- ❌ **Environment provisioning richness** — `config.packages` (apt/npm/pip pre-install), per-environment `image`, per-environment resource tiers (CMA up to 8 GB / 10 GB disk), pre-installed languages/runtimes/tools. OMA defaults are minimal (`bash:5.2` / `alpine:latest`, 384 MB / 1 CPU, hardcoded). Biggest out-of-box usability gap for a CMA switcher — an OMA deployment needs a custom image to run Python/Node.
- 🔵/⏸️ **Self-hosted worker/queue surface** (`ANTHROPIC_ENVIRONMENT_KEY`, `ant beta:worker poll`, work stats/stop) — N/A by architecture (OMA control plane + sandbox are co-located, single-node). No analogue needed.

### Platform mechanics
- 🔵 **Rate limits** — CMA's fixed org-wide 300/1200 rpm tiers vs OMA's operator-configurable per-workspace admission limits (same 429/529 envelope). Reasonable self-hosted divergence; not wire-identical if a client hard-codes the numbers.

---

## Doc-honesty fixes (stale/incorrect internal docs)

- `docs/plans/0114-appliance-product-roadmap.md:102` — says the agent `skills` field is runtime-inert. **Stale**: skills shipped (`26f754d`); the runtime consumes them (`sessions/pi/runner.ts` `buildSessionSkillsResourceLoader`, proven by smoke `scratch/59-…`).
- `docs/architecture.md:183` — lists `grep` as done. **Wrong**: `grep` is unwired (Pile B Tier 1).
- **Scheduled deployments** are absent from the roadmap capability-gap table entirely — add a row so the gap is tracked like GitHub mounts are.

---

*Update this file as items land: check the box, drop a commit ref, and re-run the domain audit periodically to refresh the scorecard.*
