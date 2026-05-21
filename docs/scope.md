# Scope

## Goal

Match Anthropic's Managed Agents REST + SSE API surface, self-hostable on Modal / K8s / Docker. Pluggable sandbox, pluggable engine (Pi for now).

The platform shape — agents as persisted versioned objects, sessions as event-stream-driven instances, custom tools round-tripped through the API caller — is exactly the design we're cloning. The engine and the sandbox are interchangeable.

## MVP — first vertical slice

The smallest end-to-end flow that proves the architecture **and preserves the "base-URL swap" compatibility claim** in ADR 0004:

- `POST /v1/environments` — create an environment (single default-env-per-workspace model in MVP; spins up Modal sandbox template on session-create)
- `GET /v1/environments/{id}` — read environment
- `POST /v1/agents` — persist an agent config (model, system prompt, tools list)
- `GET /v1/agents/{id}` — read it back
- `POST /v1/sessions` — accepts `agent_id` + `environment_id`, spins up Modal sandbox, boots a Pi session, persists session metadata
- `POST /v1/sessions/{id}/events` — accept `user.message` and `user.custom_tool_result`
- `GET /v1/sessions/{id}/events/stream` — SSE wrapping Pi's `session.subscribe()`
- **`GET /v1/sessions/{id}/events`** — paginated list of all persisted events (the append-only event log). Required for client reconnect-with-consolidation (see `architecture.md` → Event log).
- Event IDs persisted server-side (UUIDv7 or similar); events written to SQLite on emit, not just buffered in-memory.
- One custom tool round-trip working end-to-end (`agent.custom_tool_use` + synthesized `session.status_idle{stop_reason:requires_action}` → `user.custom_tool_result`).

**Definition of done:** one user can start a session, send a prompt, see streamed responses, drop their SSE connection, reconnect via `events.list` + `events.stream`, get asked a question via a custom tool, answer it, see the session finish with `session.status_idle{stop_reason:end_turn}`.

If this round-trips cleanly on one user, one session, one tool call, with a mid-session reconnect — the platform shape is proven and every other feature is an additive endpoint.

## Deferred (post-MVP)

Each of these is an additive feature, not a redesign:

- **Vaults** — MCP credential storage with OAuth auto-refresh
- **MCP servers** — `mcp_toolset`, `mcp_servers` declarations on agents
- **Memory stores** — FUSE-mounted persistent memory across sessions
- **Outcomes** — `user.define_outcome`, rubric-graded iterate-revise loop
- **Multiagent** — `multiagent: coordinator` + session threads
- **Webhooks** — session state callbacks with HMAC signing
- **Skills** — Anthropic prebuilt + custom skill upload/loading
- **GitHub repo resources** — clone-into-sandbox at session create
- **File resources** — upload + mount at absolute paths
- **K8s sandbox impl** — second `Sandbox` implementation alongside Modal
- **Postgres persistence** — replace SQLite when multi-process scaling matters
- **Multi-tenant auth** — workspaces, API keys, rate limits
- **Multi-process / horizontally-scaled control plane** — MVP is **single-process**; pending-call map and Pi sessions are process-local. Externalizing these (sticky routing, Redis-backed pending state) is post-MVP.
- **Multiple environments per workspace** — MVP supports one default environment per workspace. Multiple named environments with distinct configs/networking come later.
- **Self-hosted sandbox mode** — the Managed Agents "loop on Anthropic, sandbox on you" inversion (interesting but not MVP)

## Non-goals

- **Bit-exact event payload compatibility** with Anthropic's hosted Managed Agents — we match shape and naming, not every nullable field
- **Multi-region deployment**
- **Production-grade reliability** — this is an experiment, not a hosted product
- **Performance parity** with Anthropic's hosted offering
- **Building our own agent loop** — we use Pi; if Pi doesn't fit, we change engines, not write our own (see [ADR 0001](adrs/0001-use-pi-agent-sdk-as-engine.md))
