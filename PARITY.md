# OMA ↔ Claude Managed Agents — Product Parity

Living tracker of where OMA (open-managed-agents) stands against Anthropic's
Claude Managed Agents (CMA) product surface. Source of truth for the ongoing
parity work. It separates immediate wire-honesty fixes, planned pre-v1 arcs,
post-v1 deferrals, and deliberate architecture-specific divergences.

- **Baseline:** OMA `main` @ `26f754d` · CMA docs snapshot 2026-07-11 (25 pages under `managed-agents/`)
- **Method:** 10-domain audit (one reviewer per doc cluster) cross-checked against the codebase; Tier-1 items independently re-verified.
- **Scope note:** OMA is a self-hostable, wire-compatible clone. "Parity" = a client written against the CMA docs/SDK behaves the same against OMA. Deliberate self-hosted reinterpretations (egress, sandbox security) are noted, not counted as gaps.
- **Score note:** percentages below are directional audit estimates, not measured
  compatibility KPIs. The evidence and individual rows are authoritative; the
  percentages are only a compact orientation aid.

## Summary scorecard

| Domain | Parity | State |
|---|---|---|
| Skills | ~85% | Full `/v1/skills` CRUD/versioning, admission, snapshot, runtime delivery ✅ |
| MCP & vaults | ~80% | Connector + `static_bearer`/`mcp_oauth` + `mcp_oauth_validate` ✅; additional SSRF/scrubbing hardening |
| Sessions & files | ~65% | Create/retrieve/list/archive ✅; update / overrides / `resources.*` missing; sharp edges |
| API reference & onboarding | ~65% | Auth / betas / error-envelope ✅; bidirectional pagination incomplete; no update/lifecycle endpoints |
| Tools & permissions | ~65% | Permission state-machine faithful ✅; toolset short 2 tools + `glob`→`find` rename |
| Agent config & outcomes | ~55% | Create/get/list/archive ✅; **no update/versioning**; outcomes deferred |
| Events, streaming & webhooks | ~55% | SSE / resume / idempotency ✅; webhooks 0%, deltas 0%, `agent.thinking` dead |
| Environments & sandboxes | ~35%\* | Thin *resource* (no packages/image/runtimes); strong self-hosted isolation defaults |
| Multi-agent / GitHub / scheduled | ~5 / 0 / 0% | `multiagent` is an inert façade; GitHub & cron absent |
| Memory & dreams | ~0% | Absent (hard 400 at the session-resource boundary); deliberately deferred |

\* Environment *resource* surface is ~35%. OMA enforces more of the controls
described in CMA's **self-hosted sandbox guidance** by default; this is not a
claim of blanket superiority over Anthropic's hosted environment.

**Strategic shape:** OMA is strong and largely wire-faithful on the **synchronous single-agent core** (agent → session → sandbox → tools → skills → MCP → vaults → SSE) and thin on the **orchestration / automation / persistence layer**. The near-term bar is trust: requests on the surface OMA already exposes must not succeed while silently doing nothing or doing the opposite of CMA's contract.

**Recommended pre-v1 sequence:** ~~running-session delete guard~~ (DONE
2026-07-12) → networking translation/rejection → probe-backed tool config
validation → reject the inert multi-agent façade → `glob`/`grep` parity slice →
pagination probes/semantics → agent update/versioning → usable environment image
story → web tools.

## Legend

`✅ DONE` wire-compatible · `🟡 PARTIAL` · `❌ MISSING` · `⏸️ DEFERRED` (by design, roadmap-tracked) · `🔵 OMA-reinterpretation` · `⚠️ ACCEPTED-BUT-INERT` (config round-trips, no runtime effect)

Checkboxes on Pile B items track fix progress. `(verified)` = re-checked directly against the code during the audit.

## Evidence standard

Every implementation row must identify both sides of the comparison:

- **`[Obs]`** — captured against hosted CMA by a committed, reproducible probe
  and raw artifact. Required when error precedence, exact messages, races, or
  undocumented behavior determine the design.
- **`[Doc]`** — stated explicitly in the dated CMA documentation snapshot.
- **`[OMA]`** — deliberate self-hosted policy where exact hosted parity is not
  appropriate. The divergence must be explicit and tested.
- **`[Unk]`** — plausible but not established. Do not implement an assumption
  from this category; probe or document a product decision first.

Code inspection proves OMA's current behavior, not CMA's. Wording such as
"presumably rejects" is never sufficient evidence for a parity change.

---

## Where OMA deliberately goes beyond CMA's documented self-hosted baseline

