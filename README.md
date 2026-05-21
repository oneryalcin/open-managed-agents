# open-managed-agents

An open-source clone of Anthropic's [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) API surface. **Control plane runs as a single Node process**; sandboxes (Modal first, K8s later) are the part that runs "anywhere."

**Status:** Design + first HTTP slice. The docs and EventStore/Broadcaster primitives are in place, and the Agents API (`POST /v1/agents`, `GET /v1/agents`, `GET /v1/agents/{id}`) is implemented and covered by tests. Sessions, environments, Pi runtime wiring, and Modal sandbox execution are next.

## What this is

A REST + SSE control plane that exposes the Managed Agents endpoints (`/v1/agents`, `/v1/sessions`, `/v1/environments`, `/v1/sessions/{id}/events`) and runs the agent loop behind it — but on infrastructure you control instead of Anthropic's. Clients written against Anthropic's hosted Managed Agents should target this with a base-URL swap; see [docs/adrs/0004 — Compatibility Tiers](docs/adrs/0004-managed-agents-rest-sse-surface-as-north-star.md) for what's wire-compatible vs. allowed-to-deviate.

**Scope today:**
- ✅ Single-process control plane foundation (Hono, SQLite stores, Anthropic-shaped errors)
- ✅ Agents API persisted in SQLite with typed route/service/store boundaries
- ✅ Append-only EventStore + replay-then-tail broadcaster with reconnect/overflow probes
- ✋ Sessions/events HTTP routes are next; Pi and Modal are intentionally not wired yet
- ✋ Pluggable sandbox layer — Modal first, K8s/Docker via the same interface later
- ✋ Horizontal scaling (multi-process control plane) is post-MVP — pending-call state is process-local; see [scope.md](docs/scope.md) and [ADR 0005](docs/adrs/0005-custom-tools-as-blocking-async-functions.md).

## Current smoke checks

```bash
npm test
npm run typecheck
npx tsx scratch/05-event-store.ts
npx tsx scratch/06-agents-api.ts
```

`scratch/06-agents-api.ts` starts a real Hono server, creates an agent, retrieves it, lists it, and verifies the public error envelope.

## Planned stack

| Layer | Choice | Rationale |
|---|---|---|
| Engine | [Pi Agent SDK](https://pi.dev/docs/latest/sdk) (`@earendil-works/pi-coding-agent`) | Library-shaped, async-tool model, explicit session primitives |
| Control plane | TypeScript + [Hono](https://hono.dev) | Lightweight, first-class SSE, runtime-agnostic |
| Sandbox | [Modal Sandboxes](https://modal.com/docs/guide/sandbox) (first impl) | Purpose-built per-session containers; pluggable interface for K8s/Docker later |
| Persistence | SQLite → Postgres later | Start simple |

## Decisions made

See [docs/adrs/](docs/adrs/). Reading order is in [docs/index.md](docs/index.md). The implementation plan is tracked in [docs/roadmap.md](docs/roadmap.md).

## License

TBD — likely Apache-2.0.
