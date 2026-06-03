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

A hosted probe on 2026-06-02 used `claude-sonnet-4-6` to resolve the happy-path
ordering questions. The probe confirmed that span start events have no public
provider/model/request metadata, span end events use
`model_request_start_id` plus `model_usage`, and hosted emits
`agent.message` / `agent.tool_use` immediately before the corresponding
`span.model_request_end`. See
`docs/references/managed-agents-observability-schema-findings.md`.

The upstream Pi SDK docs confirm the runtime event lifecycle names OMA already
translates (`message_start`, `message_end`, `tool_execution_*`, `agent_*`, and
`turn_*`), but they do not document the payload fields needed for model usage,
provider/model metadata, response IDs, or error terminal state. The
implementation still needs a raw Pi probe before coding those fields.

A fresh Pi raw event probe on 2026-06-02 covered simple responses, custom-tool
calls, thrown tools, abort, and provider-owned builtin-shaped `bash` tools. It
confirmed strict non-interleaving for assistant model requests in the probed
paths, no `responseId` on assistant `message_start`, final usage on assistant
`message_end`, and abort terminal messages with `stopReason: "aborted"` plus
zero usage. See
`docs/references/managed-agents-observability-schema-findings.md`.

## Goal

Add a small, reviewable span/event-observability slice that lets OMA sessions
carry the data needed for the essential Console timeline:

