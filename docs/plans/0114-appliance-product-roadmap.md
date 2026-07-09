# 0114 Appliance Product Roadmap

Date: 2026-07-02

Issue: none yet (product-direction record; arcs below get issues as they start)

## Purpose

Record the product direction set after #129 closed, so it stops living only in
conversation: **what OMA is becoming, in what order, and what is deliberately
deferred.** This is a roadmap plan, not an ADR — individual arcs get their own
plans/ADRs when they start, and nothing here overrides the rollout gates in
[0112](0112-pi-runtime-rollout-policy.md).

## Product vision

OMA's near-term product is a **self-hostable Managed Agents appliance**:

1. An operator installs one thing — a single npm package (ideal) or a
   docker-compose file (at worst).
2. First boot initializes durable storage and mints the admin credential.
3. The operator opens a bundled dashboard, administers the instance, creates
   workspaces, and mints/distributes API keys.
4. Any Anthropic SDK client connects with a workspace key — wire compatibility
   is the contract.
5. Eventually, a SaaS tier serves users who don't want to self-host. Nothing
   in the appliance may paint us out of that corner, but the appliance ships
   first.

Standing constraints that follow from this:

- **Small dependency footprint.** SQLite stays the appliance store. Nothing
  added to the core may require Postgres/Redis/k8s to run locally.
