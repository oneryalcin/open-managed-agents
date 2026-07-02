# open-managed-agents docs

Design-first home for an open-source clone of Anthropic's [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview), self-hostable on Modal / K8s / Docker.

**Status:** MVP control plane with proven Docker-local execution. The repo has
working TypeScript for persisted agents, environments, sessions, session
events, SSE replay, Pi runtime wiring, custom tools, and a deployment-gated
Docker-local sandbox provider. Full Anthropic Managed Agents tutorial parity is
still tracked separately in the roadmap.

## Reading order

1. [Scope](scope.md) — what's in the MVP slice, what's deferred, what's a non-goal
2. [Architecture](architecture.md) — the three-tier decomposition and how Pi's `AgentSession` primitives map to Managed Agents endpoints
3. [Roadmap](roadmap.md) — current implementation state and the next cycles
4. [References](references.md) — upstream docs, SDK docs, related projects we evaluated
5. [Examples](examples.md) — executable parity examples against external tutorial flows
6. [Development and deployment setup](dev-deployment.md) — Make targets,
   Docker-local's role, parallel-session smoke, workspace authentication and
   key provisioning, and production deployment shape

## Tutorials

- [First Docker-local run](tutorials/docker-local-first-run.md) — run the
  current MVP path with deployment config, Pi, Docker-local bash, translated
  tool events, and cleanup verification.

## Cookbooks

- [Retry-safe `events.send`](cookbooks/retry-safe-events-send.md) — use
  `Idempotency-Key` with the official Python and TypeScript SDKs so client
  retries do not duplicate session events or runtime work.
- [Retry-safe `sessions.create`](cookbooks/retry-safe-session-create.md) — use
  `Idempotency-Key` so client retries do not create duplicate sessions,
  session resources, or internal mount snapshots.
- [Client retry and cleanup loop](cookbooks/client-retry-and-cleanup.md) —
  combine retry-safe `events.send`, SSE reconnect, list backfill, event dedupe,
  and session deletion.
- [Session lifecycle flow](cookbooks/session-lifecycle-flow.md) — wire the
  SDK-style create, stream/list, retry-safe send, interrupt, archive, and delete
  path with terminal event handling.

## Examples

- [Ship Your First Managed Agent](examples/ship-your-first-managed-agent.md) —
  run the official workshop's Python SDK flow against local OMA with file
  upload, Docker-local sandboxing, event streaming, replay, and cleanup.

## Working notes

- [Scratch: Pi 0.75.4 empirical findings](scratch-pi-findings.md) — what we learn from probing Pi; feeds back into the ADRs below as decisions firm up.
- [Threat model (stub)](threat-model.md) — security categories to fill in before multi-tenant deployment or untrusted users.

## Implementation plans

- [Session file-resource control plane](plans/0043-session-file-resource-control-plane.md) — PR-A plan for issue #43, covering session resource parsing,
  mount-path normalization, internal snapshots, and non-Docker acceptance
  tests.
- [Managed Agents UI parity](plans/0097-managed-agents-ui-parity.md) — first
  repo-local console plan for agents, sessions, transcript/debug views, spans,
  and session output downloads.
- [Deployment hardening](plans/0103-deployment-hardening.md) — production
  shape for API/control-plane, runtime workers, Docker-local, durable stores,
  and admission limits.
- [Sandbox provider landscape and first probes](plans/0106-sandbox-provider-landscape.md) —
  audit local, self-hosted, Kubernetes, and hosted sandbox substrates before
  adding remote provider implementations.
- [Sandbox provider contract audit](plans/0107-sandbox-provider-contract-audit.md) —
  provider-neutral contract vocabulary for durable workspaces, lifecycle,
  execution, network policy, secrets, observability, and cleanup.
- [Microsandbox-local provider](plans/0110-microsandbox-local-provider.md) —
  first implementation slice for the self-hosted no-Kubernetes microVM
  provider, with explicit volume workspace, deny-network default, cleanup, and
  no secret proxy support.
