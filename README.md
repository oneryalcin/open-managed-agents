# open-managed-agents

An open-source clone of Anthropic's [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) API surface. **Control plane runs as a single Node process**; sandboxes (Modal first, K8s later) are the part that runs "anywhere."

**Status:** Design phase. No runtime code yet. See [docs/index.md](docs/index.md).

## What this is

A REST + SSE control plane that exposes the Managed Agents endpoints (`/v1/agents`, `/v1/sessions`, `/v1/environments`, `/v1/sessions/{id}/events`) and runs the agent loop behind it — but on infrastructure you control instead of Anthropic's. Clients written against Anthropic's hosted Managed Agents should target this with a base-URL swap; see [docs/adrs/0004 — Compatibility Tiers](docs/adrs/0004-managed-agents-rest-sse-surface-as-north-star.md) for what's wire-compatible vs. allowed-to-deviate.

**Scope today:**
- ✅ Single-process control plane (state in SQLite, event log append-only)
- ✅ Pluggable sandbox layer — Modal first, K8s/Docker via the same interface later
- ✋ Horizontal scaling (multi-process control plane) is post-MVP — pending-call state is process-local; see [scope.md](docs/scope.md) and [ADR 0005](docs/adrs/0005-custom-tools-as-blocking-async-functions.md).

## Planned stack

| Layer | Choice | Rationale |
|---|---|---|
| Engine | [Pi Agent SDK](https://pi.dev/docs/latest/sdk) (`@earendil-works/pi-coding-agent`) | Library-shaped, async-tool model, explicit session primitives |
| Control plane | TypeScript + [Hono](https://hono.dev) | Lightweight, first-class SSE, runtime-agnostic |
| Sandbox | [Modal Sandboxes](https://modal.com/docs/guide/sandbox) (first impl) | Purpose-built per-session containers; pluggable interface for K8s/Docker later |
| Persistence | SQLite → Postgres later | Start simple |

## Decisions made

See [docs/adrs/](docs/adrs/). Reading order is in [docs/index.md](docs/index.md).

## License

TBD — likely Apache-2.0.
