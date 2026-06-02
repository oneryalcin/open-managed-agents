# Session Observability Spans

## Context

The next Managed Agents parity gap is session observability: the hosted Console
shows timeline blocks, model request durations, token counts, tool durations,
and detailed event panes. OMA already has the append-only event log and the
core transcript events, but it does not yet emit span events or persist useful
session usage.

Current OMA event types live in `src/types/events.ts`; the emitted set contains
agent, session, and user events, but no `span.*` events yet
(`src/types/events.ts:19`). The current Pi translator maps only:

- `agent_start` -> `session.status_running`
- `message_end` -> `agent.message` / `agent.tool_use`
- `tool_execution_end` -> `agent.tool_result`
- `agent_end` -> `session.status_idle`

See `src/control-plane/sessions/pi/translator.ts:10`.

The architecture document already names `Pi.subscribe()` as the live source that
the control plane translates into Managed Agents event shapes
(`docs/architecture.md:115`), and preserves the event-log rule that every event
is persisted before broadcast (`docs/architecture.md:133`). The plan should
extend that same translator/event-log path, not introduce a separate telemetry
store.

The official Claude Managed Agents reference documents span events as
observability markers for timing and usage. It names:

- `span.model_request_start`
- `span.model_request_end`, which "includes `model_usage` with token counts"
- `span.outcome_evaluation_start`
- `span.outcome_evaluation_ongoing`
- `span.outcome_evaluation_end`

Source: <https://platform.claude.com/docs/en/managed-agents/reference.md>.

The official events docs also say every event includes `processed_at` and list
the reconnect pattern as stream-first then history-list/dedupe. The TypeScript
API reference gives the more precise span and session usage schemas:

- `BetaManagedAgentsSpanModelRequestStartEvent` has only `id`,
  `processed_at`, and `type`.
- `BetaManagedAgentsSpanModelRequestEndEvent` has `id`, `is_error`,
  `model_request_start_id`, `model_usage`, `processed_at`, and `type`.
- `BetaManagedAgentsSpanModelUsage` has `input_tokens`, `output_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, and optional
  `speed`.
- `BetaManagedAgentsSessionUsage` has cumulative `input_tokens`,
  `output_tokens`, `cache_read_input_tokens`, and nested `cache_creation`
  broken down into `ephemeral_1h_input_tokens` and
  `ephemeral_5m_input_tokens`.

Source:
<https://platform.claude.com/docs/en/managed-agents/events-and-streaming.md>.
Local schema references:
`/tmp/claude-docs/docs/api/typescript/beta/sessions/events/stream.md`,
`/tmp/claude-docs/docs/api/typescript/beta/sessions/events/list.md`, and
`/tmp/claude-docs/docs/api/typescript/beta/sessions/retrieve.md`.

## Goal

Add a small, reviewable span/event-observability slice that lets OMA sessions
carry the data needed for the essential Console timeline:

- `span.model_request_start`
- `span.model_request_end`
- model/provider/response metadata when available
- token/cache/cost usage when available from Pi
- model request duration derivable from start/end `processed_at`
- stable ordering through `events.list` and SSE replay

This is the data layer for UI parity. The UI should come after this, not before.

## Non-Goals

- Memory stores or memory resources.
- Outcome definition or `span.outcome_evaluation_*`.
- Multiagent thread events.
- Exact hosted Console UI.
- Exact token accounting when Pi or the Anthropic SDK does not expose a value.
- A separate analytics database.
- Mutating historical events after persistence.

## Current Evidence

Captured Pi fixtures already expose model metadata and usage on assistant
messages:

- `scratch/artifacts/pi-events/simple_message.jsonl` has `message_start`,
  `message_update`, `message_end`, `turn_end`, and `agent_end` events carrying
  `api`, `provider`, `model`, `usage`, `stopReason`, `timestamp`, and
  `responseId`.
- `scratch/artifacts/pi-events/tool_call.jsonl` shows a multi-request turn:
  one assistant message with `stopReason: "toolUse"`, one tool execution, and a
  second assistant message with final text and its own usage.

This strongly suggests that the first span slice can be derived from Pi
assistant-message lifecycle events. Still, implementation must start with a
fresh probe because the fixture set predates the recent Docker/custom-tool work
and does not include every provider/tool path we now care about.

## Proposed Event Contract

Add these to `EVENT_TYPES` and the hardcoded alignment test:

```text
span.model_request_start
span.model_request_end
```

Recommended public payloads:

```ts
// span.model_request_start
// No additional documented fields.
{}