Stated so these are not mistaken for gaps and are preserved as deliberate
strengths. These are scoped comparisons to documented controls, not a blanket
comparison with Anthropic's hosted implementation.

- **Sandbox security enforced by default** — `--cap-drop ALL`, `--security-opt no-new-privileges`, read-only rootfs, non-root UID 65534, `nosuid,nodev` tmpfs. CMA's self-hosted-sandboxes-security doc tells operators to implement these themselves; OMA bakes them in (`sessions/pi/sandbox/docker.ts`).
- **Default-deny egress policy engine** — host/port/path-scoped allowlist, opaque-tunnel opt-in, TLS-terminating MITM sidecar, boundary credential injection so real secrets never enter the sandbox (`egress/policy.ts`, `sessions/pi/sandbox/docker-egress.ts`). Materially more capable than CMA's binary `unrestricted`/`limited` model.
- **Two sandbox engines** (Docker + microsandbox) behind one fail-closed selection boundary — an isolation-strength choice CMA doesn't expose.
- **Skills-snapshot reproducibility** — a live session keeps its skill bytes even if the source skill/version is deleted (copy-at-create), more protective than hosted live-resolution.
- **SSRF guard on OAuth refresh endpoints**, secret scrubbing from MCP tool results/errors.

---

## Pile B — Actionable parity gaps

Not deliberate deferrals: bugs/divergences on the surface OMA already claims
to support. Clearing Tier 1+2 is the "wire-honesty" pass. Items are ordered by
the risk of silent contradiction, not by how easy they first appear.

### Tier 1 — correctness / safety

- [x] **`DELETE /v1/sessions/{id}` on a running session is blocked** *(DONE 2026-07-12)*
  - CMA `[Doc]`: a running session cannot be deleted; interrupt first (`session-operations.md:578`).
  - CMA `[Obs]`: probe 38 (`scratch/artifacts/38-managed-agents-delete-running-probe.json`) — DELETE while running → HTTP 400 `invalid_request_error`, message `"Cannot delete session while it is running. Send an interrupt event or wait for the session to complete."`; the rejected DELETE leaves the session running; a concurrent interrupt succeeds asynchronously while DELETE stays rejected.
  - Fix (shipped): `assertSessionDeletable` (`events/service.ts`) mirrors the archive running-detection and `sessionNotDeletable()` (`events/session-guards.ts`) returns the verbatim hosted message; `DefaultSessionService` requires this guard at construction and runs it before any deletion mutation. Regression + mutation-checked in `session-lifecycle-api.test.ts`; the delete-vs-indexing race in `runtime-events-api.test.ts` is now closed by the guard (delete refused until the turn settles).

- [ ] **`networking` accept-and-ignore trap** *(verified)*
  - CMA `[Doc]`: `config.networking: {type:"unrestricted"}` / `{type:"limited", allowed_hosts:[…]}` grants the documented access (`environments.md:379`).
  - OMA: a CMA-shaped body is accepted and stored but silently yields the *opposite* — the sandbox stays `--network none` (`egress/policy.ts:97` comment states this explicitly). A client believes it enabled egress and gets full isolation.
  - Fix direction: prefer translating the CMA shape into OMA's policy engine.
    If a safe translation is not possible, reject it with a clear 400. Never
    retain accept-and-ignore behavior. Translation requires an explicit review
    of `limited`, package-manager, MCP-server, wildcard, port, and path semantics.

- [ ] **Unknown tool configs and policy types can silently no-op** *(`[Unk]` hosted rejection behavior; OMA behavior verified)*
  - CMA: documented tool names and permission-policy values are closed sets,
    but exact rejection behavior and precedence for unknown values are not yet
    captured. Probe before changing wire behavior.
  - OMA: `agents/service.ts` accepts arbitrary `configs[].name` and policy
    strings; unknown values can persist while having no runtime effect.
  - Fix: first probe unknown tool names, unknown policy types, duplicates, and
    precedence. Then validate against the supported vocabulary or explicitly
    preserve/document any hosted acceptance behavior.

- [ ] **`multiagent` configuration is accepted but runtime-inert** *(OMA verified)*
  - CMA `[Doc]`: coordinator agents delegate through a multi-agent runtime and
    expose thread APIs/events.
  - OMA: the field round-trips but creates no delegation tool, thread runtime,
    or thread events. A successful create currently over-promises capability.
  - Pre-v1 decision: either implement the runtime arc or reject non-null
    `multiagent` configuration until it exists. Prefer an honest temporary 400
    over an accepted inert façade; probe the desired error shape before coding.

### Tier 2 — compatibility work requiring a probe or bounded design slice