- [Runtime coordinator seam audit](plans/0111-runtime-coordinator-seam-audit.md) —
  issue #113 audit of remaining runtime-change commit paths, with each direct
  `appendBatchWithRuntimeChanges` caller classified as coordinator-fenced,
  store-fenced, or lifecycle-owned.
- [Pi runtime rollout policy](plans/0112-pi-runtime-rollout-policy.md) —
  issue #16 policy for when the deployment Pi runtime may be used in local,
  demo, single-node durable, and future production modes.
- [Workspace authentication and admission control](plans/0113-workspace-authentication-admission.md) —
  issue #129 ADR for `x-api-key` workspace identity (wire-probed hosted 401
  envelope and middleware ordering), hashed key storage, fail-closed
  `OMA_AUTH_MODE`, and the admission-limit shape that keys off it.
- [Single-node durable storage design](plans/0103-phase-2-storage-design.md) —
  implementation design for #103 Phase 2 storage consolidation.
- [POST /v1/sessions idempotency](plans/0105-session-create-idempotency.md) —
  design/audit plan for extending `Idempotency-Key` from `events.send` to
  session creation without duplicating sessions, snapshots, or runtime prep.

## Current smoke checks

Run from the repo root:

```bash
npm test
npm run typecheck
npx tsx scratch/05-event-store.ts
npx tsx scratch/06-agents-api.ts
npx tsx scratch/07-b1-api.ts
npx tsx scratch/23-e3-deployment-docker-smoke.ts
npx tsx scratch/40-docker-parallel-sessions-smoke.ts
```

The Makefile wraps the common checks:

```bash
make check
make docker-smoke
make parallel-docker-smoke
```

## Architecture Decision Records

The decisions we've already made, with the alternatives we rejected and why:

- [ADR 0001: Use Pi Agent SDK as engine](adrs/0001-use-pi-agent-sdk-as-engine.md)
- [ADR 0002: TypeScript end-to-end](adrs/0002-typescript-end-to-end.md)
- [ADR 0003: Pluggable sandbox provider boundary](adrs/0003-pluggable-sandbox-provider-boundary.md)
- [ADR 0004: Managed Agents REST/SSE surface as north star](adrs/0004-managed-agents-rest-sse-surface-as-north-star.md)
- [ADR 0005: Custom tools as blocking async functions](adrs/0005-custom-tools-as-blocking-async-functions.md)
- [ADR 0006: One-time supply-chain quarantine override for Pi 0.75.4](adrs/0006-one-time-supply-chain-override-pi-0.75.4.md)
- [ADR 0007: Borrow Flue's algorithm-level patterns, not the framework](adrs/0007-flue-patterns-we-are-borrowing.md)
- [ADR 0008: Contract-test patterns — spec-first specs, alignment lints, CI smoke](adrs/0008-contract-test-patterns.md)
- [ADR 0009: SSE stream reconnect invariants — fail-open cursors, atomic-batch fanout](adrs/0009-sse-stream-reconnect-invariants.md)
- [ADR 0010: Cassette strategy for Pi translation](adrs/0010-cassette-strategy-for-pi-translation.md)
- [ADR 0011: Tool correlation ID model (`sevt_*` vs `toolu_*`)](adrs/0011-tool-correlation-id-model.md)
- [ADR 0012: Session continuity keyed by `sesn_*` before C.3 live validation](adrs/0012-session-continuity-before-c3-live.md)
- [ADR 0013: File resources and session mounts](adrs/0013-file-resources-and-session-mounts.md)
- [ADR 0014: Storage engine strategy for managed SaaS](adrs/0014-storage-engine-strategy.md)
- [ADR 0015: Request idempotency for retry-safe writes](adrs/0015-request-idempotency.md)

## How this is organized

Top-level docs explain *what we're building and why*. ADRs capture *individual decisions* and the alternatives considered. Add a new ADR for any decision that future-you (or a contributor) might want to challenge — name it `NNNN-short-kebab-title.md`, append a row to the list above.

If a doc becomes a working scratchpad rather than a stable reference, prefix it with `scratch-` so readers know it's volatile.
