# ADR 0004: Managed Agents REST/SSE surface as north star

**Status:** Accepted, 2026-05-21

## Context

We could invent our own API for self-hosted agents. Or we could clone Anthropic's Managed Agents surface and let clients written for Anthropic's offering target us with little more than a base-URL swap.

## Decision

**Match Anthropic's Managed Agents REST + SSE API as the north star.**

- **Endpoints:** `/v1/agents`, `/v1/sessions`, `/v1/sessions/{id}/events`, `/v1/sessions/{id}/events/stream`, `/v1/environments`. Beta-namespaced where Anthropic uses `/v1/beta/...`.
- **Event types:** `agent.message`, `agent.tool_use`, `agent.custom_tool_use`, `session.status_idle`, `session.status_terminated`, `agent.thinking`, etc. This is the compatibility north star, not a claim that every named event ships today; `src/types/events.ts` and OpenAPI are the authoritative implemented subset, and `agent.thinking` is currently deferred.
- **Request shapes mirror Anthropic's:** an agent has `model`/`system`/`tools`; a session has `agent`/`environment_id`/`resources`.
- **Beta-header convention:** we advertise an equivalent of `managed-agents-2026-04-01` for compatibility signaling. Clients passing Anthropic's beta header should not error.

## Why

- **Portable clients.** Anything written against the Anthropic SDK (Python, TS, cURL) targets us with a base-URL swap. This is the single highest-leverage decision we can make — every test against Anthropic's hosted offering becomes a test against our impl.
- **Anthropic's API shape is well-thought-out.** Agent/session/event/multiagent/vaults/outcomes are a coherent design. We get the design for free.
- **Forces clean separation between platform and engine.** If our REST endpoints look like Anthropic's, we *cannot* let Pi's internal shape bleed through. The translation layer is where all the platform value lives.
- **Documentation borrowing.** We can point at Anthropic's docs for conceptual explanation and just describe the *deviations*.

## Where we deviate (intentionally)

| Area | Deviation |
|---|---|
| **Auth** | Our auth, not Anthropic API keys. Bearer tokens or similar — TBD. |
| **Vaults / MCP proxy** | Post-MVP. When we add them, our vault implementation is ours; the *shape* matches Anthropic's. |
| **Field-level compatibility** | We match shape and naming, not every nullable field. A client may see `null` where Anthropic returns an empty object, or vice versa. |
| **Self-hosted sandbox mode** | The "loop on Anthropic, sandbox on you" inversion is Anthropic-only. We don't offer that; we're the inverse. |
| **Skills hosting** | Custom skill upload is post-MVP; the API shape will match Anthropic's when we get there. |

## Compatibility tiers

Without explicit tiers, every future "is this deviation acceptable?" debate becomes subjective. The tiers below make the contract auditable: anything in Tier 1 is wire-compatible-or-bust; Tier 2 is best-effort but reviewable per case; Tier 3 is documented divergence with a clear "this won't work" surface for SDK clients.

### Tier 1 — Wire-compatible (REQUIRED for client portability)

Breaking any of these silently breaks Anthropic SDK clients. Treat as load-bearing contract.

- **Endpoint paths and HTTP verbs.** `POST /v1/agents`, `GET /v1/agents`, `GET /v1/agents/{id}`, `POST /v1/sessions`, `GET /v1/sessions`, `GET /v1/sessions/{id}`, `POST /v1/sessions/{id}/events`, `GET /v1/sessions/{id}/events`, `GET /v1/sessions/{id}/events/stream`, `POST /v1/environments`, `GET /v1/environments`, `GET /v1/environments/{id}`. The MVP endpoint surface in [scope.md](../scope.md) is the authoritative subset; anything listed here that is not yet in MVP returns 501 until implemented.
- **Success status code is `200` on every endpoint, including POST creates** — Anthropic does NOT use `201 Created`. The response body carries the resource directly; no `Location` header is set. REST textbooks teach `201` for creates, so it's an easy default to reach for; returning `201` won't break most SDKs (they treat any `2xx` as success) but is a Tier 1 deviation that breaks strict status-code matchers.
- **Event type strings.** `agent.message`, `agent.tool_use`, `agent.custom_tool_use`, `agent.tool_result`, `session.status_idle`, `session.status_running`, `session.status_terminated`, `session.error`. Identical spelling, identical casing.
- **`stop_reason` enum values.** `end_turn`, `requires_action`, `retries_exhausted` on `session.status_idle`.
- **Round-trip field names** on `user.*` events: `user.message`, `user.interrupt`, `user.custom_tool_result` (with `custom_tool_use_id` — not `tool_use_id`), `user.tool_confirmation` (with `tool_use_id`).
- **Server-assigned event IDs** are stable strings, returned identically by `events.list` and the SSE stream.
- **`processed_at` semantics** match Anthropic's: `null` while queued, ISO 8601 timestamp once processed.
- **Idle gate semantics:** clients drain on `session.status_idle && stop_reason.type !== "requires_action"`. We must emit the `requires_action` variant correctly or the canonical client loop breaks.
- **Error envelope full shape.** Every error response is `{"type": "error", "error": {"type": "<error_type>", "message": "..."}, "request_id": "req_..."}`. The outer `type: "error"` field plus `request_id` for trace correlation are both load-bearing — SDKs check `error.type` for programmatic classification, and `request_id` is how end users report issues. The inner `error.type` enum follows Anthropic's public error contract: `"invalid_request_error" | "authentication_error" | "billing_error" | "permission_error" | "not_found_error" | "request_too_large" | "rate_limit_error" | "api_error" | "timeout_error" | "overloaded_error"` (see [Anthropic Errors](https://platform.claude.com/docs/en/api/errors)).
- **`agent` field shorthand on `POST /v1/sessions`.** The `agent` field accepts both a bare string ID (`"agent_abc"`) AND a full object (`{type: "agent", id, version?}`). Validators must accept both. (In MVP we ignore `version`; future versioning lands as additive behavior.)
- **Cursor parameter for `events.list` is named `page`** (not `after_id`, despite our internal API using that term). Token shape is opaque to clients; clients pass the previous response's `next_page` value unchanged. The route adapter may decode the token to the store's internal `afterId` cursor, but that is not part of the wire contract.
- **Require `anthropic-beta: managed-agents-2026-04-01` header.** Anthropic SDKs send it on every call. Our server must accept the required Managed Agents beta, allow additional future beta values, and hide the Managed Agents route surface when the required beta is missing.

