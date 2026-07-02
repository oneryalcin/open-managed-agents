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

## Where the repo stands against that vision (verified 2026-07-02)

Done — the invisible hard parts:

- Wire-compatible core: agents, environments, sessions, files + mount
  snapshots, SSE events, idempotency, interrupts, custom tools, tool
  confirmations, crash recovery, durable SQLite, sandboxed builtin execution.
- Multi-tenancy on one node: hashed API-key workspaces, fail-closed
  `OMA_AUTH_MODE`, per-workspace admission limits, operator CLI, rollback
  runbook, load harness (plan 0113 / #129).

Greenfield or stub — the visible product parts:

- **Packaging: nothing.** No Dockerfile, no compose, no `bin` entry; the
  server boots via `npx tsx examples/.../oma-server.ts`.
- **First boot: nothing.** Provisioning is a separate CLI with direct DB
  access.
- **Dashboard: read-only stub.** `ui/managed-agents-console` is a static
  console with a dev proxy and demo-data fallback; all mutations disabled; no
  admin capability, and no admin HTTP API for it to call.
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
| Skills | Loaded into session container | **Wire-accepted, runtime-inert** (`skills` parsed/stored/echoed; nothing in `sessions/pi/` consumes it) | Fundamentally files + instructions into the sandbox; no heavy dependency |
| MCP servers | Sessions connect, auth handled | **Wire-accepted, runtime-inert** (`mcp_servers` same story) | Client is a small protocol dep; blocked by egress |
| Sandbox networking | `environment.config.networking: {type: "limited", allowed_hosts}` | Absent — env `config` is opaque `JsonObject`; sandbox is `--network none` | **The enabling gap**: skills, MCP, web tools, repo mounts all sit behind it |
| Secret handling | Vault + boundary injection; secrets never in sandbox | Absent (design decided: see buy-vs-build survey; #130) | Same egress boundary does allowlist + injection |
| Session usage | Cumulative token usage per session | `usage: null` | Wire schema + span-level usage already captured in [observability schema findings](../references/managed-agents-observability-schema-findings.md); metering = aggregation |
| GitHub repo mounts | With out-of-band token injection | Absent | After egress + secrets |
| Task budgets | `task_budgets` token caps | Absent | Threat model §8 open item |
| Memory stores | Early hosted feature | Absent | Deliberately deferred; Osaurus notes in [agentos-osaurus-prior-art.md](../references/agentos-osaurus-prior-art.md) are the shelf material |
| Event topology | Full vocabulary incl. streaming chunks, MCP tool events | Partial — tracked in [managed-agents-event-topology.md](../references/managed-agents-event-topology.md) (#77) | Parity polish, not capability |

## Arcs, in order

### Arc A — Appliance packaging + first boot

One entrypoint (`npx open-managed-agents` and/or one Dockerfile + compose with
a volume): start → init durable DB → mint admin credential, print once → serve
API and console from one process. Small; forces every "how does an operator
hold this" question to be answered. Ship first.

### Arc B — Admin API + real dashboard

Workspace/key CRUD over authenticated `/admin` routes (the CLI logic already
exists against the store; this exposes it over HTTP behind a distinct admin
credential — the first real RBAC decision). Console gains admin mode and live
mutations, replacing its read-only stub posture.

### Arc C — Observability

Health endpoint, Prometheus-style `/metrics`, structured logs; surfaced in the
console. This is the 0112 gate "blocks multi-worker/managed production" and
the precondition for admitting less-trusted tenants. Log-redaction design
(threat model §5) belongs to this arc — what we emit and what we persist are
one decision.

### Arc D — Usage metering

Populate session `usage` per workspace from span-level model usage (the
follow-up plan 0084's schema findings already designate). Prerequisite for
SaaS; immediately useful in the dashboard.

### Capability track — egress boundary, then skills/MCP

Runs alongside A–D rather than after them (an appliance whose agents can't
reach the network or use skills demos poorly):

1. Egress proxy + secrets: confidence probes, then the ADR, per the
   [buy-vs-build survey](../references/egress-secrets-buy-vs-build.md)
   (vendored sandbox-runtime proxy stack; envelope-encrypted `SecretsStore` in
   SQLite). Closes #130 and threat model §3/§4.
2. Skills execution (mount skill files/instructions into the sandbox).
3. MCP server connections (MCP TS SDK client; tokens via `SecretsStore`,
   injected at the boundary).

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
