# Managed Agents Event Topology Parity

This document tracks OMA's event-type surface against the current Claude Managed
Agents reference taxonomy.

Source references:

- `/tmp/claude-docs/docs/managed-agents/reference.md`
- `src/types/events.ts`
- `src/types/__tests__/events.test.ts`
- `docs/references/managed-agents-observability-schema-findings.md`
- `scratch/artifacts/37-managed-agents-hosted-span-shape-1780448419-13013.json`
- `/tmp/open-ma-compare/packages/api-types/src/types.ts` at `f72a33f`
  (`SPEC_EVENT_TYPES` cross-check, 2026-06-04)

Use this as the tracker for event names. `EVENT_TYPES` should include only event
types OMA can currently accept, emit, list, or stream with a defensible shape.

## Open-ma SPEC_EVENT_TYPES Cross-check

On 2026-06-04, we diffed OMA's `EVENT_TYPES` against the independent open-ma /
openma.dev implementation's `SPEC_EVENT_TYPES` at clone commit `f72a33f`.

Result: OMA's current `EVENT_TYPES` is a strict subset of open-ma's official
spec allowlist. There are **no OMA-only event names** relative to that set, and
the 14 open-ma-only spec names are already represented below as deferred
features. This audit does not justify adding any new names to `EVENT_TYPES`
until the corresponding behavior exists.

| open-ma-only spec event | OMA tracker status |
|---|---|
| `user.define_outcome` | Deferred: outcomes/rubric loop |
| `agent.mcp_tool_use` | Deferred: MCP server support |
| `agent.mcp_tool_result` | Deferred: MCP server support |
| `agent.thread_message_received` | Deferred: multiagent sessions |
| `agent.thread_message_sent` | Deferred: multiagent sessions |
| `agent.thread_context_compacted` | Deferred: compaction/thread-context exposure |
| `session.thread_created` | Deferred: multiagent sessions |
| `session.thread_status_running` | Deferred: multiagent sessions |
| `session.thread_status_idle` | Deferred: multiagent sessions |
| `session.thread_status_terminated` | Deferred: multiagent sessions |
| `session.thread_status_rescheduled` | Deferred: multiagent sessions |
| `span.outcome_evaluation_start` | Deferred: outcomes/rubric loop |
| `span.outcome_evaluation_end` | Deferred: outcomes/rubric loop |
| `span.outcome_evaluation_ongoing` | Deferred: outcomes/rubric loop |

Open-ma also defines non-spec/product extension event names, including streaming
message/thinking/tool-input frames, `span.model_first_token`, compaction spans,
`session.warning`, `session.outcome_evaluated`, and `system.user_message_*`.
Their own source keeps these outside `SPEC_EVENT_TYPES` and gates some of them
behind opt-in streaming behavior. Treat these as future feature references, not
wire-compatible spec events to add by default.

## Status Legend

- **Implemented**: OMA emits or accepts the event through the public event API,
  and the type is present in `EVENT_TYPES`.
- **Partial**: OMA has the event type in `EVENT_TYPES`, but the upstream feature
  surface is not fully implemented yet.
- **Deferred**: event is known from the Claude reference but belongs to a
  deferred feature.
- **Not implemented**: event is known, but there is no current OMA behavior for
  it and no committed implementation plan yet.

## User Events

| Event type | OMA status | Current behavior / owner |
|---|---|---|
| `user.message` | Implemented | Accepted by `POST /v1/sessions/{id}/events`, persisted, listed, streamed, and used to start runtime turns. |
| `user.interrupt` | Implemented | Accepted by `POST /events`; aborts active runtime turns and retires pending waits. |
| `user.custom_tool_result` | Implemented | Accepted by `POST /events` with `custom_tool_use_id`; resumes pending custom-tool waits. |
| `user.tool_confirmation` | Implemented | Accepted by `POST /events` with `tool_use_id`; resolves ask-gated builtin tool confirmations. |
| `user.define_outcome` | Deferred | Outcomes/rubric loop is post-MVP. Do not add to `EVENT_TYPES` until OMA can process outcome definitions. |
| `user.tool_result` | Deferred | Self-hosted sandbox mode only in the Claude reference. OMA currently executes Docker-local tools inside the runtime bridge and emits `agent.tool_result`; it does not expose self-hosted sandbox result submission. |

## Agent Events

| Event type | OMA status | Current behavior / owner |
|---|---|---|
| `agent.message` | Implemented | Emitted from Pi assistant `message_end` text content. |
| `agent.thinking` | Partial | Present in `EVENT_TYPES`, reserved for compatible thinking content. Current Pi translation does not yet emit this on the common paths. |
| `agent.tool_use` | Implemented | Emitted for builtin/sandbox tool calls that are not custom tools and are not suppressed by the permission bridge. |
| `agent.tool_result` | Implemented | Emitted for builtin/sandbox tool results and terminalized permission waits. |
| `agent.custom_tool_use` | Implemented | Emitted for OMA custom tools; top-level `sevt_*` ID is the public correlation ID for `user.custom_tool_result`. |
| `agent.mcp_tool_use` | Deferred | MCP server support is post-MVP. |
| `agent.mcp_tool_result` | Deferred | MCP server support is post-MVP. |
| `agent.thread_context_compacted` | Deferred | Depends on exposing Pi compaction/thread-context events with a confirmed public shape. |
| `agent.thread_message_sent` | Deferred | Multiagent sessions are post-MVP. |
| `agent.thread_message_received` | Deferred | Multiagent sessions are post-MVP. |

