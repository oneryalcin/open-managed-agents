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
- Server-assigned event IDs use the existing `newEventId()` helper (`sevt_` + UUIDv7).
- B.2 sets `processed_at` to the event-log persistence timestamp for accepted user-originated events. This is the stable control-plane acceptance time, not an engine-completion signal. Runtime-originated events added later carry their own processed timestamp at emission time.
- B.4+ MUST NOT redefine `processed_at` for user-originated events as "engine-applied time"; engine application timestamps require a separate field if needed.
- Event log order is by event ID in MVP because UUIDv7 preserves creation order; do not order client replay by `processed_at`.
- Missing session returns `not_found_error`.
- Empty `events`, missing `events`, non-array `events`, unsupported event types, malformed event payloads, and non-finite JSON numbers anywhere in accepted payload fields return `invalid_request_error`.
- Multi-event sends are atomic: validate the full batch first, then persist inside a SQLite transaction. If any event in the request is invalid or any insert fails, none are persisted.
- `MAX_EVENTS_PER_REQUEST` is 200. Larger batches return `invalid_request_error`.
- `MAX_EVENT_PAYLOAD_BYTES` is 64 KiB after JSON serialization. The existing app-level body limit still caps the whole request.
- The session ID in the URL path is authoritative. B.2 rejects any event payload that includes a `session_id` field rather than ignoring or reconciling it.
- Event payloads are persisted before any later broadcaster integration. B.2 has no broadcaster dependency.
- B.2 does not implement idempotency keys. Retried `events.send` calls can duplicate events; this is tracked as a post-B.2 durability gap before external clients rely on retry-heavy workflows.

**Supported user event variants in B.2:**

- `user.message`
  - Required: `content`.
  - `content` is a non-empty array of JSON-compatible content blocks.
  - Text block shape: `{type: "text", text: string}`.
  - Non-text blocks are accepted as opaque JSON-compatible blocks with a non-empty string `type`. B.2 stores them but does not validate per-type resource semantics.
- `user.custom_tool_result`
  - Required: `custom_tool_use_id`.
  - `custom_tool_use_id` is a non-empty string.
  - `content` is optional upstream. If present, it follows the same content-block array contract as `user.message`.
  - `custom_tool_use_id` is not interchangeable with `tool_use_id`.
- `user.tool_confirmation`
  - Required: `tool_use_id`, `result`.
  - `tool_use_id` is a non-empty string.
  - `result` is `"allow"` or `"deny"`.
  - `deny_message` is optional string or null, and only accepted when `result` is `"deny"`.
  - `tool_use_id` is not interchangeable with `custom_tool_use_id`.

**Wire contract — `events.list`:**

- Response body: `{data, next_page}`. Do not add `has_more`; Anthropic's events list uses a page-cursor response, not the B.1 `{data, has_more, next_page}` shape.
- `data` contains public `ManagedAgentsEvent` objects only. Internal `session_id`, `created_at`, and `payload` fields never leak.
- Supported query params:
  - `limit`: positive integer, capped by the store/service.
  - `page`: opaque token. B.2 returns the raw `sevt_...` event ID as `next_page` for MVP, but clients must pass it back unchanged and not derive it from the last event themselves.
  - `order`: `"asc"` or `"desc"`. Default is `"asc"` because event logs replay oldest-first; this intentionally differs from sessions list, which defaults newest-first for session pickers.
  - For `order=asc`, `page` means events with `id > page`. For `order=desc`, `page` means events with `id < page`. Descending pagination is an older-than-cursor scan, not a stable snapshot; events created after page 1 are recovered by B.3's stream-first reconnect pattern, not by page 2 of a descending history scan.
  - `types[]`: optional repeated event type filter, e.g. `types[]=agent.tool_use&types[]=agent.tool_result`. B.2 implements this now and adds a `(session_id, type, id)` SQLite index in the same PR.
- Empty `page=` is treated as omitted at the route boundary, with a store-level guard matching the Cycle A/B.1 cursor hardening.
- Missing session returns `not_found_error`.
- Invalid `order`, invalid `limit`, and malformed `page` values return `invalid_request_error`.
- Unknown `types[]` values return `200` with an empty page, not `invalid_request_error`, so future upstream event types do not break older servers.

**Architecture rules:**

- Add `src/control-plane/events/routes.ts` and `src/control-plane/events/service.ts`. Do not put HTTP parsing into `EventStore`.
- `EventStore` remains the append-only SQLite primitive. B.2 extends it deliberately for transactions, descending order, pagination, and type filtering rather than letting routes manipulate persisted rows directly.
- Session existence checks happen in the event service via `SessionStore` or `SessionService`; route handlers do not reach into session storage directly.
- Shared wire-visible event request/response types live in `src/types/events.ts` or a sibling `src/types/event-params.ts`; persisted row shapes stay in `src/control-plane/events/types.ts`.
- All event publishing follows persist-first semantics. B.3 may add broadcaster publish after persistence, but B.2 should already make that ordering obvious.
- Concurrent `events.send` calls for one session are serialized by SQLite writes. Within a single batch, request order is preserved; across concurrent batches, UUIDv7 event IDs define the replay order.
- Keep route handlers thin: parse path/query/body, call service, return JSON.

**B.2 test plan:**

