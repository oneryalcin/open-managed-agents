# Managed Agents Observability Schema Findings

This note records the current Claude Managed Agents observability schema findings
used by `docs/plans/0084-session-observability-spans.md`.

Sources checked:

- <https://platform.claude.com/docs/en/api/overview.md>
- <https://platform.claude.com/docs/en/managed-agents/sessions.md>
- <https://platform.claude.com/docs/en/managed-agents/reference.md>
- <https://platform.claude.com/docs/en/managed-agents/events-and-streaming.md>
- `/tmp/claude-docs/docs/api/typescript/beta/sessions/events/stream.md`
- `/tmp/claude-docs/docs/api/typescript/beta/sessions/events/list.md`
- `/tmp/claude-docs/docs/api/typescript/beta/sessions/retrieve.md`

## API Overview

The API overview states that Claude Managed Agents are part of the Claude API
beta surface. Relevant docs are:

- Managed Agents quickstart
- Agents API
- Sessions API
- Environments API
- beta headers

The overview does not define event payload schemas. It points to the Managed
Agents sessions and reference pages for that detail.

## Event Catalog

The Managed Agents reference page lists these span events:

- `span.model_request_start`
- `span.model_request_end`
- `span.outcome_evaluation_start`
- `span.outcome_evaluation_ongoing`
- `span.outcome_evaluation_end`

The reference describes span events as observability markers that wrap activity
for timing and usage tracking. It specifically says `span.model_request_end`
includes `model_usage` with token counts.

## Event Stream Semantics

The events and streaming docs say:

- every event includes `processed_at`
- `processed_at: null` means the event is queued by the harness and will be
  handled after preceding events finish
- clients should open the stream first, then list history, then dedupe by event
  ID when reconnecting
- session events, span events, and agent events are emitted back to clients for
  session state and progress observability

This matches OMA's existing append-only event log and stream-first replay model.

## TypeScript Span Schema

The TypeScript beta reference is more precise than the prose docs.

`BetaManagedAgentsSpanModelRequestStartEvent`:

- `id: string`
- `processed_at: string`
- `type: "span.model_request_start"`

No provider/model/request metadata is documented on the start event.

`BetaManagedAgentsSpanModelRequestEndEvent`:

- `id: string`
- `is_error: boolean | null`
- `model_request_start_id: string`
- `model_usage: BetaManagedAgentsSpanModelUsage`
- `processed_at: string`
- `type: "span.model_request_end"`

`model_request_start_id` is the documented join key. It points to the
corresponding `span.model_request_start` event ID. Do not invent a separate
`span_id` unless the hosted API later exposes one.

`BetaManagedAgentsSpanModelUsage`:

- `cache_creation_input_tokens: number`
- `cache_read_input_tokens: number`
- `input_tokens: number`
- `output_tokens: number`
- `speed?: "standard" | "fast" | null`

The TypeScript reference does not document cost fields on span model usage.

## Session Usage Schema

`BetaManagedAgentsSessionUsage` is cumulative usage for a session across all
turns.

Documented fields:

- `input_tokens?: number`
- `output_tokens?: number`
- `cache_read_input_tokens?: number`
- `cache_creation?: BetaManagedAgentsCacheCreationUsage`

`BetaManagedAgentsCacheCreationUsage`:

- `ephemeral_1h_input_tokens?: number`
- `ephemeral_5m_input_tokens?: number`

This is more precise than the prose events page, which gives a simpler example
with `cache_creation_input_tokens`. For implementation, prefer the TypeScript
reference because it is the SDK-facing schema.

## OMA Implications

For OMA span parity:

- Add `span.model_request_start` and `span.model_request_end` to the public
  event registry.
- Emit start events with no additional public fields unless hosted API samples
  prove otherwise.
- Emit end events with `model_request_start_id`, `is_error`, and
  `model_usage`.
- Derive duration for UI from start/end `processed_at` timestamps rather than
  adding an undocumented `duration_ms` field.
- Keep provider/model/response ID as internal probe data for now unless hosted
  API responses prove they are public fields.
- Keep session usage aggregation as a follow-up after span-level model usage is
  correct.

## Remaining Unknowns

- Whether hosted event samples ever include provider/model/request metadata on
  span events despite the TypeScript reference not listing those fields.
- What exact event shape hosted Managed Agents emits on model request errors.
- Whether Pi exposes enough model error metadata to produce
  `span.model_request_end` with `is_error: true`.
- How hosted ordering behaves around `span.model_request_end` and the associated
  `agent.message` / `agent.tool_use` event.

These should be resolved by API probing before implementation if credentials and
a cheap probe path are available.