- **Single-node appliance today, horizontally scalable service later.**
  Postgres (and shared-state coordination generally) is a *named future
  backend*, not current work. The discipline that keeps it cheap: all storage
  already sits behind interfaces (`SessionStore`, `EventStore`, workspace
  store, `DeploymentStores`; seams audited in #124) — new features stay behind
  those interfaces and never leak SQLite semantics into route/service code.
- **Modularity rule** (the Postgres/SQLite pattern, generalized): build an
  interface when the second implementation is *named*, not merely imaginable;
  refuse plugin registries for hypothetical swaps. Applied concretely to
  secrets and egress in
  [egress-secrets-buy-vs-build.md](../references/egress-secrets-buy-vs-build.md).

## Where the repo stands against that vision (verified 2026-07-02; updated 2026-07-06)

> **Progress since first draft (2026-07-06).** Two of the items below moved:
> the **capability track's egress + secrets boundary is DONE** (0117a–e + 0118,
> #136–#150 — the enabling gap is closed), and **Arc A slice 1 shipped**
> (#135 — appliance entrypoint, Dockerfile, compose, `bin`, first-boot key
> mint). Corrected inline below.

Done — the invisible hard parts:

- Wire-compatible core: agents, environments, sessions, files + mount
  snapshots, SSE events, idempotency, interrupts, custom tools, tool
  confirmations, crash recovery, durable SQLite, sandboxed builtin execution.
- Multi-tenancy on one node: hashed API-key workspaces, fail-closed
  `OMA_AUTH_MODE`, per-workspace admission limits, operator CLI, rollback
  runbook, load harness (plan 0113 / #129).
- **Credentialed egress boundary + secrets at rest** (2026-07-06): vendored
  SSRF-denying proxy, per-session dual-homed sidecar, envelope-encrypted
  `SqliteSecretsStore`, `/v1/secrets` API, fail-closed session wiring
  (0117a–e, 0118; ADR 0016). Sandboxed agents reach allowlisted hosts through
  injected credentials they never see. Closes #130 and threat model §3/§4.

Greenfield or stub — the visible product parts:

- **Packaging: Arc A slice 1 shipped (#135, plan 0115).** `Dockerfile` +
  `docker-compose.yml` + `bin/open-managed-agents` + `src/main.ts` boot a
  durable, authenticated server (Hono via `@hono/node-server`, `OMA_PORT`
  4180) and mint + print the first-boot key. **Remaining in Arc A:** serve the
  console from the same process; compose docs for docker-local egress
  (docker.sock + `OMA_EGRESS_SIDECAR_IMAGE` + `OMA_MASTER_KEY`).
- **First boot: key minting done (#135).** First boot initializes durable
  storage and prints the initial API key; the separate provisioning CLI path
  still exists for later keys.
- **Dashboard: DONE (2026-07-06, Arc B / plans 0119+0120).** The appliance
  serves the console at `/console` (self-contained, vendored assets, no CDN);
  admin-key login drives live workspace/key CRUD via `/admin` (#151), a
  workspace key drives read-only `/v1` browsing incl. authenticated
  downloads. `/v1` mutations from the UI remain deliberately disabled.
  Credential transport is fail-closed at boot (`OMA_TLS_TERMINATED` /
  `OMA_ALLOW_INSECURE_TRANSPORT`).
- **Observability: logs only.** No metrics, health endpoint, alerts, or SLOs
  (0112 gate: blocks production).
- **Usage metering: `usage: null`** on sessions; operator's Anthropic key does
  all model calls undifferentiated. Hard prerequisite for SaaS and for any
  per-tenant accountability.

## Capability gaps vs hosted Managed Agents

Source-verified in OMA (what's inert vs absent); the hosted side is from probe
archives and current API docs — **re-probe the hosted surface before
implementing any row** (house discipline; the 0113 probes are the model).

| Capability | Hosted | OMA today | Note |
| --- | --- | --- | --- |
| Skills | Loaded into session container | **Wire-accepted, runtime-inert** (`skills` parsed/stored/echoed; nothing in `sessions/pi/` consumes it) | Fundamentally files + instructions into the sandbox; no heavy dependency. **Now unblocked** (egress done) |
| MCP servers | Sessions connect, auth handled | **Execution DONE (0122 M1); vault auth DONE (M2, 2026-07-09)** — `mcp_oauth` refresh pending M3 | Servers work end-to-end behind `OMA_ENABLE_MCP`, `static_bearer` credentials the agent cannot read |
| Sandbox networking | `environment.config.networking: {type: "limited", allowed_hosts}` | **DONE (2026-07-06)** — `networking.allow`/`credentials` parsed into a per-session egress policy; docker-local sidecar honors it, else `--network none` (0117c–e) | The enabling gap — now closed; skills, MCP, web tools, repo mounts unblocked |
| Secret handling | Vault + boundary injection; secrets never in sandbox | **DONE (2026-07-06)** — envelope-encrypted `SqliteSecretsStore`, sentinels in the sandbox, real values injected only at the TLS-terminated proxy leg (0117c/d, 0118) | Same egress boundary does allowlist + injection; #130 closed |
| Session usage | Cumulative token usage per session | `usage: null` | Wire schema + span-level usage already captured in [observability schema findings](../references/managed-agents-observability-schema-findings.md); metering = aggregation |
| GitHub repo mounts | With out-of-band token injection | Absent | After egress + secrets |
| Task budgets | `task_budgets` token caps | Absent | Threat model §8 open item |
| Memory stores | Early hosted feature | Absent | Deliberately deferred; Osaurus notes in [agentos-osaurus-prior-art.md](../references/agentos-osaurus-prior-art.md) are the shelf material |
| Event topology | Full vocabulary incl. streaming chunks, MCP tool events | Partial — tracked in [managed-agents-event-topology.md](../references/managed-agents-event-topology.md) (#77) | Parity polish, not capability |

## Current focus (2026-07-06)

With the capability track's foundation (egress + secrets) done, the next pass
is a **deliberate turn to the product layer (Arcs A–D)** — finish what makes an
operator able to hold the appliance — **before** returning to the capability
track's skills + MCP. Rationale: the enabling gap is closed, so skills/MCP are
unblocked whenever we return; meanwhile the visible product (packaging polish,
admin API + dashboard, health, metering) is what turns "the hard parts work"
into "the appliance exists" (exit criteria below).

## Arcs, in order

### Arc A — Appliance packaging + first boot — 🟡 slice 1 shipped (#135)

One entrypoint (`npx open-managed-agents` and/or one Dockerfile + compose with
a volume): start → init durable DB → mint admin credential, print once → serve
API and console from one process. Small; forces every "how does an operator
hold this" question to be answered. Ship first.

**Done (slice 1, #135):** `bin/open-managed-agents` + `src/main.ts` +
Dockerfile + compose boot the durable authenticated server and mint/print the
first-boot key. **Done (2026-07-06, via plan 0120):** the console is served
from the same process at `/console` — no dev proxy. **Remaining:**
compose/docs for docker-local egress (docker.sock mount +
`OMA_EGRESS_SIDECAR_IMAGE` + `OMA_MASTER_KEY`).

### Arc B — Admin API + real dashboard — ✅ DONE (2026-07-06)

Slice 1 (#151, plan 0119): workspace/key CRUD over authenticated `/admin`
routes behind a distinct admin credential — the first operator-vs-tenant
boundary. Slice 2 (plan 0120): the console, served by the appliance at
`/console`, gained admin mode (live workspace/key CRUD, plaintext-shown-once
minting) and read-only `/v1` browsing with a workspace key — self-contained
assets, in-memory-only browser keys, fail-closed credential transport.
Follow-ups: #152 (mint idempotency guard), #155 (vendored-asset checksums),
#156 (5xx demo-fallback UX).

### Arc C — Observability

**DONE (2026-07-06, plan [0121](0121-observability.md), two PRs: C1 logger +
redaction, C2 endpoints + metrics).** `GET /health` (liveness + readiness,
node-based compose healthcheck), fail-closed `/metrics` (loopback open,
non-loopback 404 unless `OMA_METRICS_TOKEN`; hand-rolled zero-dep registry
with closed-enum labels), structured JSON logs through one redacting
chokepoint, threat-model §5 decided. Console surfacing deferred to a later
console polish slice (the API it needs now exists).

### Arc D — Usage metering

Populate session `usage` per workspace from span-level model usage (the
follow-up plan 0084's schema findings already designate). Prerequisite for
SaaS; immediately useful in the dashboard.

### Capability track — egress boundary, then skills/MCP

Runs alongside A–D rather than after them (an appliance whose agents can't
reach the network or use skills demos poorly):

1. ✅ **DONE (2026-07-06).** Egress proxy + secrets: confidence probes, then
   the ADR, per the
   [buy-vs-build survey](../references/egress-secrets-buy-vs-build.md)
   (vendored sandbox-runtime proxy stack; envelope-encrypted `SecretsStore` in
   SQLite). Shipped as 0117a–e + 0118 (#136–#150); ADR 0016. Closed #130 and
   threat model §3/§4.
2. ⬜ Skills execution (mount skill files/instructions into the sandbox). **Now
   unblocked** — the next capability step when the product-layer pass pauses.
3. 🟨 MCP server connections — **M1 execution shipped 2026-07-07** (plan 0122:
   control-plane `@modelcontextprotocol/sdk` client, streamable HTTP,
   SSRF-guarded, `always_ask` default, gated by `OMA_ENABLE_MCP`).
   **M2 vaults + `static_bearer` shipped 2026-07-09** (#167: `/v1/vaults` +
   credentials CRUD, byte-exact URL resolution, control-plane-only bearer
   injection, `mcp_authentication_failed_error`; tokens in `SecretsStore`,
   live-smoke-proven never to reach the sandbox or event stream — the exit
   criterion's MCP half is DONE). M3 `mcp_oauth` refresh remains.

## Deferred, with seams kept clean

- **Postgres store backend** — behind the existing store interfaces; starts
  when scale-out starts, not before.
- **Shared-state admission counters** — in-process counters are correct for
  single-node (0113 D9); multi-worker revisit noted in 0112.
- **SaaS control plane** (billing, org accounts, hosted onboarding) — after
  usage metering exists.
- **Memory stores, task budgets, repo mounts** — after the capability track's
  foundations.
- **Parity polish** (#64 beta/version/405 parity, #77 event topology, #52
  N+1, Docker materialization #55/#56) — real but not strategic; schedule
  opportunistically between arcs.

## Cautionary prior art

[open-ma](../references/oma-implementations-prior-art.md) is the market proof
of this roadmap: the most complete competitor is far ahead exactly on the
product layer (auth UI, console, billing, deploy story) — and also the warning
(5.8k-line god-file, no CI test gate despite 151 test files). We add the
product layer with the narrow-surface, probe-first, test-walled rigor that got
the core right.

## Exit criteria for "the appliance exists"

- A newcomer with Node or Docker installs OMA with one command, reaches the
  dashboard, mints a workspace key, and runs an Anthropic-SDK quickstart
  against it — without reading the repo.
- The instance survives restart with all state intact (already true) and
  reports its own health (Arc C).
- An agent in a workspace can use at least one skill and one MCP server whose
  credentials it cannot read (capability track).