- `events.send` accepts and echoes `user.message`.
- `events.send` accepts and echoes `user.custom_tool_result` with `custom_tool_use_id`, with and without optional `content`.
- `events.send` accepts and echoes `user.tool_confirmation` with both allow and deny shapes.
- Multi-event send preserves request order in the response and in `events.list`.
- Multi-event send is atomic: a request with one valid event and one invalid event persists neither.
- Sending more than `MAX_EVENTS_PER_REQUEST` events returns `invalid_request_error`.
- Sending an event whose serialized payload exceeds `MAX_EVENT_PAYLOAD_BYTES` returns `invalid_request_error`.
- Payload-level `session_id` is rejected; the path session ID is the only accepted session selector.
- Successful send/list responses include the `request-id` header.
- Missing session on send/list returns `not_found_error` with matching body/header `request_id`.
- Missing, empty, or non-array `events` returns `invalid_request_error`.
- Unsupported event type returns `invalid_request_error`.
- `custom_tool_use_id`/`tool_use_id` mixups are rejected with specific messages.
- `deny_message` with `result: "allow"` is rejected or explicitly ignored; pick one before implementation and test it. Prefer reject to avoid silent partial semantics.
- Non-finite JSON numbers inside event content are rejected before storage.
- `events.list` supports `limit`, `page`, `order=asc`, `order=desc`, and empty `page=`.
- `events.list` response never includes `session_id`, `created_at`, or `payload`.
- `events.list` only returns events for the requested session; events from another session never leak.
- `types[]` filtering tests cover single type, multiple types, unknown type returning an empty page, and pagination after filtering.

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

**B.2 acceptance:**

- `scratch/08-events-api.ts` creates an agent, environment, and session; posts supported user events; lists persisted history; verifies pagination and `types[]`; and verifies the missing-session error envelope.
- `events.send` is persist-first and all-or-nothing for a batch.
- `events.list` proves order, pagination, cross-session isolation, type filtering, and internal-field non-leakage.
- Route handlers stay thin: routes call services, services depend on typed store interfaces, stores own persistence details.
- `npm test`, `npm run typecheck`, `scratch/05-event-store.ts`, `scratch/06-agents-api.ts`, `scratch/07-b1-api.ts`, and `scratch/08-events-api.ts` pass.

#### Cycle B.3 Implementation Plan

B.3 connects the persisted event log to live SSE delivery through `SessionEventBroadcaster`. It proves the reconnect-with-consolidation pattern without Pi or Modal.

**B.3 acceptance:**

- A probe creates an agent, creates a session, posts an event, opens SSE, lists persisted history, tails live events while deduping by ID, drops/reopens the stream, and receives no duplicates.
- The reconnect probe uses the B.2 `events.list` endpoint plus the B.3 SSE stream. It must force a disconnect-window event and assert it is recovered by `events.list`, not lost. It must also assert no duplicate event IDs, no missing event IDs across the persisted range, and dedupe by `event.id` rather than `processed_at`.
- A smaller assertion covers `Last-Event-ID` resume as server behavior, without making it the only reconnect contract.
- `Last-Event-ID` handling is fail-open. Parse only well-formed `sevt_...` values; then verify cursor ownership before using it. If the cursor event is missing or belongs to a different session, drop the cursor and replay from the start of this session instead of returning 400 or silently skipping history.
- The live-tail test must include a synchronization barrier so it exercises publish/notify wakeup, not just replay. Required shape: seed a sentinel event, open stream, confirm sentinel replay + active subscriber registration, then POST a new event and assert live arrival within timeout.
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

#### Cycle C Implementation Plan

Cycle C is the first runtime-integration cycle. Keep the transport and persistence path boring:
translated runtime events must flow through the existing B.2/B.3 event path (`appendBatch` + `publishPersisted`) and therefore inherit ADR 0009 invariants.

**Evidence-first inputs (must be read before coding):**

- `docs/scratch-pi-findings.md`
- `scratch/01-smoke.ts` (simple message trajectory)
- `scratch/02-abort.ts` (abort trajectory)
- `scratch/03-throw.ts` (tool error trajectory)
- `scratch/04-tool-array.ts` (custom tool registration path and runtime hooks)

Do not draft the Pi→Managed mapping table from memory. Extract it from the observed event shapes above and pin unknowns explicitly.

**C.0 gating probe — raw Pi event field dump (must land before C.1):**

- Add `scratch/10-pi-event-dump.ts`.
- Probe runs the four required trajectories and records every subscribed Pi event as JSONL:
  1. simple message
  2. tool call
  3. thrown tool error
  4. abort
- Each JSONL line must include:
  - `scenario` (one of the four trajectories)
  - `seq` (monotonic per scenario)
  - `captured_at` (ISO timestamp of capture)
  - raw `event` object exactly as received from Pi subscription
- Output files:
  - `scratch/artifacts/pi-events/<scenario>.jsonl`
  - optional summary `scratch/artifacts/pi-events/_summary.json` with counts by `event.type`
- Redaction rules must be deterministic and documented in the probe:
  - redact secrets/tokens from env-derived fields
  - keep field names/shape and non-sensitive values intact
  - do not rewrite event type names
- Success criteria:
  - all four files produced
  - each trajectory contains at least one non-empty stream of events
  - tool and abort trajectories include their expected tool/abort-related event families

This probe is the source of truth for C.1 mapping granularity and payload shapes.