- [ ] **Tool parity slice: CMA `glob`/`grep` vs OMA `find`**
  - CMA `[Doc]`: built-ins are named `glob` and `grep` (`tools.md:25-26`).
  - OMA: exposes Pi's `find` and does not wire `grep`; a `glob` config silently
    misses the runtime tool. Pi 0.80.6 exports grep support, but wiring it is not
    only an import: both sandbox providers need operations, permission/event
    naming must match CMA, and the default image needs a deterministic `rg`
    strategy without host execution or uncontrolled download.
  - Fix: treat `glob` aliasing and sandboxed `grep` as one reviewed slice with
    real Docker/microsandbox tests and hosted probes for input/output shapes.

- [ ] **Bidirectional pagination / `prev_page`** *(OMA absence verified; CMA cross-resource scope `[Unk]`)*
  - CMA `[Doc]`: sessions expose `prev_page` and accept it through the ordinary
    `page` parameter (`session-operations.md:270`). The current snapshot does
    not establish that every other resource has identical semantics.
  - OMA: shared page envelopes expose only `{data, has_more, next_page}`.
  - Next step: probe sessions plus each list resource before declaring a
    cross-cutting contract. Implementation requires real backward-cursor store
    semantics and ordering tests; adding a nullable field alone is insufficient.

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

## Planned pre-v1 parity arcs

These are larger than the wire-honesty pass but directly affect whether an
early adopter can build and iterate a credible single-agent product.

1. **Agent update + versioning** — `POST /v1/agents/{id}` with optimistic
   version checks plus `GET /v1/agents/{id}/versions`. OMA currently pins every
   agent at version 1, forcing recreation for ordinary prompt/tool iteration.
   This is the highest-value missing core workflow after Pile B.
2. **Usable environment image story** — provide a batteries-included default
   runtime and a reviewed per-environment image override. Today the minimal
   `bash:5.2` / Alpine defaults require operators to build an image before a
   typical Python or Node workflow works. Image selection is a security
   boundary and needs allowlisting/pinning, not a raw untrusted Docker string.
3. **Web tools** — re-probe CMA `web_fetch` / `web_search` shapes, decide which
   leg owns execution, and integrate them with the shipped egress policy rather
   than exposing Pi's host-network defaults. This is now unblocked but is still
   a bounded security-sensitive arc.

Do not start a broad post-v1 block merely because it has a lower nominal parity
percentage; finish these trust/usability arcs first.

---

## Pile A — Post-v1 / deliberately deferred capability blocks

Known, roadmap-tracked. Leave until each is scheduled as its own arc. Grouped by block.

### Persistence
- ⏸️ **Memory stores** — `/v1/memory_stores`, `/memories`, `/memory_versions`, `resources[].type:"memory_store"` mount at `/mnt/memory/<slug>/`, beta `agent-memory-2026-07-22`. Currently a hard 400 at the session-resource boundary. Foundational (cross-session persistence). Roadmap: `docs/plans/0114-…:109,202`. **Highest-value deferred block.**
- ⏸️ **Dreams** — `/v1/dreams` async batch distillation over a memory store + past sessions. Sits *on top of* memory stores; moot until those exist. Research-preview, low priority.

### Orchestration
- ⚠️/⏸️ **Multi-agent runtime** — `multiagent` field round-trips through create/get/SQLite (`agents/service.ts:436`, `types/agents.ts:70`) but is **inert**: no delegation tool, no `/v1/sessions/{id}/threads`, no `session.thread_*`/`agent.thread_message_*` events, `session_thread_id` hardcoded `null` (`events/tool-persistence.ts:70`). Roster validation also looser than spec (no 20-cap, rejects `{type:"self"}`). Post-MVP.
- ⏸️ **Outcomes** — `user.define_outcome`, rubric/grader, `span.outcome_evaluation_*` events, `outcome_evaluations[]` on session get. 0 wire presence. Non-goal per `docs/plans/0084-…:101`.

