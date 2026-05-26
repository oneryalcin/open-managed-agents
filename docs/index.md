# open-managed-agents docs

Design-first home for an open-source clone of Anthropic's [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview), self-hostable on Modal / K8s / Docker.

**Status:** Design + stored HTTP surface. The architecture docs are still the source of intent, and the repo now has working TypeScript for the EventStore/Broadcaster primitives plus Agents, Environments, and Sessions APIs. Events-over-HTTP, Pi, and Modal remain intentionally unwired.

## Reading order

1. [Scope](scope.md) — what's in the MVP slice, what's deferred, what's a non-goal
2. [Architecture](architecture.md) — the three-tier decomposition and how Pi's `AgentSession` primitives map to Managed Agents endpoints
3. [Roadmap](roadmap.md) — current implementation state and the next cycles
4. [References](references.md) — upstream docs, SDK docs, related projects we evaluated

## Working notes

- [Scratch: Pi 0.75.4 empirical findings](scratch-pi-findings.md) — what we learn from probing Pi; feeds back into the ADRs below as decisions firm up.
- [Threat model (stub)](threat-model.md) — security categories to fill in before multi-tenant deployment or untrusted users.

## Current smoke checks

Run from the repo root:

```bash
npm test
npm run typecheck
npx tsx scratch/05-event-store.ts
npx tsx scratch/06-agents-api.ts
npx tsx scratch/07-b1-api.ts
```

## Architecture Decision Records

The decisions we've already made, with the alternatives we rejected and why:

- [ADR 0001: Use Pi Agent SDK as engine](adrs/0001-use-pi-agent-sdk-as-engine.md)
- [ADR 0002: TypeScript end-to-end](adrs/0002-typescript-end-to-end.md)
- [ADR 0003: Pluggable sandbox interface, Modal first](adrs/0003-pluggable-sandbox-interface-modal-first.md)
- [ADR 0004: Managed Agents REST/SSE surface as north star](adrs/0004-managed-agents-rest-sse-surface-as-north-star.md)
- [ADR 0005: Custom tools as blocking async functions](adrs/0005-custom-tools-as-blocking-async-functions.md)
- [ADR 0006: One-time supply-chain quarantine override for Pi 0.75.4](adrs/0006-one-time-supply-chain-override-pi-0.75.4.md)
- [ADR 0007: Borrow Flue's algorithm-level patterns, not the framework](adrs/0007-flue-patterns-we-are-borrowing.md)
- [ADR 0008: Contract-test patterns — spec-first specs, alignment lints, CI smoke](adrs/0008-contract-test-patterns.md)
- [ADR 0009: SSE stream reconnect invariants — fail-open cursors, atomic-batch fanout](adrs/0009-sse-stream-reconnect-invariants.md)

## How this is organized

Top-level docs explain *what we're building and why*. ADRs capture *individual decisions* and the alternatives considered. Add a new ADR for any decision that future-you (or a contributor) might want to challenge — name it `NNNN-short-kebab-title.md`, append a row to the list above.

If a doc becomes a working scratchpad rather than a stable reference, prefix it with `scratch-` so readers know it's volatile.