**Runtime boundary (SessionRunner seam):**

- Add a `SessionRunner` interface under `src/control-plane/sessions/` (or a sibling runtime module) that owns:
  - start/run a session prompt against Pi
  - expose an `AsyncIterable<PiEvent>` stream
  - support abort/cancel
- Routes and HTTP handlers must not import Pi SDK types directly.
- Session event delivery remains:
  1. translate Pi events to `EventDraft[]`
  2. `appendBatch(...)` atomically
  3. `publishPersisted(...)` in the same synchronous tick

This preserves B.2/B.3 replay and SSE guarantees while Cycle C only adds translation + runtime source.

**Translator contract:**

- Define translator as a pure per-event mapper:
  - `translate(piEvent: PiEvent): EventDraft[]` where `EventDraft` has no server-owned fields (`id`, `processed_at`, `created_at`).
- Translator may emit 0/1/many drafts for one Pi event (N:1 and 1:N are allowed).
- Pi-native IDs never become Managed Agents event IDs/cursors. Server IDs (`sevt_...`) are stamped only at persist boundary.
- No HTTP concerns, no DB access, no broadcaster calls in translator code.
- Use the same translator for:
  - live Pi runs
  - recorded cassettes (replayed as async iterable)

**Termination and error semantics (first-class, not incidental):**

- The event log remains the source of truth; stream is a courier.
- Runtime failures that matter to clients must be persisted as events, not only surfaced as stream disconnects.
- `session.status_idle` is a pause, not a terminal state. It may recur across turns (`idle -> running -> idle`).
- Consumers stop on terminal events (`session.status_terminated` / `session.deleted`) by policy; the server stream itself is not required to close on idle and need not close on terminal.
- Cycle C does not modify B.3 broadcaster/stream transport logic for terminal handling; it only persists translated status events and relies on existing stream-first + list-backfill + dedupe behavior.
- Pin:
  - derive terminal/session-state mapping primarily from `message_end.message.stopReason` when present (`stop`, `toolUse`, `aborted` observed in C.0 dumps); treat `agent_end.willRetry` as secondary context (retry/reschedule signal), not primary terminal discriminator
  - tool-thrown errors map to persisted tool-result style events with error semantics (`is_error: true`), not stream-only transport failure
  - abort handling must consume in-band `stopReason: \"aborted\"` and `errorMessage` first; keep SessionRunner abort state as a fallback guardrail for abort-before-first-assistant-message_end races
  - `evaluated_permission` is unobserved in current C.0 trajectories and requires a dedicated permission-policy probe to locate its source event/path before Cycle D confirmation gating
  - `session.deleted` is recognized terminal vocabulary in mapping table (even if not emitted in MVP probe trajectories)

**Cassettes (committed in Cycle C, simple mechanism):**

- Add ADR 0010 for cassette strategy (new ADR; do not overload ADR 0009).
- Keep implementation minimal:
  - static recorded JSON fixtures
  - async-iterable replayer
  - no HTTP interception/VCR framework
- Required trajectories:
  1. simple message
  2. tool call
  3. thrown tool error
  4. abort
- ADR 0010 must pin normalization rules (IDs/timestamps/non-deterministic fields) and refresh policy.
- Pi version changes require explicit cassette review.

**Idempotency forward note (tracked, not fixed in C):**

- `events.send` idempotency remains deferred from B.2.
- Cycle C must call out concrete duplicate-side-effect paths:
  - duplicate `user.message` can cause duplicate runtime prompts
  - duplicate `user.custom_tool_result` can double-resolve pending tool waits
- Full idempotency enforcement may land in D, but risk ownership begins in C.

**Cycle C slices:**

- **C.1 Translator + cassette harness**
  - land C.0 field-dump probe and derive mapping table from captured JSONL
  - mapping table from probe evidence
  - pure `translate(piEvent) -> EventDraft[]` module
  - cassette fixtures + replayer
  - unit tests over all four trajectories
- **C.2 SessionRunner wiring**
  - Pi-backed SessionRunner implementation
  - hook translated drafts into existing event persistence/broadcast path
  - perform behavior-preserving frozen-layer refactor if needed: extract shared persist+publish stamping path so B.2 `events.send` and C.2 runtime ingestion share server ID/timestamp stamping rules
  - no wire contract changes
- **C.3 End-to-end validation**
  - real Pi run through existing `/events` and `/events/stream`
  - reconnect-with-consolidation still holds
  - translated terminal and error behavior verified

#### Cycle C.2 Plan (implementation gate before coding)

Goal: run live Pi sessions through the existing event-log path without changing B.2/B.3 transport contracts.

**Decision gate (resolved): ADR 0011 correlation-id model**

- [ADR 0011](adrs/0011-tool-correlation-id-model.md) is accepted as Option A.
- C.2 uses uniform server-stamped `sevt_*` top-level event IDs and preserves Pi `toolu_*` correlation IDs in payload fields.
- Cycle D implements inbound `sevt_* -> toolu_*` correlation translation for tool-result forwarding.

**C.2 scope (in):**

1. Add concrete `PiSessionRunner` (no new abstraction layers beyond what C.1 already established).
2. Consume Pi event stream and translate via `translatePiEvent` (C.1).
3. Persist translated drafts via the same server stamping + append path used by B.2 (`sevt_*`, `processed_at`, atomic append).
4. Notify live subscribers via existing `publishPersisted` in the same sync tick post-persist.
5. Keep route wire shapes unchanged (`events.list`, `events.stream`, error envelope).

