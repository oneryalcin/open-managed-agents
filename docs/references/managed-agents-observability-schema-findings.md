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
- Hosted probe against Claude Managed Agents on 2026-06-02 using
  `claude-sonnet-4-6`
- Upstream Pi SDK docs:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md>
- Fresh Pi raw event probes on 2026-06-02:
  `scratch/10-pi-event-dump.ts` and `scratch/21-e2-define-tool-builtins.ts`

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

The upstream Pi SDK docs confirm that `AgentSession.subscribe()` emits the
runtime lifecycle events OMA already uses:

- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`

The SDK docs do not document the full payload shape for usage, provider/model
metadata, response IDs, or error terminal metadata. Those fields should still be
verified with a raw Pi probe before implementation.

## Pi Probe Findings

On 2026-06-02, fresh Pi raw event probes were run with
`anthropic/claude-haiku-4-5`:

- `scratch/10-pi-event-dump.ts`
- `scratch/21-e2-define-tool-builtins.ts`

The probes covered:

- simple assistant response
- custom-tool call
- thrown custom tool
- aborted custom tool
- provider-owned builtin-shaped `bash` custom tool
- provider-owned builtin-shaped `oma_bash` custom tool

Findings:

- Assistant model requests were strictly non-interleaved in all probed paths.
  The maximum open assistant message count was `1` for every scenario.
- Assistant `message_start` carried model/provider metadata and zero usage, but
  no `responseId`.
- `responseId` appeared on assistant `message_update` partials and on
  assistant `message_end`, so it is useful metadata but not a valid
  start-side correlation key.
- Usage was present on assistant `message_update`, but final `output` token
  counts were only reliable on assistant `message_end`.
- Tool-using paths emitted two assistant model requests: one ending with
  `stopReason: "toolUse"`, then tool execution events, then a second assistant
  model request for the final message.
- Thrown-tool and abort paths emitted `tool_execution_end` with
  `isError: true`.
- The abort path then emitted an assistant `message_start` and `message_end`
  with `stopReason: "aborted"`, zero usage, and no `responseId`.
- Provider-owned builtin-shaped `bash` through `customTools` produced the same
  two-assistant-request shape as ordinary custom tools, and also emitted
  `tool_execution_update` before `tool_execution_end`.

Implications:

- The first implementation can use a single open assistant model-request slot
  per runtime turn.
- The span end should be emitted from assistant `message_end`, not from
  `message_update`, because that is where final output usage is observed.
- Synthetic terminalization span ends with zero usage are consistent with the
  abort event shape, though hosted model-request-error behavior remains
  unprobed.

## Hosted Probe Findings

On 2026-06-02, a cheap hosted probe used `claude-sonnet-4-6` to inspect actual
Managed Agents event-list output for:

- a simple assistant message
- a Bash-tool turn with `{"type":"agent_toolset_20260401"}` enabled

The samples matched the TypeScript span schema. The hosted span events did not
include provider, model, response ID, request ID, or duration fields beyond the
documented fields.

Simple assistant response ordering:

```text
session.status_running
session.thread_status_running
user.message
span.model_request_start
agent.message
span.model_request_end
```

The matching `span.model_request_end` contained:

```json
{
  "is_error": false,
  "model_request_start_id": "sevt_...",
  "model_usage": {
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "input_tokens": 606,
    "output_tokens": 13
  }
}
```

Real Bash-tool turn ordering:

```text
session.status_running
session.thread_status_running
user.message
span.model_request_start
agent.tool_use
span.model_request_end
agent.tool_result
span.model_request_start
agent.message
span.model_request_end
session.thread_status_idle
session.status_idle
```

The first span wrapped the model request that decided to call Bash:

```json
{
  "is_error": false,
  "model_request_start_id": "sevt_...",
  "model_usage": {
    "cache_creation_input_tokens": 5473,
    "cache_read_input_tokens": 0,
    "input_tokens": 3,
    "output_tokens": 64
  }
}
```

The second span wrapped the model request that produced the final assistant
message after the tool result:

```json
{
  "is_error": false,
  "model_request_start_id": "sevt_...",
  "model_usage": {
    "cache_creation_input_tokens": 92,
    "cache_read_input_tokens": 5473,
    "input_tokens": 1,
    "output_tokens": 16
  }
}
```

Observed ordering detail: hosted emits the transcript event
(`agent.message` or `agent.tool_use`) immediately before the corresponding
`span.model_request_end`. OMA should match that ordering rather than emitting
the end span before the transcript event.

## Remaining Unknowns

- What exact event shape hosted Managed Agents emits on model request errors.
- Whether Pi exposes enough model error metadata to produce
  `span.model_request_end` with `is_error: true`.
- Whether Pi model-provider failures produce an assistant `message_end`, an
  agent-level error event, or only a thrown `session.prompt()` error.

The happy-path span payload and ordering questions are resolved by the hosted
Sonnet probe above. Pi sequencing and usage-timing questions are resolved by the
fresh Pi probes above. Model-request provider-error behavior should still be
resolved by probing before implementing non-synthetic `is_error: true`
semantics if a cheap trigger is available.