### Tier 2 — Shape-compatible (recommended; deviations are reviewable)

These deviations *probably* won't break SDK clients, but they should be considered case-by-case:

- **Nullable-field presence.** Anthropic may return `null` where we omit a key; clients should tolerate both (and most do). We aim to match but don't make it load-bearing.
- **Error code mappings.** We use the same `error.type` enum (`invalid_request_error`, `rate_limit_error`, etc.) but our error messages will read differently.
- **Optional metadata fields.** `usage` shape, `model_usage` on `span.model_request_end`, etc. — match shape if cheap, deviate with notes if expensive.

### Tier 3 — Unsupported (documented divergence)

These features either don't exist in our implementation or are intentionally different. SDK calls that hit them get a 501 (Not Implemented) or 404 (route absent):

- Vaults / MCP proxy with auto-refresh (post-MVP)
- Memory stores (FUSE-mounted persistent memory) (post-MVP)
- Outcomes / rubric grading (post-MVP)
- Multiagent (`multiagent: coordinator`) (post-MVP)
- Webhooks (post-MVP)
- Skills hosting (post-MVP)
- Self-hosted sandbox mode (inverted architecture — we are the self-hosted side)
- Anthropic-specific auth (API keys minted on Anthropic infra) — we have our own auth

**Rule:** any new feature debate first asks "what tier?" If Tier 1, deviation needs strong justification. If Tier 2, document and move on. If Tier 3, the 501/404 is the right response.

## Where we may *not* deviate

- The agent persistence + versioning model. Agents are created once, referenced by ID, updated in place (each update creates a new immutable version). Sessions pin to a version. Same as Anthropic.
- The session-create-blocks-until-resources-mount semantics. Same as Anthropic.
- The pause/resume custom-tool round-trip. Same as Anthropic.
- The stream-first event ordering. Same as Anthropic.

These are load-bearing for client portability.

## Consequences

- We **link to and summarize** Anthropic's docs for conceptual explanation; we **do not copy** their prose or diagrams verbatim (avoid copyright/licensing complications). Our docs describe deviations and our specific implementation, citing upstream sections by URL.
- Every endpoint we add answers the question "does Anthropic have this? if yes, what's the shape?"
- If Anthropic adds a feature post-launch, we have a clear question: "is this an upstream feature we should match, or an Anthropic-hosted-only thing?"
- **We don't accept design contributions that fork from the upstream shape without strong justification.** Drift from the north star is a one-way door.

## Compatibility testing

Once the MVP runs, we should be able to:

1. Take an Anthropic Managed Agents quickstart example (Python or TS)
2. Change the base URL to `http://localhost:8080` (or wherever our control plane runs)
3. Have it work, modulo features we explicitly haven't implemented

MVP DoD proves the core platform shape (agent, session, events, custom-tool round trip, reconnect). Full canonical tutorial compatibility is tracked separately in [roadmap.md](../roadmap.md) and requires additive surfaces such as Files API, session cleanup, resource mounts, and agent update/versioning.

If that's not true, either our API has drifted or the example uses a deferred feature. Both are diagnostic.

## Open questions

- Whether to publish a Postman / Bruno collection of compatibility tests early. Cheap insurance against drift.
- Whether to match Anthropic's error-code enum (`invalid_request_error`, `rate_limit_error`, etc.) exactly. Probably yes — clients pattern-match on these.