**C.2 scope (out):**

- Full custom-tool blocking round-trip mechanics (Cycle D).
- Modal sandbox execution (Cycle E).
- Permission-policy probing for `evaluated_permission` source (separate targeted probe before D).
- Stateful runtime continuity keyed by `sesn_*` (tracked as a prerequisite before C.3-live sign-off; see ADR 0012).

**Frozen-layer touch (must be explicit):**

- If C.2 needs runtime ingestion to share server stamping rules with B.2, extract a shared persist+publish helper from current private B.2 service code.
- This refactor must be behavior-preserving for existing B.2 tests.

**Idempotency risk callout (document, do not solve here):**

- Duplicate `user.message` may trigger duplicate prompts.
- Duplicate `user.custom_tool_result` may double-resolve pending tool waits.
- Keep TODO and trace points visible for Cycle D hardening.

**C.2 acceptance checks:**

- Live Pi run emits translated events that persist and appear in both `events.list` and `events.stream`.
- B.2/B.3 invariants remain intact:
  - atomic append semantics
  - persist-before-publish
  - replay/tail reconnect behavior
- No wire-shape drift in existing endpoints.
- `npm test`, `npm run typecheck`, and relevant scratch probes pass.

**C.3 gate carried from C.2:**

- Do not mark C.3 live validation complete while runtime remains per-message cold-start.
- Before C.3 sign-off, runtime must preserve per-`sesn_*` continuity and serialize turns per session (ADR 0012).

#### Cycle C.3a Plan — stateful Pi sessions before live validation

Goal: make one Managed Agents session ID (`sesn_*`) map to one reusable Pi
`AgentSession`, while keeping the existing B.2/B.3 event-log transport unchanged.

**Evidence gate (closed): `scratch/11-pi-session-continuity.ts`**

- Continuity works: one Pi `AgentSession` remembered a unique phrase across two
  `prompt(...)` calls.
- Busy-session behavior is native to Pi: `prompt(...)` without
  `streamingBehavior` throws while running; `followUp(...)`, `steer(...)`, and
  `prompt(...,{streamingBehavior:"followUp"|"steer"})` queue and produce a later
  assistant turn.
- Abort survives: the same Pi `AgentSession` accepted another prompt after
  `abort()`, so abort does not require eviction.

**C.3a scope (in):**

1. Replace per-message cold start in `PiSessionRunner` with a per-`sesn_*`
   runtime cache.
2. Use Pi's native queueing instead of a control-plane mutex:
   - idle `user.message` -> `prompt(text)`
   - running `user.message` -> `followUp(text)`
   - `user.interrupt` maps to Pi `abort()` once wired.
3. Track a per-session running flag from Pi events (`agent_start`/`agent_end`) so
   the runner can choose `prompt` vs. `followUp`.
4. Add idle-TTL eviction and `dispose()` to bound memory.
5. Evict + dispose on hard runtime error; do **not** evict on abort.
6. Keep event transport unchanged: Pi event -> `translatePiEvent` ->
   `materializePersistedEvents` -> `persistAndPublish`.
7. Emit `session.status_idle` only when Pi has drained the queued run
   (`agent_end` for C.3a), not on each assistant `message_end`. This preserves
   the lifecycle sequence `running -> ... -> idle` when `followUp(...)` queues
   another turn.

**C.3a scope (out):**

- `user.interrupt` route semantics, which later landed as an explicit event.
- Full custom-tool blocking round trip (Cycle D).
- Modal sandbox execution (Cycle E).
- Idempotency hardening for duplicate `user.message`.

**C.3a acceptance checks:**

- Deterministic tests prove one `sesn_*` keeps runtime state across two user
  messages.
- Deterministic tests prove two `sesn_*` sessions do not share runtime state.
- Deterministic tests prove a `user.message` submitted while the session is
  running is forwarded through Pi's follow-up path, not dropped or raced.
- Service-level tests prove an overlapping `user.message` does not synthesize
  or persist `session.status_idle` before the queued follow-up response.
- Deterministic tests prove idle-TTL eviction calls `dispose()` and removes the
  cached runtime session.
- Existing C.2/B.2/B.3 tests remain green with no wire-shape changes.
- A live Pi probe proves two-turn continuity through `/events` and
  `/events/stream`: turn 1 stores a unique phrase; turn 2 recalls it without the
  phrase being repeated in the second prompt.

#### Cycle C.3b Plan — reconnect validation while Pi is producing events

Goal: validate that the B.3 reconnect contract still holds when the writer is
the asynchronous Pi runtime path, not a direct `events.send` POST.

The new condition over B.3 is a disconnect mid-Pi-turn: runtime events continue
to be translated and persisted while no SSE client is connected. The event log is
still the source of truth, so the expected behavior is unchanged:
stream-first reconnect plus list/backfill must recover a single ordered event set
with no loss and no duplicate IDs.

**C.3b scope (in):**

1. Add a deterministic service-level regression with a fake queued Pi session:
   subscribe, start a runtime turn, disconnect after `session.status_running`,
   reconnect with `Last-Event-ID`, then let the runtime finish.