// span.model_request_end
{
  model_request_start_id: "sevt_...",
  is_error: boolean | null,
  model_usage?: {
    cache_creation_input_tokens: number,
    cache_read_input_tokens: number,
    input_tokens: number,
    output_tokens: number,
    speed?: "standard" | "fast" | null,
  },
}
```

Use the start event's ordinary `sevt_*` event ID as the join key. The end event
points back to it via `model_request_start_id`, matching the TypeScript API
reference. Do not invent a separate `span_id`.

Do not put provider/model/response metadata on the span events unless a hosted
API response or TypeScript reference proves those fields are public. Pi exposes
`api`, `provider`, `model`, and `responseId`, but the current TypeScript
Managed Agents span event schema does not document those as span fields.

The `model_usage` field name comes directly from the Managed Agents TypeScript
reference. Use that name for model-request end spans rather than the generic
Pi-local `usage`.

## Derivation Strategy

Preferred initial mapping:

1. On Pi `message_start` for assistant messages with model/provider metadata,
   emit `span.model_request_start`.
2. Track the persisted start event ID for that model request inside the active
   runtime turn.
3. On the matching assistant `message_end`, emit `span.model_request_end` with
   `model_request_start_id`, `is_error`, and final `model_usage`.
4. Continue translating `message_end` into `agent.message` / `agent.tool_use`
   as today.

Ordering should be:

```text
session.status_running
span.model_request_start
span.model_request_end
agent.message OR agent.tool_use
...
session.status_idle
```

For tool-using turns, each assistant model request gets its own start/end pair:

```text
session.status_running
span.model_request_start
span.model_request_end
agent.tool_use
agent.tool_result
span.model_request_start
span.model_request_end
agent.message
session.status_idle
```

This mirrors the hosted Console shape where model request blocks and tool blocks
are distinct timeline segments.

## Implementation Shape

### 1. Probe Pi event metadata first

Add or run a scratch probe that captures a current Pi session for:

- simple assistant message
- builtin Docker-local bash call
- persisted custom tool call
- interrupt or model error if cheap to trigger

The probe should record the raw Pi event stream under `scratch/artifacts/` or a
documented temporary path. Before coding, confirm:

- whether every assistant model request has a stable `responseId`
- whether `message_start.timestamp` and `message_end.timestamp` are sufficient
  for internal validation, while public duration remains derived from start/end
  `processed_at`
- whether usage appears first on updates or only reliably on `message_end`
- what error-path event shape carries model-request failure data

### 2. Extend the public event registry

Files:

- `src/types/events.ts`
- `src/types/__tests__/events.test.ts`
- `docs/scope.md`
- `docs/roadmap.md`
- `docs/architecture.md`
- `docs/references/managed-agents-event-topology.md` if present, or create it
  if the tracker still only exists in issue text.

Add `span.model_request_start` and `span.model_request_end` as supported event
types. Move them out of the deferred-event table.

### 3. Add span translation state

The current translator is stateless and only sees one Pi event at a time. Model
request spans need correlation between `message_start` and `message_end`.

Two viable implementation options:

#### Option A: Keep translator stateless, add a runtime event normalizer

Introduce a small stateful wrapper in the Pi runner or event service that:

- receives raw Pi events
- emits span drafts from assistant-message lifecycle events
- passes the original event through `translatePiEvent`

Pros:

- Keeps `translatePiEvent` simple for one-event mappings.
- Makes span state explicit as runtime-turn state.
- Avoids hiding correlation state in a function that currently looks pure.

Cons:

- Adds one more layer between runner and service.

#### Option B: Make the translator stateful

Create a `PiEventTranslator` class that owns per-session/per-turn span state and
replaces the pure `translatePiEvent` function for runtime use.

Pros:

- Keeps all Pi-to-OMA translation in one module.
- Easier to fixture-test multi-event sequences.

Cons:

- Larger change to existing translator tests.
- The current pure helper is useful and should probably remain for simple unit
  cases.

Recommendation: Option A for the first slice. It is a smaller behavioral change
and keeps the existing pure translator tests intact. If span handling grows
past model requests, revisit a stateful translator class.

### 4. Persist spans through the existing event log

Span events must use the same `materializePersistedEvents`,
`appendBatch`/`appendBatchWithRuntimeChanges`, and broadcaster path as existing
events. No special SSE channel.

The implementation must preserve:

- stable `sevt_*` event IDs
- `processed_at` semantics
- type filters in `events.list`
- replay via `Last-Event-ID`
- atomic persist-before-publish behavior

### 5. Session usage follow-up

`sessions.store.ts` currently keeps `usage` as `null`. Once span end events
carry reliable `model_usage`, add a second small slice to aggregate session-level
usage from model-request end spans.

Use hosted session field names for the aggregate:

```ts
{
  input_tokens?: number,
  output_tokens?: number,
  cache_read_input_tokens?: number,
  cache_creation?: {
    ephemeral_1h_input_tokens?: number,
    ephemeral_5m_input_tokens?: number,
  },
}
```

Do not block span events on session usage aggregation. It is better to ship
correct event-level usage first.

## Acceptance Criteria

1. `EVENT_TYPES` includes `span.model_request_start` and
   `span.model_request_end`, and the alignment test fails if either registry
   drifts.
2. A simple Pi assistant response emits:
   `session.status_running -> span.model_request_start ->
   span.model_request_end -> agent.message -> session.status_idle`.
3. A tool-using Pi turn emits one model span pair before `agent.tool_use` and
   another model span pair before the final `agent.message`.
4. `span.model_request_end` includes `model_request_start_id`, `is_error`, and
   `model_usage` when Pi exposes usage.
5. Span start/end events are persisted and replayed through `events.list`.
6. Span events stream over SSE with the same IDs and order as `events.list`.
7. `types[]=span.model_request_end` filtering works.
8. If Pi omits `model_usage` or response ID, the event still emits with missing
   optional fields rather than fabricating values.
9. Error/interrupt behavior is either implemented with tests or explicitly
   deferred with a documented fixture gap.
10. `docs/scope.md`, `docs/roadmap.md`, and the event-topology tracker are
    updated so the supported/deferred event matrix matches code.

## Tests

Unit:

- Translator/normalizer fixture test for simple assistant span pair.
- Fixture test for tool-call turn with two span pairs.
- Fixture test that missing `model_usage` does not throw and does not invent
  usage.

Integration:

- `events.send` with a fake runtime event stream returns persisted span events
  in order.
- `events.list` returns span events in both ascending and descending order.
- `events.list?types[]=span.model_request_end` returns only matching events.
- SSE stream includes span events and replay remains gap-safe.

Smoke:

- Extend the CWC example smoke only if the span fields are visible through the
  public API without making the smoke brittle on token counts.

## Risks

### Risk: Pi usage fields are not stable enough

Mitigation: probe first; only publish fields observed on `message_end` or
equivalent terminal events. Keep uncertain fields optional.

### Risk: Start/end correlation breaks on concurrent turns

Mitigation: key span state by `(workspaceId, sessionId, runtime turn, responseId
or assistant-message index)`. Add a test with multiple model requests in one
session.

### Risk: Span events reorder transcript events

Mitigation: emit span events from the same runtime queue before derived
`agent.message` / `agent.tool_use` drafts for the same model response. Assert
exact order in tests.

### Risk: Hosted payload shape differs from our guessed payload

Mitigation: before implementation, check local CMA docs/API samples and update
this plan if they provide exact fields. Do not encode screenshots alone as a
wire contract.

## Open Questions Before Code

1. Does hosted Managed Agents expose a stable `span_id` prefix or only `sevt_*`
   event IDs for spans?
2. Are model request start/end payloads top-level fields or nested under
   something like `model_request`?
3. Does the hosted API include token usage on span events, session objects, or
   both?
4. Does Pi emit model-error terminal metadata that can produce a matching
   `span.model_request_end{is_error:true}`?
5. Should `agent.message` also carry usage, or should usage live only on spans
   and session summaries?

## Review Checklist

- The plan does not claim memory or hosted UI parity.
- Span event shapes are open enough to avoid fake precision, but specific
  enough for UI timeline work.
- Every new emitted event remains append-only and replayable.
- The implementation starts with a Pi/API probe rather than stale fixture
  inference.
- Tests prove both no-tool and tool-using turns.
