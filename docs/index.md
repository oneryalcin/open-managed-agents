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
   Docker-local's role, parallel-session smoke, and production deployment shape

## Tutorials

- [First Docker-local run](tutorials/docker-local-first-run.md) — run the
  current MVP path with deployment config, Pi, Docker-local bash, translated
  tool events, and cleanup verification.

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

## How this is organized

Top-level docs explain *what we're building and why*. ADRs capture *individual decisions* and the alternatives considered. Add a new ADR for any decision that future-you (or a contributor) might want to challenge — name it `NNNN-short-kebab-title.md`, append a row to the list above.

If a doc becomes a working scratchpad rather than a stable reference, prefix it with `scratch-` so readers know it's volatile.
