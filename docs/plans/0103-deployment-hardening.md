# 0103 - Deployment Hardening

## Context

Issue: [#103](https://github.com/oneryalcin/open-managed-agents/issues/103)

OMA now has a developer Makefile, a Docker-local server path, and a cheap
parallel Docker smoke. That is enough for local development and single-node
demos, but not enough to describe a real deployment.

Current facts this plan depends on:

- `docs/dev-deployment.md` defines the supported local shape as host-run OMA
  plus local Docker daemon, with Docker used for sandbox containers rather than
  for the control-plane process.
- `src/control-plane/deployment-runtime-config.ts` requires
  `OMA_SANDBOX_PROVIDER` and keeps `docker-local` behind
  `OMA_ALLOW_DOCKER_LOCAL=true`.
- `src/control-plane/sessions/pi/runner.ts` stores live runtime handles in an
  in-process session-keyed map. Different sessions can have different handles;
  same-session messages are follow-ups while the handle is already running.
- The current deployment app opens four separate `:memory:` stores. That means
  runtime owner/generation fencing is durable only inside one process lifetime;
  it is not a cross-process coordination mechanism yet.
- Session liveness and runtime/event ownership currently live in separate store
  instances. Any future guarantee that combines those facts in "one durable
  transaction" first requires a shared transactional store boundary.
- `src/control-plane/sessions/pi/sandbox/docker.ts` creates one Docker
  container per session/provider handle, with `--network none`, `--read-only`,
  dropped capabilities, tmpfs workspace/uploads/outputs mounts, memory and PID
  limits, and uid/gid `65534:65534`.
- `host-passthrough` is already selectable through deployment config, behind
  explicit unsafe env flags. It is useful for trusted local tests only and is a
  worse isolation shape than any Docker-socket Compose shortcut.
- `docs/threat-model.md` still names deployment gaps explicitly: sandbox
  teardown, authentication/authorization, concurrent sandbox limits, runtime
  limits, token budget, and event-log limits.

The parallel smoke added in #104 proves the local Docker provider can hold
several isolated session sandboxes at once without spending model tokens. It
does not prove production parallelism, multi-process ownership, or safe
multi-tenant admission control.

## Goal

Define the deployment hardening path that turns OMA from "local MVP / demo
server" into a design that can safely evolve toward production:

- supported local setup;
- Docker socket stance;
- control-plane vs runtime-worker boundary;
- durable metadata and object-storage boundary;
- admission limits and overload behavior;
- verification steps before any real multi-instance deployment.

The near-term target is **single-node durable**, not a worker pool. Worker-pool
architecture remains a later target only after the shared durable store and
transactional ownership boundary exist.

This is primarily an architecture plan. Implementation should be split into
small PRs after this plan is reviewed.

## Non-Goals

- Do not build a production auth system in this slice.
- Do not replace all stores in this documentation slice. The first
  implementation phase after this plan should replace the current deployment
  app's `:memory:` stores with one shared, file-backed transactional store
  before claiming any multi-process safety.
- Do not implement Modal, Kubernetes, Fly Machines, or any new remote sandbox
  provider in this slice.
- Do not make Docker Compose the production story.
- Do not expose Docker socket access as a normal supported deployment mode.
- Do not treat `host-passthrough` as a sandbox or a production provider.
- Do not change the Managed Agents public API surface unless an admission-limit
  error requires a documented Anthropic-shaped error envelope.

## Principles

1. **Boring local development:** Make targets should remain thin wrappers around
   explicit commands and env vars.
2. **No hidden host execution:** Sandboxes must not receive the Docker socket,
   host credentials, or unreviewed host mounts.
3. **API and runtime are separable:** HTTP request handling and live sandbox
   ownership should be able to run in different processes eventually, but not
   before the shared store can coordinate them.
4. **Durability owns correctness:** Multi-owner safety must be enforced in the
   durable commit boundary, not in process-local maps.
5. **Fail visibly under pressure:** Admission limits should return structured
   overload/rate-limit style errors; they should not silently queue unbounded
   work.

## Decision Drivers

- **Security:** Docker socket access is effectively host root access. It cannot
  become a casual default.
- **Operational clarity:** Users need to know whether they are running a local
  demo, a single-node self-hosted deployment, or a future multi-worker
  deployment.
- **Migration path:** The current owner/generation runtime ledger is valuable;
  the plan should preserve it while moving the decisive checks into durable
  storage.
- **Honest scope:** OMA is currently scoped as a self-hosted, single-operator
  MVP. The next hardening step should remove avoidable data-loss/restart gaps
  before adopting a larger worker-pool shape.

## Options

### Option A - Host-run control plane + Docker-local sandboxes for dev

Run the OMA server directly on the host and let it create Docker-local sandbox
containers through the local Docker daemon.

Pros:

- Matches the current implementation and smoke tests.
- Keeps the Docker socket out of app containers and sandbox containers.
- Easiest path for contributors to debug Node, Hono, Pi, and Docker separately.

Cons:

- Not a containerized app deployment.
- Single-node only.
- Still requires local Docker privileges for the developer account.

### Option B - Docker Compose with control-plane container mounting Docker socket

Run the control plane in a container and mount `/var/run/docker.sock` so it can
create sibling sandbox containers.

Pros:

- Familiar "docker compose up" developer story.
- More closely resembles packaged deployment.

Cons:

- Mounting the Docker socket gives the control-plane container host-level power.
- Easy for users to mistake a dev convenience for a production-safe setup.
- Does not help the sandbox containers themselves; it only moves the API
  process into a container.

### Option C - API service + separate runtime worker pool

Run the API/control-plane service separately from runtime workers. Workers claim
accepted turns from durable storage, own live Pi/sandbox handles, and commit
events/state through owner-fenced durable transactions.

Pros:

- Correct production shape for scaling, worker restarts, and provider diversity.
- Lets Docker-local remain a single-node worker provider while Modal/Kubernetes
  become worker backends later.
- Makes admission control and overload behavior explicit.

Cons:

- Requires durable storage semantics beyond the current in-process MVP.
- Requires a worker lifecycle, reconciliation loop, and operational metrics.
- Larger implementation path than local dev ergonomics.
- Does not preserve live Docker-local tmpfs compute state across worker death;
  recovery can terminalize or restart work, but it cannot continue the same
  in-container process.

### Option D - Single-node durable runtime

Keep one OMA process owning live runtime handles, but replace the deployment
app's `:memory:` stores with a shared, file-backed transactional store and local
object directory. Keep Docker-local as the sandbox provider.

Pros:

- Matches the self-hosted MVP workload without inventing distributed machinery.
- Makes current owner/generation, session liveness, files, and event rows
  observable across process restarts.
- Creates the prerequisite durable boundary for later admission controls and
  worker extraction.

Cons:

- Still single-node.
- Does not solve horizontal scale.
- Requires careful migration from the four independent store instances to one
  transaction-capable deployment store.

## Decision

Adopt **Option A for supported local development**, **Option D as the next
deployment hardening target**, and **Option C only as the later production
architecture target after Option D exists**.

Do **not** make Option B the default. A Compose file may be added later only as
an explicitly dev-only wrapper, with the Docker socket risk documented in the
file, docs, and README. It must not be described as a production deployment.

Do **not** start with a worker pool while the deployment app still uses separate
`:memory:` stores. That would create coordination code with nothing durable to
coordinate.

## Target Architecture

### Control Plane

Owns:

- REST and SSE endpoints;
- request validation and Anthropic-shaped error envelopes;
- agents, environments, sessions, files, and event listing;
- custom-tool and tool-confirmation API correlation;
- admission checks before runtime work is accepted.

Must not own long-lived sandbox handles in the production target. In the MVP it
does, through `PiSessionRunner`. In the single-node durable target this remains
acceptable: one process owns live handles, and durable storage protects restart
and terminalization semantics. Only after the shared store is in place should
live runtime ownership move to workers.

### Durable Metadata Store

Owns:

- agents, environments, sessions;
- event rows and event cursors;
- file metadata;
- pending runtime turns;
- runtime owner id / owner generation;
- pending custom-tool and tool-confirmation waits;
- admission counters or leases.

Production correctness requirement: any liveness, delete/closed-session,
owner-generation, and quota checks that decide whether to commit events or files
must happen inside the same durable transaction as the commit.

Near-term deployment requirement: use one shared, file-backed SQLite database or
one explicitly shared `DatabaseSync` connection for the deployment app's stores.
Do not keep agents, environments, sessions, events, and files in independent
`:memory:` stores while claiming restart or cross-process safety.

### Object Storage

Owns bytes:

- uploaded files;
- internal session snapshots;
- session outputs.

The file metadata store should keep scope, ownership, visibility, and hashes.
The object store should provide byte streaming and deletion semantics.

### Runtime Workers

Own:

- claiming accepted runtime turns;
- creating/reusing Pi sessions;
- creating/reusing sandbox provider handles;
- collecting outputs on live owner-matched terminal idle;
- committing runtime events and runtime state through the durable store;
- cleanup/reconciliation of orphaned runtime resources.

Worker instances should be replaceable. A crash should leave durable state that
another worker can claim or terminalize without double-emitting events.

Worker replaceability does not imply live compute continuation for Docker-local.
If a worker dies, its tmpfs workspace dies or becomes untrusted. The supported
recovery semantics are terminalize/mark failed/restart future work, not resume
the same in-container process.

### Sandbox Providers

`docker-local` remains the single-node provider:

- one container per live session handle;
- no Docker socket in the sandbox;
- network disabled by default;
- tmpfs workspace/uploads/outputs;
- uid/gid `65534:65534`;
- memory/PID/CPU/operation/output limits.

Remote providers such as Modal or Kubernetes should implement the same logical
provider contract from the worker side, not from API routes.

`host-passthrough` is not a sandbox provider for production. It should remain a
guarded local/test provider with unsafe naming and explicit env gates. Any
deployment-hardening PR that discusses Docker socket risk must discuss
host-passthrough too, because it is already shipped and executes on the host.

## Implementation Plan

### Phase 1 - Documentation and Config Boundaries

1. Promote this plan into a deployment ADR after review.
2. Update `docs/dev-deployment.md` to distinguish:
   - local dev;
   - single-node self-hosted demo;
   - single-node durable deployment;
   - future multi-worker production.
3. Add a short Docker socket policy section:
   - sandbox containers never receive the socket;
   - host-run control plane is preferred for local Docker-local;
   - Compose-with-socket, if added, is explicitly dev-only.
4. Add a host-passthrough policy section:
   - it is an unsafe trusted-local provider;
   - it must never be described as isolation;
   - it is not a production provider.
5. Update `docs/threat-model.md` with the chosen deployment stance and link to
   this plan/ADR.

Acceptance criteria:

- Docs name Docker socket access as a dev-only risk, not a production default.
- Docs say Docker-local supports single-node development/demo, not multi-tenant
  production.
- Docs say host-passthrough is trusted-local only and executes on the host.
- #103 links to the plan/ADR.

### Phase 2 - Single-Node Durable Store

Replace the deployment app's separate `:memory:` stores with a shared,
file-backed transactional store boundary before claiming restart or worker
coordination safety.

Implementation shape:

- Add deployment storage config, for example `OMA_SQLITE_PATH`.
- Create one deployment store factory that opens one database path/connection
  and hands transaction-compatible store views to agents, environments,
  sessions, events, and files.
- Keep existing in-memory factories for tests that intentionally want isolated
  ephemeral stores.
- Add startup validation that rejects a production/deployment mode configured
  with only independent `:memory:` stores.
- Record the chosen storage shape in the deployment ADR.

Acceptance criteria:

- Restarting the deployment server with the same SQLite path preserves agents,
  sessions, files, events, pending waits, and runtime ownership rows.
- A test proves session liveness and event/runtime ownership checks can be made
  in one durable transaction or explicitly identifies the remaining seam.
- The default example path remains easy for local dev, but no doc calls it
  production-safe while it is ephemeral.

### Phase 3 - Auth-Aware Local Admission Controls

Add an admission layer before runtime work is accepted in the current
single-node app. This is not the final distributed limit, but it prevents
obvious local overload and creates the public behavior.

Do not market per-workspace limits as multi-tenant security while workspace
identity is still unauthenticated/header-trusted. Before any untrusted
deployment, admission must run after authentication establishes the workspace.

Suggested limits:

- max concurrent running turns per workspace;
- max live Docker-local sandboxes per workspace;
- max live Docker-local sandboxes per process;
- max queued/follow-up messages per session;
- optional max runtime age / idle age before forced cleanup.

Implementation shape:

- Introduce a small typed admission service owned by the control plane.
- Read limit defaults from deployment config/env.
- In the trusted local mode, key limits by the internal workspace.
- In any exposed mode, require authentication to establish workspace identity
  before applying per-workspace limits.
- Return Anthropic-shaped `overloaded_error` or `rate_limit_error` responses
  when work is rejected.
- Emit structured logs with workspace/session/limit/reason context.

Acceptance criteria:

- Starting more than the configured concurrent sandbox limit fails visibly.
- Rejected work does not create accepted runtime turns.
- Existing tests for normal session execution continue to pass.
- A focused test proves same-session follow-up limits are enforced separately
  from cross-session sandbox limits.
- A test or documented guard proves per-workspace admission cannot be bypassed
  by changing an unauthenticated workspace header in an exposed deployment mode.

### Phase 4 - API-Level Parallel Smoke

The current smoke is provider-level. Add a deterministic API-level smoke once
the test runner can drive runtime execution without model spend.

Implementation options:

- Use an injected deterministic `RuntimeEventRunner` that still provisions
  Docker-local providers; or
- create an internal smoke-only agent/server path that invokes sandbox
  operations directly through the same runtime service boundaries.

Acceptance criteria:

- N sessions are created through the public API.
- N runtime tasks run concurrently.
- Each session writes distinct output files.
- Events, outputs, and cleanup remain isolated.
- The smoke fails if admission limits reject below N.

### Phase 5 - Durable Commit Boundary

Before multi-instance deployment, ensure correctness decisions are not split
across independent stores.

Required durable operations:

- claim accepted turn with owner id/generation;
- heartbeat or lease extension for active workers;
- commit runtime event batch only if owner/generation and session liveness still
  match;
- close/terminalize abandoned turn;
- commit session outputs only if owner/generation and session liveness still
  match;
- increment/decrement admission counters or leases atomically.

Acceptance criteria:

- A stale owner cannot append runtime events after another owner has claimed or
  terminalized the turn.
- A delete/archive racing an output collection cannot resurrect files.
- Admission counters survive process restart or are reconciled on startup.
- Tests cover stale-owner, delete-race, archive-race, and worker-crash windows.

### Phase 6 - Worker Process Boundary

Extract live runtime ownership into a worker-facing interface.

Suggested boundary:

```ts
interface RuntimeWorker {
  claimNextTurn(): Promise<ClaimedRuntimeTurn | undefined>;
  runClaimedTurn(turn: ClaimedRuntimeTurn): Promise<void>;
  reconcile(): Promise<void>;
  shutdown(): Promise<void>;
}
```

The exact interface should be designed when the durable operations exist. Do not
extract it prematurely into a second in-process abstraction that still relies on
memory for correctness.

Acceptance criteria:

- API process can accept/create sessions without owning a Pi session handle.
- Worker process can claim and run accepted turns.
- Restarting a worker does not lose pending custom-tool or tool-confirmation
  waits.
- Runtime events are still persisted before publish/replay.

## Risks and Mitigations

- **Risk: Compose makes an unsafe shape look official.** Mitigation: do not add
  Compose as the default; if added, name it dev-only and document Docker socket
  risk inline.
- **Risk: Single-process admission controls get mistaken for distributed
  limits.** Mitigation: docs and names should call them local limits until the
  durable lease implementation lands.
- **Risk: Admission limits are spoofable before auth.** Mitigation: local mode
  may use the internal workspace, but any exposed mode must authenticate the
  workspace before applying per-workspace limits.
- **Risk: Worker extraction creates spaghetti abstractions.** Mitigation: do not
  extract before durable operations are explicit; keep the first worker boundary
  claim/run/reconcile/shutdown.
- **Risk: The worker-pool design gets cargo-culted before demand.** Mitigation:
  ship single-node durable first; require evidence from smoke tests or real
  deployment needs before worker extraction.
- **Risk: Docker-local semantics bias remote provider design.** Mitigation:
  keep provider contract Pi-Operations-shaped and lifecycle-focused, as ADR 0003
  already recommends.
- **Risk: Overload errors diverge from Anthropic behavior.** Mitigation: use the
  existing error envelope and choose only documented error categories
  (`overloaded_error` / `rate_limit_error`) unless hosted probing proves
  otherwise.

## Verification

For documentation/config PRs:

```bash
make typecheck
make test
make parallel-docker-smoke
```

For admission-control PRs:

```bash
npm run typecheck
npx vitest run src/control-plane/__tests__
make parallel-docker-smoke
```

For durable-store/worker PRs:

- targeted store tests for owner/generation stale-owner paths;
- API tests for visible overload errors;
- restart/recovery tests for abandoned turns;
- output-indexing delete/archive race tests;
- SSE replay tests proving no event is published without durable persistence.

## Open Questions

1. What default local limits should ship first? A conservative starting point is
   `max_running_turns_per_workspace=4`, `max_live_sandboxes_per_process=4`, and
   `max_followups_per_session=10`, but these need real smoke numbers.
2. What is the minimum authentication model before per-workspace limits can be
   treated as security controls rather than local overload controls?
3. Should admission limits be per workspace only, or also per agent/environment?
4. Do we want a dev-only Compose file now, or should we wait until someone
   specifically needs it?
5. Which production provider should audit the worker boundary first: Modal or
   Kubernetes?
6. What is the narrowest storage consolidation that lets session liveness,
   runtime ownership, event append, and file-output commit share a transaction?

## Follow-ups

- Promote this plan to an ADR after review.
- Use [0103 Phase 2 - Single-Node Durable Storage Design](0103-phase-2-storage-design.md)
  as the implementation design for the storage consolidation commit.
- Add a scoped issue for Phase 2 single-node durable storage.
- Add a scoped issue for Phase 3 auth-aware admission controls.
- Add a scoped issue for Phase 4 API-level parallel smoke.
- Add a scoped issue for durable owner/lease store semantics before any
  multi-instance deployment.
