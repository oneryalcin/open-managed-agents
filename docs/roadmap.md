# Roadmap

This roadmap is the implementation plan for the Managed Agents MVP. Keep it honest: if a cycle changes scope, update this file in the same PR as the code.

## Current State

| Slice | Status | Evidence |
|---|---|---|
| Cycle 0: design scaffold | Done | ADRs 0001-0008, `docs/scope.md`, `docs/architecture.md`, `specs/*.feature` |
| Cycle 0: event primitive | Done | `src/control-plane/events/store.ts`, `src/control-plane/events/broadcaster.ts`, `scratch/05-event-store.ts` |
| Cycle A: Agents API | Done | `POST /v1/agents`, `GET /v1/agents`, `GET /v1/agents/{id}` in `src/control-plane/agents/` |
| Cycle A.1: cursor hardening | Done | Empty `page=` route normalization and store-layer guard covered by agents API tests |
| Cycle B.1: Environments + Sessions API | Done | `POST/GET /v1/environments`, `POST/GET /v1/sessions`, `scratch/07-b1-api.ts` |
| Session events, engine, sandbox | Not started | Planned below |

## Working Smoke

Run these from the repo root before opening PRs that touch runtime code:

```bash
npm test
npm run typecheck
npx tsx scratch/05-event-store.ts
npx tsx scratch/06-agents-api.ts
npx tsx scratch/07-b1-api.ts
```

## Next Cycles

### Cycle B — Sessions + Events HTTP Surface, No Engine

Goal: make the event log curl-able over the Managed Agents wire surface before Pi or Modal enters the runtime.

Scope:

- Add a default environment stub and minimal environment read/list/create routes if needed by session creation.
- Add session storage and service boundaries.
- Implement `POST /v1/sessions`, `GET /v1/sessions`, and `GET /v1/sessions/{id}`.
- Accept and persist `title` and `metadata` on session create. Reject runtime-bearing unsupported fields (`resources`, `vault_ids`) with a caller-safe `invalid_request_error`; do not silently pretend mounts or vaults work.
- Implement `POST /v1/sessions/{id}/events` for synthetic `user.message`, `user.custom_tool_result`, and `user.tool_confirmation` events.
- Implement `GET /v1/sessions/{id}/events` using the existing `EventStore`, with `page` as the opaque cursor token and `next_page` in the response. Support `order` where the upstream SDK examples rely on it.
- Implement `GET /v1/sessions/{id}/events/stream` using the existing `SessionEventBroadcaster`.
- Support the upstream reconnect pattern: open the live stream first, list persisted history, then dedupe live events by ID. Also honor `Last-Event-ID` as an additive SSE resume convenience.
- Make `anthropic-beta: managed-agents-2026-04-01` acceptance explicit but permissive. SDK clients send it; local curl probes should not be punished for omitting it during development.

#### Cycle B.1 Implementation Plan

B.1 proves environments and sessions as stored Managed Agents wire objects. It does not start an engine and it does not provision a sandbox.

**Endpoints:**

- `POST /v1/environments`
- `GET /v1/environments`
- `GET /v1/environments/{id}`
- `POST /v1/sessions`
- `GET /v1/sessions`
- `GET /v1/sessions/{id}`

**Middleware contract:**

- Parse the `anthropic-beta` header into `betaFeatures: Set<string>` on the Hono context.
- Accept a missing header so local probes and manual curl remain easy.
- Accept `managed-agents-2026-04-01` as a no-op for now.
- Accept comma-separated beta values and preserve all trimmed values in the set.
- Accept unknown beta values for forward compatibility; do not 400 on future SDK headers.

**Environment wire contract:**

- Request: `{ name: string, config: JsonObject }`.
- Success status: `200`.
- Response: full environment object with `id`, `type: "environment"`, `name`, `config`, `created_at`, `updated_at`, and `archived_at: null`.
- Store behavior: persist `config` as opaque JSON. B.1 interprets no sandbox runtime semantics from it.

**Session wire contract:**

