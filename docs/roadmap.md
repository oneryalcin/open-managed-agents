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
- `agent` accepts either a string ID or `{type: "agent", id, version?}`. B.1 resolves the ID; if `version` is supplied it must match the stored current agent version.
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

#### Cycle B.2 Implementation Plan

B.2 proves the persisted session event log over HTTP. It accepts user-originated events, assigns server event IDs, persists them through the existing append-only `EventStore`, and exposes `events.list`. It does not stream live events and it does not resume an engine.

**Endpoints:**

- `POST /v1/sessions/{id}/events`
- `GET /v1/sessions/{id}/events`

**Out of scope for B.2:**

- `GET /v1/sessions/{id}/events/stream` and SSE formatting. That is B.3.
- Pi `AgentSession` execution or any runtime resume behavior.
- Custom-tool promise resolution. B.2 only validates and persists `user.custom_tool_result`.
- Tool-confirmation execution. B.2 only validates and persists `user.tool_confirmation`.
- `user.interrupt`, `user.define_outcome`, `user.tool_result`, self-hosted sandbox events, thread events, MCP result events, and outcome events.
- Event filters beyond `types[]` if the upstream shape is unclear at implementation time.

**Wire contract — `events.send`:**

- Request body: `{ events: UserEvent[] }`.
- Success status: `200`.
- Response body: `{ data: ManagedAgentsEvent[] }`, containing the server-assigned events in the same order as the request.
- Server-assigned event IDs use `sevt_` UUIDv7 IDs.
- B.2 sets `processed_at` to the server receipt timestamp for accepted user-originated events. There is no engine queue yet, so `processed_at: null` is reserved for a later runtime-backed queued state.
- This `processed_at` behavior is transitional: once a runtime queue exists, `processed_at` shifts to engine-applied time rather than ingestion time. Clients must order by event ID for log order, not by `processed_at`.
- Missing session returns `not_found_error`.
- Empty `events`, missing `events`, non-array `events`, unsupported event types, and malformed event payloads return `invalid_request_error`.
- Multi-event sends are atomic at the service level: if any event in the request is invalid, none are persisted.
- `MAX_EVENTS_PER_REQUEST` is 200. Larger batches return `invalid_request_error`.
- The session ID in the URL path is authoritative. B.2 rejects any event payload that includes a `session_id` field rather than ignoring or reconciling it.
- Event payloads are persisted before any later broadcaster integration. B.2 has no broadcaster dependency.
- B.2 does not implement idempotency keys. Retried `events.send` calls can duplicate events; this is tracked as a post-B.2 durability gap before external clients rely on retry-heavy workflows.

**Supported user event variants in B.2:**

- `user.message`
  - Required: `content`.
  - `content` is a non-empty array of text blocks.
  - Text block shape: `{type: "text", text: string}`.
  - B.2 rejects non-text blocks until upstream parity requires additional content block variants.
- `user.custom_tool_result`
  - Required: `custom_tool_use_id`, `content`.
  - `custom_tool_use_id` is a non-empty string.
  - `content` follows the same text-block array contract as `user.message`.
  - `custom_tool_use_id` is not interchangeable with `tool_use_id`.
- `user.tool_confirmation`
  - Required: `tool_use_id`, `result`.
  - `tool_use_id` is a non-empty string.
  - `result` is `"allow"` or `"deny"`.
  - `deny_message` is optional and only accepted when `result` is `"deny"`.
  - `tool_use_id` is not interchangeable with `custom_tool_use_id`.

**Wire contract — `events.list`:**

- Response body: `{data, has_more, next_page}`.
- `data` contains public `ManagedAgentsEvent` objects only. Internal `session_id`, `created_at`, and `payload` fields never leak.
- Supported query params:
  - `limit`: positive integer, capped by the store/service.
  - `page`: opaque token. B.2 may use the raw event ID internally but clients must pass back `next_page` unchanged.
  - `order`: `"asc"` or `"desc"`. Default is `"asc"` because tutorial UIs replay history oldest-first.
  - `types[]`: optional repeated event type filter, e.g. `types[]=agent.tool_use&types[]=agent.tool_result`. B.2 implements this now because tutorial/debug clients rely on it and it is cheap before the list adapter hardens.
- Empty `page=` is treated as omitted at the route boundary, with a store-level guard matching the Cycle A/B.1 cursor hardening.
- Missing session returns `not_found_error`.
- Invalid `order`, invalid `limit`, unknown `types[]`, and malformed `page` values return `invalid_request_error`.

**Architecture rules:**

- Add `src/control-plane/events/routes.ts` and `src/control-plane/events/service.ts`. Do not put HTTP parsing into `EventStore`.
- `EventStore` remains the append-only SQLite primitive. If B.2 needs order, pagination envelopes, or filters, add a small typed service/adapter layer rather than making routes manipulate persisted rows directly.
- Session existence checks happen in the event service via `SessionStore` or `SessionService`; route handlers do not reach into session storage directly.
- Shared wire-visible event request/response types live in `src/types/events.ts` or a sibling `src/types/event-params.ts`; persisted row shapes stay in `src/control-plane/events/types.ts`.
- All event publishing follows persist-first semantics. B.3 may add broadcaster publish after persistence, but B.2 should already make that ordering obvious.
- Keep route handlers thin: parse path/query/body, call service, return JSON.

**B.2 test plan:**

- `events.send` accepts and echoes `user.message`.
- `events.send` accepts and echoes `user.custom_tool_result` with `custom_tool_use_id`.
- `events.send` accepts and echoes `user.tool_confirmation` with both allow and deny shapes.
- Multi-event send preserves request order in the response and in `events.list`.
- Multi-event send is atomic: a request with one valid event and one invalid event persists neither.
- Sending more than `MAX_EVENTS_PER_REQUEST` events returns `invalid_request_error`.
- Payload-level `session_id` is rejected; the path session ID is the only accepted session selector.
- Missing session on send/list returns `not_found_error` with matching body/header `request_id`.
- Missing, empty, or non-array `events` returns `invalid_request_error`.
- Unsupported event type returns `invalid_request_error`.
- `custom_tool_use_id`/`tool_use_id` mixups are rejected with specific messages.
- `deny_message` with `result: "allow"` is rejected or explicitly ignored; pick one before implementation and test it. Prefer reject to avoid silent partial semantics.
- Non-finite JSON numbers inside event content are rejected before storage.
- `events.list` supports `limit`, `page`, `order=asc`, `order=desc`, and empty `page=`.
- `events.list` response never includes `session_id`, `created_at`, or `payload`.
- `events.list` only returns events for the requested session; events from another session never leak.
- `types[]` filtering tests cover single type, multiple types, unknown type, and pagination after filtering.

**B.2 probe:**

- Add `scratch/08-events-api.ts`.
- Probe flow:
  1. Create agent, environment, session.
  2. POST one `user.message`.
  3. POST one `user.custom_tool_result`.
  4. POST one `user.tool_confirmation`.
  5. GET `events.list` ascending and verify event order, IDs, `processed_at`, and no internal fields.
  6. GET with `limit=1&page=<next_page>` and verify no gaps or duplicates.
  7. GET with `types[]=user.message` and verify filtering.
  8. Verify a missing session error envelope.

**B.2 PR shape:**

- Prefer one PR if it stays send+list only.
- Suggested logical commits: event request types/service contract, EventStore list adapter changes, routes/app wiring, tests/probe, docs/status.
- Do not amend/force-push after review begins; use follow-up commits.

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