## Session Events

| Event type | OMA status | Current behavior / owner |
|---|---|---|
| `session.status_running` | Implemented | Emitted when a runtime turn starts or resumes. |
| `session.status_idle` | Implemented | Emitted when a turn completes or pauses for `requires_action`; includes `stop_reason` where applicable. |
| `session.status_rescheduled` | Implemented | Present in `EVENT_TYPES` and translator support for Pi retry/reschedule paths. |
| `session.status_terminated` | Implemented | Emitted for archive/terminal lifecycle paths. |
| `session.deleted` | Implemented | Emitted before hard-delete stream closure; the event log is then removed for the deleted session. |
| `session.error` | Implemented | Emitted for runtime and terminalization errors. |
| `session.updated` | Deferred | Requires a session update API. Add only when updates are accepted and emitted. |
| `session.thread_created` | Deferred | Multiagent sessions are post-MVP. |
| `session.thread_status_running` | Deferred | Multiagent sessions are post-MVP. Hosted single-agent sessions may include thread status events, but OMA does not currently model public thread rows for single-agent runtime turns. |
| `session.thread_status_idle` | Deferred | Multiagent sessions are post-MVP. |
| `session.thread_status_rescheduled` | Deferred | Multiagent sessions are post-MVP. |
| `session.thread_status_terminated` | Deferred | Multiagent sessions are post-MVP. |

## Span Events

| Event type | OMA status | Current behavior / owner |
|---|---|---|
| `span.model_request_start` | Implemented | Emitted around Pi assistant model requests when Pi provides model/provider metadata on `message_start`. Start events carry no public payload fields, matching the TypeScript reference and hosted probe. |
| `span.model_request_end` | Implemented | Emitted on matching Pi assistant `message_end`, linked by `model_request_start_id`; includes `is_error` and `model_usage`. Synthetic error ends close abandoned/open spans during terminalization. |
| `span.outcome_evaluation_start` | Deferred | Outcomes/rubric loop is post-MVP. |
| `span.outcome_evaluation_ongoing` | Deferred | Outcomes/rubric loop is post-MVP. |
| `span.outcome_evaluation_end` | Deferred | Outcomes/rubric loop is post-MVP. |

## Model Request Span Contract

OMA's model request span shape is grounded by:

- TypeScript beta reference for `span.model_request_start`,
  `span.model_request_end`, and `model_usage`.
- Pi raw event probes for model-request ordering and usage timing.
- Hosted Claude Managed Agents probe for public payload keys and ordering.

Current contract:

- `span.model_request_start` has only the standard event envelope fields.
- `span.model_request_end` has:
  - `model_request_start_id`
  - `is_error`
  - `model_usage.cache_creation_input_tokens`
  - `model_usage.cache_read_input_tokens`
  - `model_usage.input_tokens`
  - `model_usage.output_tokens`
  - `model_usage.speed`
- Hosted probe `37` confirmed that `model_usage.speed` is present with `null`
  when no explicit speed value is returned.
- OMA derives UI duration from start/end `processed_at` timestamps; it does not
  invent a public `duration_ms` field.

Known remaining unknown:

- The exact hosted event shape for real model-provider failures remains
  unprobed. OMA currently treats Pi `stopReason: "error"` and `"aborted"` as
  `is_error: true`, and uses synthetic zero-usage error ends when a turn
  terminalizes with an open model request.

Permission-gated sandbox note:

- Ask-gated sandboxed builtin tools coalesce the public permission wait with
  the gated Pi `message_end`, so OMA emits
  `span.model_request_start -> agent.tool_use -> span.model_request_end ->
  session.status_idle(requires_action)` with real `message_end` usage and one
  public `agent.tool_use` ID. This is pinned by
  `src/control-plane/__tests__/tool-confirmation-api.test.ts`.
- If one Pi `message_end` contains multiple sandboxed builtin tool calls, OMA
  suppresses every tool call in the consumed message to avoid duplicate or
  non-actionable `agent.tool_use` rows. Sibling tool uses are then emitted from
  their own permission events and may appear after the shared
  `span.model_request_end`; this is a bounded trace-nesting gap, not a
  correlation or confirmation gap.

## Maintenance Rules

- Update this file, `src/types/events.ts`, and
  `src/types/__tests__/events.test.ts` together when adding or removing a
  supported event type.
- Do not add an upstream event name to `EVENT_TYPES` unless OMA can emit,
  accept, list, or stream it with a defensible shape.
- For Pi/runtime-dependent shapes, read upstream Pi SDK docs first, then inspect
  installed package source and/or run a cheap probe before implementation.
- If a hosted probe contradicts this matrix, update this document before
  coding against the new assumption.