- Request requires `agent` and `environment_id`.
- `agent` accepts either a string ID or `{type: "agent", id, version?}`. B.1 resolves the ID and ignores `version` except for echoing canonical output.
- Optional fields: `title?: string | null`, `metadata?: Record<string, string>`.
- Metadata is a flat string-to-string map. Reject nested objects, arrays, numbers, booleans, and null values. Do not invent numeric limits unless verified against upstream docs or SDK behavior.
- Unsupported runtime-bearing fields: reject `resources` and `vault_ids` with `invalid_request_error` and a message like `Field \`resources\` is not yet supported by this server.`.
- Missing referenced agent or environment: reject session create with `invalid_request_error`, not `not_found_error`.
- Success status: `200`.
- Response: full session object with `id`, `type: "session"`, `agent: {type: "agent", id, version}`, `environment_id`, `status: "idle"`, `title`, `metadata`, `created_at`, `updated_at`, `archived_at: null`, and `usage: null`.

**List contracts:**

- `GET /v1/environments` and `GET /v1/sessions` return `{data, has_more, next_page}`.
- `GET /v1/sessions` supports `agent_id`, `limit`, `page`, and `order`.
- Empty `page=` is treated as omitted at the route boundary, with a store-level guard matching the Cycle A cursor hardening.

**Architecture rules:**

- Each resource owns an independent SQLite table, `*Row` type, store interface, service, and routes module.
- Routes know Hono and HTTP only. Services own validation and cross-resource coordination. Stores own SQLite and never return wire objects directly.
- Shared wire-visible types live in `src/types/`; DB rows and service-only types live under `src/control-plane/<resource>/`.
- No cross-resource JOINs in stores for B.1. Session create may call agent/environment services or stores to validate referenced IDs.

**B.1 test plan:**

- Environment create/list/retrieve round-trips opaque `config`, including nested finite JSON.
- Session create works with `agent` as string and as object.
- Session retrieve returns canonical object-form `agent`.
- Session list supports `agent_id`, `limit`, `page`, `order`, and empty `page=` handling.
- Missing agent and missing environment on session create return `invalid_request_error` with matching body/header `request_id`.
- Missing session and missing environment on retrieve return `not_found_error` with matching body/header `request_id`.
- Unsupported `resources` and `vault_ids` return `invalid_request_error` with matching body/header `request_id`.
- Oversized JSON/request bodies return the full error envelope with `request_too_large`, not a framework-default plaintext response.
- Non-finite JSON numbers in environment `config` or session `metadata` are rejected before storage.
- Internal `workspace_id` and row-only fields never leak into environment or session wire responses.
- Existing Cycle A app-level not-found coverage remains green; new route errors preserve the full error envelope.

**B.1 PR shape:**

- Prefer one B.1 PR so environments and sessions can be reviewed together, but keep the diff readable by committing in logical groups: beta middleware, environments, sessions, tests/probe.
- Avoid amend/force-push churn after review begins. Use follow-up commits and squash on merge if needed.

Acceptance:

- A probe creates an agent, creates a session, posts an event, opens SSE, lists persisted history, tails live events while deduping by ID, drops/reopens the stream, and receives no duplicates.
- The reconnect probe must force a disconnect-window event and assert it is recovered by `events.list`, not lost. It must also assert no duplicate event IDs, no missing event IDs across the persisted range, and dedupe by `event.id` rather than `processed_at`.
- A smaller assertion covers `Last-Event-ID` resume as server behavior, without making it the only reconnect contract.
- The probe uses the public wire field names from `docs/scope.md`: `agent`, `environment_id`, `page`, `next_page`, and full object responses with `id`.
- Route handlers stay thin: routes call services, services depend on typed store interfaces, stores own persistence details.
- `npm test`, `npm run typecheck`, `scratch/05-event-store.ts`, and the new Cycle B probe pass.

Out of scope:

- Pi `AgentSession` execution.
- Custom tool round-trip semantics beyond persisting a synthetic `user.custom_tool_result`.
- Modal sandbox provisioning.
- File uploads, real resource mounts, vault credential resolution, agent updates/versioning, and session deletion/archive cleanup.
- Auth, users, organizations, teams, billing, web UI, and CLI.

### Cycle C — Pi Event Translation

Goal: connect a real Pi `AgentSession` to the existing event surface without changing the HTTP contract.

