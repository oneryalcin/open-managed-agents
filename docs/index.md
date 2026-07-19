# open-managed-agents docs

Design-first home for an open-source clone of Anthropic's [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview), self-hostable on your own machines.

**Status:** pre-v1 alpha. The synchronous single-agent core works: versioned
agents, environments, sessions, session events, SSE replay, Pi runtime wiring,
provider-owned tools, skills, MCP/vault credentials, Docker-local and
microsandbox-local execution, and the bundled console. Full Claude Managed
Agents product parity remains tracked in [PARITY.md](../PARITY.md).

## Reading order

1. [Getting Started](getting-started.md) — the canonical source-checkout alpha flow
2. [Scope](scope.md) — what's in the current slice, what's deferred, what's a non-goal
3. [Architecture](architecture.md) — the three-tier decomposition and how Pi's `AgentSession` primitives map to Managed Agents endpoints
4. [Roadmap](roadmap.md) — current implementation state and the next cycles
5. [References](references.md) — upstream docs, SDK docs, related projects we evaluated
6. [Examples](examples.md) — executable parity examples against external tutorial flows
7. [Development and deployment setup](dev-deployment.md) — Make targets,
   Docker-local's role, parallel-session smoke, workspace authentication and
   key provisioning, and production deployment shape

## Tutorials

- [First Docker-local run](tutorials/docker-local-first-run.md) — Docker-local
  details and lower-level smoke context after the canonical
  [Getting Started](getting-started.md) flow.

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
- [Threat model](threat-model.md) — tenant boundary, auth, DoS, and log-redaction sections describe shipped mechanisms (plans 0113, 0121 C1); egress + secrets are design-decided (ADR 0016, shipped); teardown remains open before untrusted multi-tenant deployment.
- [Egress + secrets buy-vs-build survey](references/egress-secrets-buy-vs-build.md) — verdict: vendor Anthropic's sandbox-runtime proxy stack for allowlist + sentinel-substitution egress; envelope-encrypt secrets in our own SQLite (no vault dependency, OpenBao as a designed-for-later backend).

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
- [Appliance product roadmap](plans/0114-appliance-product-roadmap.md) —
  product direction after #129: install-and-go appliance (packaging, admin
  dashboard, observability, usage metering) plus the egress→skills→MCP
  capability track; names what is deferred and which seams keep it cheap.
- [Appliance entrypoint and first boot](plans/0115-appliance-entrypoint.md) —
  Arc A slice 1: the appliance launcher (now exposed as `oma up`) plus
  `startAppliance` defaults, first-boot key minting, Dockerfile/compose, and
  the no-build-step decision.
- [Alpha OpenAPI documentation](plans/0135-alpha-openapi-docs.md) —
  schema-backed `/openapi.json`, vendored `/docs/`, route/spec completeness,
  and credential-safe interactive documentation.
- [Pi-backed multi-provider models](plans/0139-pi-multi-provider-models.md) —
  exact provider/model identity on immutable agents, one shared Pi catalog and
  auth owner, operator-defined compatible endpoints, and secret-safe
  CLI/API/console discovery for the alpha path.
- [Alpha coding sandbox image](plans/0140-alpha-coding-sandbox-image.md) —
  the digest-pinned Node/npm, Python/uv, Git, and native-build guest shared by
  Docker-local and microsandbox-local without widening default-deny egress.
- [Single-node durable storage design](plans/0103-phase-2-storage-design.md) —
  implementation design for #103 Phase 2 storage consolidation.
- [POST /v1/sessions idempotency](plans/0105-session-create-idempotency.md) —
  design/audit plan for extending `Idempotency-Key` from `events.send` to
  session creation without duplicating sessions, snapshots, or runtime prep.

## Current onboarding checks

Run from the repo root:

```bash
npm ci
node bin/oma.mjs --help
node bin/oma.mjs doctor
node bin/oma.mjs smoke --local-compatible
npm run typecheck
npm test
```

`oma doctor` is a diagnostic command: it may exit `1` until blocking local
readiness issues such as Docker availability or port conflicts are fixed.
Missing model credentials are a warning so the no-paid local-compatible proof
remains available. Doctor must always remain read-only.

The Makefile still wraps lower-level developer checks:

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
- [ADR 0016: Egress proxy and boundary secret injection](adrs/0016-egress-proxy-and-secret-injection.md) — OMA-owned egress proxy (vendored srt stack) with allowlist + sentinel substitution, and envelope-encrypted `SecretsStore` in SQLite; closes #130 and threat-model §3/§4.

## How this is organized

Top-level docs explain *what we're building and why*. ADRs capture *individual decisions* and the alternatives considered. Add a new ADR for any decision that future-you (or a contributor) might want to challenge — name it `NNNN-short-kebab-title.md`, append a row to the list above.

If a doc becomes a working scratchpad rather than a stable reference, prefix it with `scratch-` so readers know it's volatile.