- `span.model_request_start`
- `span.model_request_end`
- token/cache usage when available from Pi
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
  model_usage: {
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

`model_usage` is documented as required on hosted span end events. If a Pi
terminal event does not expose usage, the implementation must either delay the
span end until a terminal payload with usage is available, or explicitly ship a
documented OMA divergence. Do not silently make `model_usage` optional in the
public contract.

## Derivation Strategy

Preferred initial mapping:

1. On Pi `message_start` for assistant messages with model/provider metadata,
   emit `span.model_request_start`.
2. Track the persisted start event ID for that model request inside the active
   runtime turn. For normal in-process completion, use a single open assistant
   model-request slot per runtime turn; current Pi fixtures and the fresh
   2026-06-02 Pi probe show strict non-interleaved assistant model requests.
3. On the matching assistant `message_end`, emit `span.model_request_end` with
   `model_request_start_id`, `is_error`, and final `model_usage`.
4. Continue translating `message_end` into `agent.message` / `agent.tool_use`
   as today.

Do not key the open span by `responseId` at `message_start` time. Existing Pi
fixtures and the fresh Pi probe show `responseId` on assistant
`message_update` / `message_end`, not on `message_start`, so the start-side
correlation must be positional.

Hosted ordering for a simple response is:

```text
session.status_running
session.thread_status_running
user.message
span.model_request_start
agent.message
span.model_request_end
...
session.status_idle
```

For tool-using turns, each assistant model request gets its own start/end pair:

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
session.status_idle
```

This mirrors the hosted Console shape where model request blocks and tool blocks
are distinct timeline segments.

## Implementation Shape

### 1. Probe Pi event metadata first

This plan already has a fresh 2026-06-02 probe for the common paths. Before
coding, rerun or extend the scratch probe if the installed Pi SDK changes or if
the implementation needs a model-provider error path.

The current probe covers:

- simple assistant message
- provider-owned builtin-shaped bash call
- persisted custom tool call
- thrown tool
- interrupt / abort

The probe records the raw Pi event stream under `scratch/artifacts/`. Current
findings:

- assistant model requests are strictly non-interleaved in the probed paths
- `responseId` appears on assistant updates/end, not start
- `message_start.timestamp` and `message_end.timestamp` are sufficient for
  internal validation, while public duration remains derived from start/end
  `processed_at`
- usage appears on updates, but final output usage is reliable on `message_end`
- tool throw and abort are covered; model-provider error shape remains unknown

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

The normalizer should be a single in-pass transform feeding the same ordered
draft batch as the existing runtime translator. Do not implement it as a second
`Pi.subscribe()` consumer. The intended shape is:

```ts
[...spanDraftsFor(piEvent), ...translatePiEvent(piEvent)]
```

with hosted-compatible ordering for assistant terminal events:

```ts
[...transcriptDraftsFor(piEvent), spanEndDraftFor(piEvent)]
```

Add a unit test at the draft-array level so future refactors cannot reorder the
span and transcript drafts while still passing only persisted-log assertions.

### 4. Close open spans on terminalization

An emitted `span.model_request_start` must not remain permanently dangling if
the runtime fails, is interrupted, is terminalized during recovery, or loses
runtime state while waiting for a tool result/confirmation.

Use a small durable open-span field on `pending_runtime_turns` for this. The
append-only `events` table is session-scoped and has no `turn_id`, and event
listing is paginated/capped. Reconstructing open spans by scanning the session
log would either be O(n) with explicit pagination on every terminalization or
silently wrong if implemented as a single-page scan.

Add a JSON field such as `open_model_request_start_ids` to the pending runtime
turn record. Treat it as a stack/array of hosted public start event IDs:

1. When emitting `span.model_request_start`, append the span start event and add
   its persisted `sevt_*` ID to the turn's open-span list in the same
   `appendBatchWithRuntimeChanges` transaction.
2. When emitting the matching transcript event and `span.model_request_end`,
   append both events and remove that start ID from the open-span list in the
   same transaction.
3. When terminalizing a turn, read the open-span list from the claimed/current
   pending runtime turn record and emit one synthetic end per still-open start.
   Clear the open-span list and close the turn in the same
   `appendBatchWithRuntimeChanges` transaction.

Synthetic terminalization span ends should use:

```ts
{
  model_request_start_id: "sevt_...",
  is_error: true,
  model_usage: zeroUsage,
}
```

where `zeroUsage` is the hosted-shaped zero-token object:

```ts
{
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  input_tokens: 0,
  output_tokens: 0,
}
```

This preserves the required `model_usage` field without fabricating token
consumption. If hosted model-error probes show a different error usage policy,
update this plan before implementation.

Terminalization path requirements:

- In-process runtime failure: emit synthetic span ends before the existing
  `session.error` and `session.status_idle` rows, in the same transaction that
  terminalizes the runtime turn.
- Custom-tool / tool-confirmation terminalization: emit synthetic span ends
  before the existing terminal result/error and idle rows, in the same
  transaction that acknowledges/closes actions and terminalizes the turn.
- Abandoned-turn recovery: use the claimed terminalizing turn record's
  `owner_id` and incremented `owner_generation` when closing the turn, so a
  stale owner cannot append duplicate synthetic ends after losing the lease.
- Archive: inject synthetic span ends into the archive close batch before
  `session.status_terminated`; archive does not emit `session.error`.
- Delete: no synthetic close is needed after hard delete because the event log
  is deleted with the session. Close runtime turns before deleting rows as
  today.

The atomicity requirement is load-bearing: synthetic span ends, open-span-list
clearing, action closure/acknowledgement when applicable, and turn closure must
commit or roll back together. Tests should assert the synthetic end appears
before the terminal rows, not just that it exists.

### 5. Persist spans through the existing event log

Span events must use the same `materializePersistedEvents`,
`appendBatch`/`appendBatchWithRuntimeChanges`, and broadcaster path as existing
events. No special SSE channel.

The implementation must preserve:

- stable `sevt_*` event IDs
- `processed_at` semantics
- type filters in `events.list`
- replay via `Last-Event-ID`
- atomic persist-before-publish behavior

### 6. Session usage follow-up

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
   agent.message -> span.model_request_end -> session.status_idle`.
3. A tool-using Pi turn emits one model span start before `agent.tool_use`,
   the matching model span end after `agent.tool_use`, then another model span
   start before the final `agent.message` and the matching model span end after
   that message.
4. `span.model_request_end` includes required `model_request_start_id`,
   `is_error`, and `model_usage`.
5. Span start/end events are persisted and replayed through `events.list`.
6. Span events stream over SSE with the same IDs and order as `events.list`.
7. `types[]=span.model_request_end` filtering works.
8. If Pi omits `responseId`, correlation still works via the single open
   assistant model-request slot.
9. Runtime failure, interrupt, archive terminalization, and abandoned-turn
   recovery close any unmatched model-request start with a synthetic
   `span.model_request_end{is_error:true}`. Hard delete is the exception
   because the session event log is removed.
10. `docs/scope.md`, `docs/roadmap.md`, and the event-topology tracker are
    updated so the supported/deferred event matrix matches code.

## Tests

Unit:

- Translator/normalizer fixture test for simple assistant span pair.
- Fixture test for tool-call turn with two span pairs.
- Fixture test that `responseId` is absent on `message_start` and positional
  correlation still closes the right span.
- Fixture test that terminalization/recovery closes an unmatched start with
  `is_error: true`, zero usage, and ordering before terminal rows.
- Fixture test that archive emits synthetic span ends before
  `session.status_terminated`.
- Fixture test that hard delete closes runtime turns and deletes event rows
  without trying to preserve synthetic span history.

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

Mitigation: probe first; only publish usage observed on `message_end` or
equivalent terminal events. For synthetic terminalization closes, use explicit
zero usage and `is_error: true`; otherwise do not emit a hosted-shaped span end
without required `model_usage` unless the divergence is named.

### Risk: Start/end correlation breaks on concurrent turns

Mitigation: key span state by `(workspaceId, sessionId, runtime turn)` plus a
single open assistant model-request slot. Add a test with multiple sequential
model requests in one session. If a future Pi SDK probe finds interleaved
assistant model requests, revise this plan before implementation.

### Risk: Durable open-span state drifts from the event log

Mitigation: update the open-span list only in the same
`appendBatchWithRuntimeChanges` transaction that appends the corresponding span
events. Do not update the list out-of-band. Add rollback tests around start,
normal end, and synthetic terminalization batches.

### Risk: Span events reorder transcript events

Mitigation: emit span events from the same runtime queue and match hosted
ordering: start span, transcript event, end span for the same model response.
Assert exact order in tests.

### Risk: Hosted payload shape differs from our guessed payload

Mitigation: before implementation, check local CMA docs/API samples and update
this plan if they provide exact fields. Do not encode screenshots alone as a
wire contract.

## Open Questions Before Code

1. Does Pi emit model-error terminal metadata that can produce a matching
   `span.model_request_end{is_error:true}`?
2. What exact event shape does hosted Managed Agents emit on a model request
   error?
3. Should `agent.message` also carry usage, or should usage live only on spans
   and session summaries?

## Review Checklist

- The plan does not claim memory or hosted UI parity.
- Span event shapes are open enough to avoid fake precision, but specific
  enough for UI timeline work.
- Every new emitted event remains append-only and replayable.
- The implementation starts with a Pi/API probe rather than stale fixture
  inference.
- Tests prove both no-tool and tool-using turns.