2. Assert the consolidated stream events match `events.list` exactly by event ID
   and type order.
3. Add a live Pi probe (`scratch/14-c3-live-reconnect.ts`) that performs the same
   mid-run disconnect/reconnect against the real runtime.
4. Record the live probe summary under `scratch/artifacts/pi-session-probe`.

**C.3b scope (out):**

- Enabling the Pi runtime in the default served app. Cycle C validates the
  runtime path; production enablement remains a separate decision.
- Idempotency hardening for duplicate `user.message`.
- Custom-tool `requires_action` round trips (Cycle D).
- Session deletion / `user.interrupt` cleanup semantics.

**C.3b acceptance checks:**

- CI-protected deterministic reconnect test proves mid-runtime disconnect loses
  no events and produces no duplicate event IDs.
- Live probe proves a real Pi response emitted during the disconnect window is
  recovered through both `/events/stream` and `/events`.
- Existing B.2/B.3/C.3a tests remain green.

**Cycle C acceptance:**

- A real Pi run emits at least one `agent.message` and terminal session state events through the existing SSE route.
- Cassettes cover simple message, tool call, thrown tool error, and abort, and all replay through the same translator path as live Pi.
- Translator tests assert deterministic mapping and persisted-event shapes from cassette inputs.
- Existing B.2/B.3 guarantees remain green:
  - atomic append behavior
  - persist-before-publish
  - stream replay/tail semantics
- Pi version changes require explicit cassette review before merge.

### Cycle D — Custom Tool Round Trip

Goal: prove the blocking custom-tool protocol from ADR 0005 end to end.

Status: done, merged in PR #17.

Evidence captured:

- `scratch/15-d-custom-tool-capability.ts` confirms Pi custom tools are blocking async functions: `execute()` is called with a Pi `toolu_*`, `tool_execution_start` is emitted before the external result, `tool_execution_end` is emitted after the result, and the model observes the external result.
- The permission-policy path is separate from custom tools in the observed SDK behavior: the `tool_call` hook can block execution before `execute()` runs, and no `evaluated_permission` payload field appeared in the captured Pi event stream.
- `scratch/16-d-custom-tool-roundtrip.ts` proves the public Managed Agents round trip through the API: `user.message -> agent.custom_tool_use -> session.status_idle{requires_action} -> user.custom_tool_result -> session.status_running -> agent.message -> session.status_idle{end_turn}`. Stream IDs match `events.list` exactly with no duplicates.
- `scratch/17-d-custom-tool-parallel.ts` confirms Pi can enter multiple custom-tool waits before any result is supplied. The public API aggregates those into one `requires_action.event_ids` array and, after a partial result, re-emits `requires_action` with the remaining ID.
- `scratch/18-d-custom-tool-error.ts` confirms returned `{isError:true}` is not enough for Pi's emitted tool-result error flags. Cycle D maps `user.custom_tool_result.is_error` to a thrown Pi tool error using the submitted text content.

Implemented scope:

- Maintain the pending-call map for `agent.custom_tool_use`.
- Synthesize aggregate `session.status_idle{stop_reason:{type:"requires_action", event_ids:[...]}}` for all currently pending custom-tool uses.
- Accept `user.custom_tool_result` carrying `custom_tool_use_id`.
- Resume the Pi session and finish with `session.status_idle{stop_reason:{type:"end_turn"}}`.

Deferred:

- Request-level idempotency. Duplicate `user.custom_tool_result` handling is still non-idempotent at the API boundary, though a result with no pending runtime call is rejected.
- Permission-gated built-in/MCP tools (`user.tool_confirmation`) and the source path for `evaluated_permission`.
- Durable pending-call recovery after process crash or horizontal process handoff.
- Structured multi-block error payload preservation for `user.custom_tool_result.is_error`.

Acceptance:

- Deterministic service tests cover `agent.custom_tool_use`, aggregate `requires_action`, partial-result re-emission with remaining IDs, accepted result, runtime resume, and missing-pending-call rejection.
- Bridge tests cover timeout, abort, service-persistence failure, and `is_error:true` cleanup/error behavior.
- A live probe starts a real session, receives a custom-tool request, submits a result, and sees the session finish.
- Live probes cover both a single custom-tool round trip and a parallel two-custom-tool wait.
- Live error probe records the Pi `isError:true` return-shape limitation.
- The emitted IDs round-trip through `events.list` and `events.stream`.

### Cycle E — Sandbox Providers

Goal: make builtin shell/file tools execute in a per-session sandbox rather than the host process.

#### Cycle E.0 Plan — provider-neutral capability and lifecycle probe

Cycle E is infrastructure lifecycle work, not just another event-mapping slice. The first deliverable is a probe/design PR that proves the provider boundary before committing to one remote implementation.

Anchor the probe in the already-recorded design:

- ADR 0003: Pi's Operations interfaces are the typed per-tool boundary; Cycle E.0 found the SDK-helper drift, and Cycle E.1 verified the public `customTools` route for provider-owned builtin definitions.
- ADR 0007: keep sandbox provisioning lifecycle separate from per-call Operations adapters. `ManagedSandbox` owns provision/teardown; Pi `*Operations` implementations own shell/file calls.
- Cycle C.3a: one runtime session is cached per `sesn_*`; Cycle E sandboxes should follow the same lifecycle boundary.

Probe outputs:

1. **Injection path (closed by `scratch/19-e0-builtin-operations-injection.ts` and superseded by `scratch/21-e2-define-tool-builtins.ts`).** Pi 0.75.4 does not expose or forward `baseToolsOverride` through `createAgentSession(...)` or `createAgentSessionFromServices(...)`. The first working route was internal active-tool replacement; the accepted E.1 route is public `customTools` registration of `create*ToolDefinition(cwd, { operations })` definitions under the builtin names with `noTools: "builtin"` and a strict `tools` allowlist.
2. **Guarded passthrough provider.** Implement or probe a host-passthrough provider only as a non-isolating dev/test tool. It must be named and guarded as unsafe, not described as a sandbox.
3. **Deterministic lifecycle tests.** Use passthrough to prove provision/exec/teardown wiring, TTL eviction, hard runtime error cleanup, and runner close behavior without Modal credentials.
4. **First-isolation decision.** Decide Docker-local vs Modal as the first real isolation provider. Docker-local gives locally testable isolation without cloud credentials or cost; Modal gives the first managed remote target and cost/teardown realities.
5. **Docker Operations probe (closed by `scratch/22-e2-docker-operations-probe.ts`).** Docker-local is available on this machine and can meet the first isolation bar: non-root user, `--network none`, read-only rootfs, tmpfs `/workspace`, no Docker socket, dropped capabilities, `no-new-privileges`, PID limit, memory limit, and cleanup. `docker exec` streams stdout, timeout/abort leave no `sleep` process behind in the probe, and basic file operations work entirely inside `/workspace`.
6. **File-ops boundary decision.** E.2.1 starts with exec-per-op file Operations inside the container. `FindOperations.glob` uses one in-container file enumeration plus the shared JS matcher; the probe measured 56ms for that shape on a 90-file corpus versus 2406ms and 50 Docker execs for host-orchestrated per-directory traversal. Host bind mounts are rejected for provider internals because they put file contents back on the host. A richer fs bridge is deferred until exec-per-op proves too slow or insufficient.
7. **Remote access gate.** If Modal is selected for a later slice, confirm local credentials can create and destroy a trivial Modal sandbox. Record setup requirements and failure mode when credentials are absent.
8. **Remote infra realities.** For Modal, measure provisioning latency, forced sandbox death mid-tool, teardown reliability, and orphan visibility. Use those numbers to decide whether session creation blocks on sandbox readiness or sandbox start is lazy at first builtin tool call.

Design constraints coming out of E.0:

- One provider instance per `sesn_*`, coupled to the cached Pi runtime session unless a later latency probe proves a better lazy-start shape.
- Cycle E.2 uses Operations delegation into Docker-local. Pi session orchestration, model calls, and tool dispatch remain in the control-plane process; Docker backs the provider Operations. Whole-agent-in-container is a larger architecture and is explicitly deferred.
- Because E.2 delegates Operations rather than moving Pi itself into the container, the exact active-tool allowlist and fail-closed provider validator remain required. A sandboxed builtin that does not route through provider Operations must fail before output is published.
- Docker-local uses one long-lived container per session/provider handle and `docker exec` per Operation. Do not create a container per tool call.
- Docker-local starts with exec-per-op file Operations inside the container. For `FindOperations.glob`, use one in-container enumeration and shared JS matching, not one Docker exec per directory. Defer a persistent fs bridge until we have evidence that exec-per-op is too slow or too limited.
- Docker-local must not mount the host Docker socket, expose arbitrary bind mounts, inherit host env, or fall back to host execution.
- Docker-local command construction must stay testable without Docker. Keep container args, exec args, and per-file-operation shell snippets as pure builders with unit coverage; use Docker-gated tests only for daemon behavior.
- Docker-local providers may run a one-time startup sweep for stale labelled `open-managed-agents` containers. Do not sweep on every session creation; an age-based sweep during normal operation can kill older active sessions.
- Host passthrough is not an isolation boundary and cannot be enabled for untrusted prompts without an explicit unsafe opt-in.
- Teardown must run on every path that currently evicts or closes a Pi session: idle TTL, hard runtime error, runner close, and future `DELETE /v1/sessions` / `user.interrupt` cleanup.
- Provider failures must preserve ADR 0007's caller-safe/developer-only error split: public events/errors get safe messages; provider IDs, stack traces, and internal paths stay in logs.
- Do not build a parallel sandbox file/shell abstraction over Pi's Operations interfaces. Our owned layer is lifecycle; Pi's typed Operations are the per-tool boundary.
- Pi passes host environment data into `BashOperations.exec`; provider implementations must apply an explicit env allowlist/drop policy and must not blindly forward `options.env`.
- Avoid `session.agent.state.tools = [...]` internal mutation. E.1 uses public `customTools` definitions so Pi calls our provider-backed execute bodies directly. Keep provider invocation accounting and gated event release as defense in depth; validate by `toolCallId` only when a real provider Operation runs inside that tool execution context. Re-run `scratch/21-e2-define-tool-builtins.ts` on Pi SDK bumps.
- File Operations receive absolute paths after Pi resolves the model's input against `cwd`; that resolution is not a jail. E.1 providers must enforce workspace containment before read/write/list/search operations touch a backend.
- Host-passthrough path containment is best-effort hardening for a non-isolating provider. It rejects existing symlink escapes and final-component write symlinks, but real isolation belongs to Docker/remote providers.
- Pi's current `createGrepTool` is not fully provider-backed: even with custom `GrepOperations`, it still shells out to host `rg`. Keep grep disabled for sandbox-backed builtin tools until that path is replaced or upstreamed; grep-like capability remains available through policed bash.