Scope:

- Introduce a `SessionRunner` boundary so routes and services never import Pi directly.
- Translate Pi's async event stream into Managed Agents events.
- Design the translator as an async-iterable transformer so live Pi sessions and recorded cassettes can use the same path.
- Add cassette tests for real Pi event trajectories before relying on the translator as a stable compatibility layer.

Acceptance:

- A real Pi run emits at least one `agent.message` and a terminal `session.status_idle` through the existing SSE route.
- Recorded Pi cassettes cover at least simple message, tool call, thrown tool error, and abort trajectories.
- Pi version changes require explicit cassette review.

### Cycle D — Custom Tool Round Trip

Goal: prove the blocking custom-tool protocol from ADR 0005 end to end.

Scope:

- Maintain the pending-call map for `agent.custom_tool_use`.
- Synthesize `session.status_idle{stop_reason:{type:"requires_action", event_ids:[...]}}`.
- Accept `user.custom_tool_result` carrying `custom_tool_use_id`.
- Resume the Pi session and finish with `session.status_idle{stop_reason:{type:"end_turn"}}`.

Acceptance:

- A probe starts a real session, receives a custom-tool request, submits a result, and sees the session finish.
- The emitted IDs round-trip through `events.list` and `events.stream`.

### Cycle E — Modal Sandbox

Goal: make builtin shell/file tools execute in a per-session sandbox rather than the host process.

Scope:

- Implement the sandbox lifecycle wrapper from ADR 0003.
- Use Pi's `baseToolsOverride` injection point for sandbox-backed operations.
- Add environment endpoints beyond the current default stub only as required by the sandbox lifecycle.
- Add teardown and orphan-cleanup behavior before running untrusted prompts.

Acceptance:

- A bash tool call executes inside Modal, not the local working directory.
- Session end destroys the sandbox.
- Sandbox failure emits a caller-safe API error and developer-useful logs.

## Canonical Tutorial Compatibility Backlog

These items were found by tracing Anthropic's public Managed Agents workshop tutorials end to end. They are not all required for the first MVP platform-shape proof, but they are required before claiming that the canonical tutorials run unchanged against this server with only a base-URL swap.

| Item | Why it matters | Likely cycle |
|---|---|---|
| `GET /v1/sessions` with `agent_id`, `limit`, `page`, and `order` | Session pickers and dashboards list recent sessions before retrieving one. | Cycle B.1 |
| `title` and `metadata` on `POST /v1/sessions` | Tutorials name sessions and preserve UI flags on session metadata. | Cycle B.1 |
| `user.tool_confirmation` parsing and persistence | Permission-gated builtin/MCP tools use `tool_use_id`, separate from custom-tool `custom_tool_use_id`. | Cycle B.2 |
| `order` on `events.list` | Tutorial UIs replay conversation history in ascending order. | Cycle B.2 |
| `DELETE /v1/sessions/{id}`, archive, and `user.interrupt` cleanup semantics | Workshop UIs clean up sessions; long-running agents need an explicit stop path. | Cycle B.4 |
| `POST /v1/files` and file metadata | File resources are uploaded before they can be mounted into a session. | MVP+1 resources |
| Session `resources` with file mounts | File and memory resources are session-create inputs; real mounting belongs with sandbox lifecycle. | MVP+1 resources / Cycle E |
| Agent update/versioning | Tutorials update agents with optimistic version checks and rely on sessions using latest-version semantics. | MVP+1 agent lifecycle |
| `evaluated_permission` on tool-use events | UIs show confirmation controls when a tool call evaluates to ask. | Runtime tool gating |
| `span.model_request_start` / `span.model_request_end` | Some UIs use span boundaries for transcript grouping and usage display. | Cycle C translation or explicit deferral |

## Later Work

Organizations, teams, users, auth, RBAC, and per-tenant billing are intentionally deferred. The current code uses a single internal workspace boundary (`wrk_default`) so storage and service APIs already have a place to attach tenancy later without changing every method signature.

CI and license are housekeeping gaps:

- Add GitHub Actions for `npm test`, `npm run typecheck`, and the scratch smoke probes.
- Choose and add a real `LICENSE` before inviting external contributions.