### Automation & integration
- ❌ **Scheduled deployments** — `/v1/deployments`, `/deployment_runs`, cron schedule, pause/unpause/archive/manual-run. Entirely absent; now tracked in the appliance roadmap as of 2026-07-11. (The repo's `deployment-*.ts` files are unrelated internal wiring, not this feature.)
- ⏸️ **GitHub integration** — `resources[].type:"github_repository"` repo mount/clone/PR, token rotation. Absent. Roadmap `0114:107` — now *unblocked* (egress + secrets shipped), unstarted. Most shovel-ready deferred item.
- ❌ **Webhooks** — no registration/delivery/signing/retry for any event family (session, vault, agent, deployment). Deferred: `docs/scope.md:61`, ADR-0004. Blocks any async-notification integration.

### Session / agent surface
- ❌ **`agent_with_overrides` session form** — per-session `model`/`system`/`tools`/`mcp_servers`/`skills` override (`sessions.md:194`). No session-override surface at all. Tracked `0122`, `0126:648`.
- ❌ **Session update** — `POST /v1/sessions/{id}` to change `agent.tools`/`agent.mcp_servers` mid-session (idle). No route. Tracked `0122:938`.
- ⏸️ **`sessions.resources.*`** — add/list/delete file mounts on a running session. Non-goal `docs/plans/0043-…:50`.

### Tools & credentials
- ❌ **`environment_variable` vault credential type** — env-var secret substitution at egress (`vaults.md:486`). Absent. Deferred pending egress-proxy slice (`0122:638`, `0124:1579`).
- 🟡 **MCP long-output spill-to-file, tunnels, rich content blocks, `listChanged` subscriptions** — OMA byte-caps in place instead of token-spill-to-file; no tunnels; text/JSON only; tools-only. Named non-goals `docs/plans/0124-…:1566-1577`.
- 🔵 **Streaming text previews (`event_start`/`event_delta`)** — no live token-by-token; buffered `agent.message` only. (The defensive param-validation slice is in Pile B Tier 3.)

### Environments
- ❌ **Environment provisioning richness beyond the pre-v1 image story** —
  `config.packages` (apt/npm/pip), resource tiers, preinstalled tool catalogs,
  and hosted-style disk sizing remain separate post-v1 breadth.

---

## Architecture-specific divergences

These should remain explicit and tested, but exact hosted behavior is not the
goal because OMA's deployment model is intentionally different.

- 🔵 **Self-hosted worker/queue surface** — CMA's environment-key worker poll
  model has no direct analogue: OMA co-locates its single-node control plane and
  sandbox orchestration. Revisit only if OMA adopts remote workers.
- 🔵 **Rate limits** — CMA's fixed organization tiers vs OMA's
  operator-configurable per-workspace admission limits. Preserve the compatible
  429/529 envelope; do not imitate hosted numeric quotas by default.
- 🔵 **Sandbox and egress policy** — preserve OMA's fail-closed provider
  selection, stronger default Docker isolation, and boundary secret injection
  even where the implementation is not byte-for-byte hosted behavior.
- 🔵 **Lifecycle guards are in-process, not durable** — `assertSessionArchivable`
  and the required `assertDeletable` dependency (`events/service.ts`)
  detect a live turn via the
  in-process `activeRuntimeTaskCount` map. The `sessions.status` column only ever
  holds `idle`/`terminated` (only archive flips it, `sessions/store.ts:208`), so
  the `status === "running"/"rescheduling"` branch is currently unreachable — the
  running signal is entirely in-memory. In the single-node appliance this is safe:
  a turn runs *in* the control-plane process, so if that process dies the turn is
  dead (nothing live to protect), and boot recovery (`recoverAllAbandonedRuntimeTurns`,
  `app.ts:674`) synchronously re-`beginRuntimeTask`s resumable turns *before* the
  served app is built. Residual gap: (a) a **multi-process / shared-SQLite**
  deployment — a DELETE on process B can't see process A's live turn; (b) a narrow
  **lease-retry-delayed** recovery window where the counter is 0 but a durable turn
  is pending. Both are out of scope for the single-node model; the durable-state,
  transactional version of these guards (covering *both* archive and delete) is a
  **scale-out-arc** follow-up, not a per-endpoint fix. Raised by Codex adversarial
  review of the delete-guard slice, 2026-07-12.

## Small follow-up probes

- [ ] **`rescheduling` delete/archive rejection wording** — probe 38 only observed
  status `running`. The delete (and archive) guards reject `rescheduling` with the
  same message as a conservative mirror; hosted may permit it or use different
  wording. Probe before treating the `rescheduling` path as parity-confirmed.

---

## Doc-honesty fixes (stale/incorrect internal docs)

All resolved 2026-07-11:

- [x] `docs/plans/0114-appliance-product-roadmap.md` — skills row corrected from "runtime-inert" to DONE (0126; runtime consumes them via `sessions/pi/runner.ts` `buildSessionSkillsResourceLoader`, smoke `scratch/59-…`).
- [x] `docs/architecture.md` — `grep` corrected from ✅ to "not yet wired"; `glob` clarified as wired under the name `find`.
- [x] `docs/plans/0114-appliance-product-roadmap.md` — added a **Scheduled deployments** row to the capability-gap table (was untracked).

---

*Update this file as items land: check the box, drop a commit ref, and re-run the domain audit periodically to refresh the scorecard.*