Scope:

- Implement the provider lifecycle wrapper from ADR 0003.
- Register sandbox-backed Operations through Pi's public `create*ToolDefinition(...)` factories in `customTools`, with `noTools: "builtin"` and an exact `tools` allowlist.
- Add environment endpoints beyond the current default stub only as required by the sandbox lifecycle.
- Add teardown and orphan-cleanup behavior before running untrusted prompts.

Acceptance:

- A bash tool call reaches a provider-backed `BashOperations.exec` through Pi's public custom-tool definition path while preserving public `toolName: "bash"` and `tool_execution_update` streaming.
- The passthrough provider is explicitly unsafe and guarded.
- Session end destroys or releases the provider instance.
- Provider failure emits a caller-safe API error and developer-useful logs.

#### Cycle E.1 Plan — guarded passthrough provider and fail-closed runtime wiring

Goal: land the provider boundary without choosing Docker-local or Modal yet.

Evidence:

- `scratch/20-e1-passthrough-provider.ts` proves a real Pi bash turn routed through `PiSessionRunner` invokes the guarded host-passthrough provider.
- `scratch/21-e2-define-tool-builtins.ts` proves a provider-owned custom tool can use the public builtin name `bash` and stream updates through Pi's `onUpdate` callback.
- Unit tests cover deny-by-default env filtering, workspace path containment, explicit unsafe opt-in, provider invocation accounting, dispose behavior, active-tool surface enforcement, and the fail-closed runtime assertion.

Scope:

1. Add `SandboxProvider` as a thin owner of Pi's Operations objects, not a parallel shell/file vocabulary.
2. Implement guarded host passthrough for `bash`, `read`, `write`, `edit`, `find`, and `ls`.
3. Keep `grep` disabled for sandbox-backed builtins until Pi offers a fully delegated grep path or we replace it.
4. Wire the provider into `PiSessionRunner` behind explicit construction.
5. Register provider-owned builtin definitions through `customTools`, not internal active-tool mutation.
6. Keep a defense-in-depth fail-closed gate if Pi emits a sandboxed builtin tool event but the provider saw no operation invocation.

Out of scope:

- Docker-local isolation.
- Modal provisioning.
- Production enablement of host passthrough.
- Full env/policy DSL beyond an explicit key allowlist.
- Reimplementing Pi tool semantics by hand. E.1 uses Pi's own `create*ToolDefinition` factories, not bespoke bash/read/write/edit/find/ls definitions.

#### Cycle E.3 Plan — provider selection, fail-closed by default

Goal: make sandbox provider choice an explicit run/session execution setting without making any unsafe provider reachable by accident.

This slice is design-first rather than probe-first. E.0 through E.2 used probes because the unknowns were Pi and Docker capability. Provider selection is ordinary control-plane wiring; the risk is a bad default, not unknown SDK behavior.

Core decision:

- Provider selection is run/session execution config, not agent identity. A persisted agent definition should not encode "Docker vs Modal" unless a later product feature explicitly models environments that way.
- Provider selection is trusted execution configuration. It must be supplied by the control plane, operator config, or an authenticated API boundary that is allowed to choose execution backends. It must never be derived from prompt/model content or from untrusted agent-definition fields.
- Missing provider selection must fail closed. It must never silently route builtin tool execution to host passthrough.
- Host passthrough remains explicit unsafe opt-in only, and requires two gates: a deployment-level "allow unsafe passthrough" setting plus the per-session `unsafeAllowHostPassthrough: true` literal. Either gate missing means reject.
- Docker-local is selectable only after the Docker bash infrastructure-error follow-up is closed: [#22](https://github.com/oneryalcin/open-managed-agents/issues/22). #22 is now closed, so Docker-local may be enabled behind an explicit deployment-level gate.
- Docker-local must remain default-closed. If the deployment does not allow Docker-local, normal runtime creation must reject `docker-local` with a clear configuration error. Do not silently disable it or substitute another provider.
- Deployment runtime config is a server/operator boundary. The current product shape supports one sandbox provider selection per server deployment. Per-session, per-tenant, per-agent, and per-environment provider selection is explicitly out of scope for now because those shapes reopen the request-trust-boundary that the deployment-scoped model avoids by construction.
- Absent deployment config is equivalent to no provider. Explicit `{ type: "none" }` also means no builtin execution provider; builtin-using agents fail at runtime/session construction instead of falling back to host execution.
- Deployment config validation must dry-run the provider resolver at startup/config construction. Parse-only validation is insufficient because gated selections such as Docker-local are structurally valid but must still fail before the first request when their deployment gate is missing.

Proposed config shape:

```ts
type SandboxProviderSelection =
  | { type: "none" } // no builtin execution provider; builtin tools unavailable
  | { type: "host-passthrough"; unsafeAllowHostPassthrough: true; envAllowlist?: string[] }
  | {
      type: "docker-local";
      envAllowlist?: string[];
      operationTimeoutMs?: number;
      reapStaleContainersOlderThanMs?: number;
    };
```

Implementation rules:

1. Parse and validate runtime JSON fail-closed before resolving. Unknown provider types, misspelled types, malformed fields, or extra unsafe flags in the wrong variant are configuration errors, never fallback inputs.
2. Add a small resolver that maps a validated `SandboxProviderSelection` to a `SandboxProviderFactory | undefined`.
3. Keep the resolver boring: no policy engine, provider negotiation, or capability matching.
4. Reject `host-passthrough` unless the deployment allows unsafe passthrough and `unsafeAllowHostPassthrough: true` is present on the selection.
5. Reject `docker-local` unless the deployment explicitly enables it. Do not make it the implicit default and do not silently disable it.
6. If a session exposes builtin tools with `{type: "none"}` or no provider, return a caller-safe configuration error at session/runtime construction. Do not wait until the model first tries a builtin tool.
7. Keep provider-specific options narrow: env allowlist, operation timeout, and Docker-local stale-container reaping only. Network, mounts, snapshots, durable state, and egress policy are later provider slices.
8. Do not persist provider selection on the agent. If session persistence needs to remember it for continuity, persist it as session/runtime config, not agent config.
9. Reject accepted-but-ignored deployment config. For example, `allowDockerLocal` without `provider: "docker-local"` should fail configuration validation instead of being silently ignored.

Test plan:

- No provider configured plus builtin tool use fails closed before host execution.
- No provider configured plus user/custom-tool-only flow still works if no builtin tool is needed.
- Unknown or malformed runtime JSON provider selection is rejected; it never falls back to passthrough, Docker, or `none`.
- Host passthrough without unsafe opt-in is rejected.
- Host passthrough with only the per-session flag but no deployment-level allowance is rejected.
- Host passthrough with unsafe opt-in routes through the existing guarded provider.
- Docker-local without the deployment-level allowance is rejected.
- Docker-local with the deployment-level allowance resolves to the Docker-local provider factory.
- The resolver never defaults to host passthrough.
- Session/runtime config, not agent identity, owns the provider selection.

Out of scope:

- Modal, E2B, Daytona, Cloudflare, Kubernetes, or VM providers.
- Provider UI/dashboard selection.
- Mounts/resources/snapshots.
- Production defaulting to Docker-local.
- Changing the production default to Docker-local.

## Parity Checkpoint — MVP Control Plane, Not Full Anthropic Parity

Current checkpoint:

- Open Managed Agents has a working self-hosted control-plane MVP shape.
- The REST/SSE surface covers persisted agents, environments, sessions, session events, event listing, and stream replay.
- Runtime integration is real: user messages can flow through Pi, custom tools can pause/resume, and sandbox-backed builtin tool calls can be translated into `agent.tool_use` / `agent.tool_result` events.
- Docker-local is the first real isolation provider. It is deployment-gated, default-closed, and live-smoked through the served deployment app path with `bash` executing in-container at `/workspace`.

This is enough to call the project an MVP control plane with proven Docker-local execution.
It is not enough to claim full Anthropic Managed Agents compatibility or canonical tutorial parity.

Remaining parity gaps include archive-running-session behavior, evaluated permissions/tool confirmations, durable custom-tool recovery, request idempotency, agent update/versioning, span/model request events, managed remote sandbox providers, and production auth/RBAC/tenancy.

## Canonical Tutorial Compatibility Backlog

These items were found by tracing Anthropic's public Managed Agents workshop tutorials end to end. They are not all required for the first MVP platform-shape proof, but they are required before claiming that the canonical tutorials run unchanged against this server with only a base-URL swap.

| Item | Why it matters | Likely cycle |
|---|---|---|
| `GET /v1/sessions` with `agent_id`, `limit`, `page`, and `order` | Session pickers and dashboards list recent sessions before retrieving one. | Cycle B.1 |
| `title` and `metadata` on `POST /v1/sessions` | Tutorials name sessions and preserve UI flags on session metadata. | Cycle B.1 |
| `user.tool_confirmation` parsing and persistence | Permission-gated builtin/MCP tools use `tool_use_id`, separate from custom-tool `custom_tool_use_id`. | Cycle B.2 |
| `order` on `events.list` | Tutorial UIs replay conversation history in ascending order. | Cycle B.2 |
| Archive-running-session parity | Upstream expects clients to interrupt running sessions before archive; OMA still best-effort-closes on archive. | Lifecycle follow-up |
| Memory-store resources | File resources are mounted today; memory resources remain unsupported. | Resources follow-up |
| Agent update/versioning | Tutorials update agents with optimistic version checks and rely on sessions using latest-version semantics. | MVP+1 agent lifecycle |
| `evaluated_permission` on tool-use events | UIs show confirmation controls when a tool call evaluates to ask. | Runtime tool gating |
| `span.model_request_start` / `span.model_request_end` | Some UIs use span boundaries for transcript grouping and usage display. | Cycle C translation or explicit deferral |

## Later Work

Organizations, teams, users, auth, RBAC, and per-tenant billing are intentionally deferred. The current code uses a single internal workspace boundary (`wrk_default`) so storage and service APIs already have a place to attach tenancy later without changing every method signature.

CI and license are housekeeping gaps:

- Add GitHub Actions for `npm test`, `npm run typecheck`, and the scratch smoke probes.
- Choose and add a real `LICENSE` before inviting external contributions.
