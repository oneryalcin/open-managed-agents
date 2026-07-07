# Scope

## Goal

Match Anthropic's Managed Agents REST + SSE API surface, self-hostable on Modal / K8s / Docker. Pluggable sandbox, pluggable engine (Pi for now).

The platform shape — agents as persisted versioned objects, sessions as event-stream-driven instances, custom tools round-tripped through the API caller — is exactly the design we're cloning. The engine and the sandbox are interchangeable.

## MVP — first vertical slice

The smallest end-to-end flow that proves the architecture **and preserves the "base-URL swap" compatibility claim** in ADR 0004:

**Environments:**
- `POST /v1/environments` — create an environment config object. B.1 persists and returns config; Modal sandbox interpretation lands with sandbox runtime. Response: full environment object with field `id` (not `environment_id`).
- `GET /v1/environments` — list environments (paginated).
- `GET /v1/environments/{id}` — read one environment.

**Agents:**
- `POST /v1/agents` — persist an agent config (`name`, `model`, `system`, `tools`). Response: full agent object with field `id` (not `agent_id`).
- `GET /v1/agents` — list agents (paginated).
- `GET /v1/agents/{id}` — read one agent.

**Sessions:**
- `POST /v1/sessions` — request body `{ agent, environment_id }`, where **`agent` is the wire field** (NOT `agent_id`). `agent` accepts either a bare string `"agent_abc"` (latest version semantics — for MVP we just resolve the agent ID) or an object `{type: "agent", id, version?}`. We ignore `version` in MVP. Response: full session object with field `id`.
- `GET /v1/sessions` — list sessions (paginated), with `agent_id`, `limit`, `page`, and `order` query parameters.
- `GET /v1/sessions/{id}` — read one session (status, agent, environment, usage).

**Session events:**
- `POST /v1/sessions/{id}/events` — accept `user.message` and `user.custom_tool_result` (carries `custom_tool_use_id`, NOT `tool_use_id`).
  Optional `Idempotency-Key` is supported for retry-safe JSON writes on this
  endpoint. Reusing the same key with the same method, concrete path, and raw
  request body replays the original response without appending duplicate events
  or starting duplicate runtime work. Reusing the same key with a different raw
  body returns `invalid_request_error`; a fresh in-progress same-key request
  returns `409`.
- `GET /v1/sessions/{id}/events/stream` — SSE wrapping Pi's `session.subscribe()`. Honors `Last-Event-ID` header for resume.
- **`GET /v1/sessions/{id}/events`** — paginated list of all persisted events (the append-only event log). **Cursor query param is `?page=<token>`** (not `?after_id=...`), matching Anthropic's wire contract. Clients pass the returned `next_page` value unchanged; token internals are server-owned. Required for client reconnect-with-consolidation (see `architecture.md` → Event log).
- Runtime model requests emit `span.model_request_start` /
  `span.model_request_end` around Pi assistant model requests.

**Cross-cutting invariants:**
- Event IDs persisted server-side (UUIDv7); events written to SQLite on emit, not just buffered in-memory.
- One custom tool round-trip working end-to-end (`agent.custom_tool_use` + synthesized `session.status_idle{stop_reason:requires_action}` → `user.custom_tool_result`).
- All Managed Agents endpoints require the `anthropic-beta: managed-agents-2026-04-01` header. Requests missing that beta are hidden behind the beta gate before route-specific body parsing or validation.
- Success status code is **`200`** on every endpoint including POST creates (NOT `201`) — see [ADR 0004](adrs/0004-managed-agents-rest-sse-surface-as-north-star.md) Tier 1.
- Error responses use the full envelope: `{type: "error", error: {type, message}, request_id: "req_..."}`. See [ADR 0004](adrs/0004-managed-agents-rest-sse-surface-as-north-star.md) Tier 1.

**Definition of done:** one user can start a session, send a prompt, see streamed responses, drop their SSE connection, reconnect via `events.list` + `events.stream`, get asked a question via a custom tool, answer it, see the session finish with `session.status_idle{stop_reason:end_turn}`.

If this round-trips cleanly on one user, one session, one tool call, with a mid-session reconnect — the platform shape is proven and every other feature is an additive endpoint.

## Deferred (post-MVP)

Each of these is an additive feature, not a redesign:

- **Vaults** — MCP credential storage with OAuth auto-refresh (0122 M2/M3)
- ~~**MCP servers**~~ — execution shipped (plan 0122 M1); vault-backed auth still deferred
- **Memory stores** — FUSE-mounted persistent memory across sessions
- **Outcomes** — `user.define_outcome`, rubric-graded iterate-revise loop
- **Multiagent** — `multiagent: coordinator` + session threads
- **Webhooks** — session state callbacks with HMAC signing
- **Skills** — Anthropic prebuilt + custom skill upload/loading
- **GitHub repo resources** — clone-into-sandbox at session create
- **File resources** — upload + mount at absolute paths
- **K8s sandbox impl** — second `Sandbox` implementation alongside Modal
- **Postgres persistence** — replace SQLite when multi-process scaling matters
- **Identity + multi-tenant auth** — users, organizations, teams, workspaces, API keys, memberships, roles, and rate limits. MVP uses one internal workspace (`wrk_default`) so stores/services are scoped correctly without exposing identity fields on the public wire API before an auth ADR exists.
- **Multi-process / horizontally-scaled control plane** — MVP is **single-process**; pending-call map and Pi sessions are process-local. Externalizing these (sticky routing, Redis-backed pending state) is post-MVP.
- **Multiple environments per workspace** — MVP supports one default environment per workspace. Multiple named environments with distinct configs/networking come later.
- **Self-hosted sandbox mode** — the Managed Agents "loop on Anthropic, sandbox on you" inversion (interesting but not MVP)

## Deferred event types (intentional gaps in EVENT_TYPES)

These appear in Anthropic's Managed Agents event stream but are tied to features deferred above. Documented here so the gap is explicit, not silent. When the corresponding feature lands, the event types get added to `src/types/events.ts` and the EventType alignment test (ADR 0008) gates the change.

The full event-topology tracker lives in
[`docs/references/managed-agents-event-topology.md`](references/managed-agents-event-topology.md).
Keep that matrix, `src/types/events.ts`, and
`src/types/__tests__/events.test.ts` aligned when event support changes.

| Event type | Tied to | Deferred until |
|---|---|---|
| `user.define_outcome` | Outcomes | Post-MVP |
| `user.tool_result` | Self-hosted sandbox agent-tool results | Self-hosted sandbox mode |
| `agent.mcp_tool_use`, `agent.mcp_tool_result` | MCP servers | Implemented (0122 M1) |
| `agent.thread_context_compacted` | Pi compaction | Cycle C (SessionManager) — Pi will emit this when context fills; we translate then |
| `agent.thread_message_sent`, `agent.thread_message_received` | Multiagent | Post-MVP |
| `session.updated` | Session update requests | Post-MVP |
| `session.thread_created`, `session.thread_status_*` | Multiagent | Post-MVP |
| `span.outcome_evaluation_*` | Outcomes (rubric-graded loop) | Post-MVP |

## Non-goals

- **Bit-exact event payload compatibility** with Anthropic's hosted Managed Agents — we match shape and naming, not every nullable field
- **Multi-region deployment**
- **Production-grade reliability** — this is an experiment, not a hosted product
- **Performance parity** with Anthropic's hosted offering
- **Building our own agent loop** — we use Pi; if Pi doesn't fit, we change engines, not write our own (see [ADR 0001](adrs/0001-use-pi-agent-sdk-as-engine.md))
