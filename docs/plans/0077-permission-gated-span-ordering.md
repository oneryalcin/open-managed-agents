# Plan 0077: Permission-Gated Sandbox Span Ordering

## Context

Issue `#77` tracks Managed Agents event-topology parity. After model request
spans landed, one trace-fidelity gap remains in the ask-gated sandboxed builtin
tool path.

Current path:

- `PiSessionRunner.runUserMessage` subscribes to Pi events and maintains
  `gatedEvents` plus `activeSandboxedToolCalls` while sandboxed builtin tool
  calls are in flight (`src/control-plane/sessions/pi/runner.ts:300-305`).
- When a Pi `message_end` contains a sandboxed builtin tool call,
  `sandboxedToolCallsInMessage(...)` detects it and the runner stores the
  `message_end` in `gatedEvents` instead of yielding it immediately
  (`src/control-plane/sessions/pi/runner.ts:371-380`).
- Tool execution start/end events are also gated until all active sandboxed
  tool calls drain (`src/control-plane/sessions/pi/runner.ts:383-421`).
- Internal runtime events bypass the gate and are yielded immediately
  (`src/control-plane/sessions/pi/runner.ts:366-369`).
- `DefaultSessionEventsService` persists `oma.tool_permission_use` immediately
  by calling `persistToolPermissionUse(...)`
  (`src/control-plane/events/service.ts:1102-1124`).
- `persistToolPermissionUse(...)` materializes public `agent.tool_use` with
  `evaluated_permission` and opens a `tool_confirmation` pending action for
  `evaluatedPermission === "ask"`
  (`src/control-plane/events/service.ts:1548-1627`).
- Model request spans are emitted around non-internal Pi message events:
  `span.model_request_start`, transcript event(s), then
  `span.model_request_end` (`src/control-plane/events/service.ts:1125-1156`).

That means the ask-gated sandboxed builtin path can publish:

```text
span.model_request_start
agent.tool_use                 # from immediate oma.tool_permission_use
session.status_idle(requires_action)
... human confirmation wait ...
span.model_request_end          # delayed until gated Pi message_end is released
```

The durable span ledger remains correct, but a trace consumer sees the
permission event and the whole confirmation wait inside an open model request
span. Hosted probes for normal tool calls showed `agent.tool_use` immediately
before the matching `span.model_request_end`; the ask-gated sandboxed builtin
path has not been separately hosted-probed, so this plan treats that ordering as
an inferred parity target rather than a measured hosted-gated sample.

## Requirements Summary

1. Preserve the existing permission-confirmation semantics:
   - `agent.tool_use` must still be emitted before
     `session.status_idle{stop_reason:{type:"requires_action"}}`.
   - `user.tool_confirmation` must still resolve the same public `agent.tool_use`
     ID.
   - pending action ownership, turn pausing, replay, and terminalization
     behavior must not regress.
2. Keep model span events coherent:
   - for ask-gated sandboxed builtin tools, public order should be
     `span.model_request_start -> agent.tool_use -> span.model_request_end ->
     session.status_idle(requires_action)`.
   - `agent.tool_use` should not appear before the `span.model_request_start`
     that represents the model request that selected the tool.
3. Keep the runner/service boundary legible. Do not hide runtime ownership or
   pending-action semantics behind a broad abstraction.
4. Do not add event names or public fields. This is ordering/fidelity work, not
   a schema expansion.

## Non-Goals

- Do not implement MCP events, thread events, outcomes, memory, or `session.updated`.
- Do not change non-permissioned builtin tool ordering.
- Do not change custom-tool `agent.custom_tool_use` semantics.
- Do not try to make every permission path bit-exact with hosted UI timing.
- Do not refactor all terminalization helpers unless the implementation forces
  it; that cleanup can remain separate.

## Design Principles

- **Persist-before-publish stays untouched.** Any emitted rows still go through
  the existing append-and-broadcast path.
- **One public tool-use event per permission wait.** The fix must not create a
  duplicate `agent.tool_use` for the same Pi tool call.
- **The bridge owns permission waits.** `DefaultSessionEventsService` should
  remain responsible for opening pending `tool_confirmation` actions.
- **Small, typed boundary.** If the runner needs to delay an internal permission
  event, encode that with a clear runtime event shape or helper, not ad hoc
  queue peeking in the service.

## Options Considered

### Option A: Gate `oma.tool_permission_use` inside `PiSessionRunner`

When the runner detects that a sandboxed builtin tool call is active, hold the
internal `oma.tool_permission_use` together with the gated Pi `message_end`.
Release it only when the gated batch is flushed.

Pros:

- Fixes ordering at the source; the service can stay a single ordered consumer.
- Keeps `agent.tool_use` emitted from the existing `persistToolPermissionUse`
  path, preserving pending-action semantics.
- Avoids inventing delayed service-side buffering.

Cons:

- Needs careful handling so an ask-gated permission event still reaches the
  service before the service needs to emit `requires_action`.
- A naive implementation can deadlock if it gates the permission event until
  after the confirmation result, because the API caller never sees the public
  `agent.tool_use` ID.

Verdict: viable only if the runner can release the permission event after the
Pi `message_end` that closes the model request is processed, but before waiting
for user confirmation. The current runner gates `message_end` until tool
execution end, so this option likely requires a more invasive split of "model
selection gating" from "tool execution gating."

### Option B: Teach the service to flush the open model span before persisting permission waits

When `DefaultSessionEventsService` receives `oma.tool_permission_use` while a
model request span is open, persist a synthetic or reordered
`span.model_request_end` before the public `agent.tool_use`.

Pros:

- Localizes the fix in the service, where span ledger state already lives.
- Avoids runner queue changes.

Cons:

- Wrong contract: span end payload needs model usage from Pi `message_end`.
  `oma.tool_permission_use` does not carry that usage.
- Would either invent zero usage for a non-error model request or require
  delayed mutation, both violating the span contract.

Verdict: reject. It would improve ordering by damaging span payload fidelity.

### Option C: Move model usage forward to the permission wait

Keep `oma.tool_permission_use` internal to the runner, but do not let the
service process it as an unrelated event ahead of the containing
`message_end`. Instead, when a sandboxed builtin permission event is produced
for a tool call whose containing `message_end` is currently gated, the runner
should hand the service one typed "permission with model end" unit, or an
equivalent adjacent pair that the service handles as one ordered append.

The important boundary is not merely yielding two events next to each other.
If the service sees raw `message_end` first, its existing normal path will emit
`span.model_request_end` before `agent.tool_use`. The implementation therefore
needs a typed service path that has both:

- the real Pi `message_end`, so the span end can use real model usage
- the `oma.tool_permission_use`, so pending confirmation creation remains in
  the existing permission bridge

```text
message_start
oma.sandbox_tool_permission_with_model_end {
  messageEnd,
  permissionUse
}
```

The service then materializes and persists one ordered batch equivalent to:

```text
span.model_request_start
agent.tool_use
span.model_request_end
session.status_idle(requires_action)
```

Pros:

- Preserves real Pi usage from `message_end`.
- Keeps pending action creation in `persistToolPermissionUse`.
- Makes the ordering fix explicit at a typed runner/service boundary.
- Avoids delaying `agent.tool_use` until after user confirmation; the public
  tool-use ID is still emitted before `requires_action`.

Cons:

- Requires the runner to associate a permission event with a Pi tool-call
  `message_end`.
- Requires a small service helper so permission materialization and span-end
  materialization can share one append transaction and one public ordering.
- Needs tests for allow/ask/deny and multi-tool cases so permission events do
  not drift, duplicate, or block confirmation.

Verdict: preferred direction if source inspection shows the runner can bind the
permission event to a tool call before yielding it. It keeps the event stream
ordered without weakening span payloads. If implementation shows a composite
event is too large a boundary, the alternative is an equivalent internal helper
that yields a strongly typed adjacent pair and prevents the raw `message_end`
path from closing the span before the permission row.

This is deliberately **not** "delay the permission event until the gated batch
flushes." That deadlocks ask-gated flows because `publishToolUse(...)` waits for
the public `agent.tool_use` ID before the tool wrapper can wait for user
confirmation or execute the tool. The design is "move the model-end usage
forward" by consuming the matching gated `message_end` at permission time, while
leaving later tool execution events gated as they are today.

## Proposed Implementation Shape

1. Add a focused failing integration test in
   `src/control-plane/__tests__/tool-confirmation-api.test.ts`.
   - Use a fake runner or existing permission runner variant that emits
     `message_start`, a tool-call `message_end` with model usage, and an
     ask-gated `oma.tool_permission_use`.
   - Assert final public order:

     ```text
     user.message
     session.status_running
     span.model_request_start
     agent.tool_use
     span.model_request_end
     session.status_idle
     ```

   - Assert the `span.model_request_end.model_request_start_id` points to the
     preceding start ID.
   - Assert `agent.tool_use.evaluated_permission === "ask"`.
   - Assert `session.status_idle.stop_reason.event_ids` contains the
     `agent.tool_use.id`.

2. Inspect the current `PiSessionRunner` permission bridge event flow.
   - If `oma.tool_permission_use` is emitted from the sandbox permission bridge
     before the gated `message_end`, introduce a small typed queue keyed by
     `piToolCallId`.
   - Hold permission events for tool calls whose containing model `message_end`
     is gated only until the containing `message_end` is available. In the
     common current path, the `message_end` is already in `gatedEvents` when the
     sandbox tool wrapper asks for permission; consume that matching
     `message_end` immediately for the composite event instead of waiting for
     `tool_execution_end`.
   - Once the matching `message_end` is consumed into the composite event,
     remove it from the normal gated queue so it cannot be emitted again later.
     Tool execution start/end events can remain gated by the existing
     `activeSandboxedToolCalls` logic.
   - Do not wait for tool execution end or user confirmation before making the
     public `agent.tool_use` visible. The bridge's `publishToolUse(...)` waits
     for `bindToolUseId(...)`, so over-gating here can deadlock the ask path.
   - Yield a typed composite event, or equivalent typed adjacent pair, that
     gives the service both the gated `message_end` and the permission event.
     Do not let the service process the raw `message_end` first through the
     normal span path.

3. Add a narrow service helper for the composite path if needed.
   - Reuse the permission materialization logic from
     `persistToolPermissionUse(...)`; do not duplicate public event payload
     construction or pending-action binding rules.
   - Materialize the ordered batch as `agent.tool_use` followed by the matching
     `span.model_request_end` from the associated `message_end`.
   - Persist `agent.tool_use`, `span.model_request_end`, span-close ledger
     updates, turn state changes, and pending-action changes in one ordered
     append/runtime-change transaction. This is the load-bearing invariant: a
     crash must not leave a public permission wait without the matching span
     close, or vice versa.
   - Runtime turn state should still move to `paused` for ask-gated events.
   - `flushPendingActions(...)` should continue to synthesize
     `session.status_idle(requires_action)`.

4. Add regression coverage for at least one non-ask path.
   - Allow/deny permission paths should not deadlock or duplicate events.
   - If the existing tests already cover this after the runner change, no new
     test is needed beyond preserving them.

5. Update `docs/references/managed-agents-event-topology.md`.
   - Move the permission-gated sandbox span-ordering note from "known hardening
     gap" to "fixed", or remove it and cite the regression test.

## Acceptance Criteria

1. Ask-gated sandboxed builtin tools produce public order:

   ```text
   span.model_request_start
   agent.tool_use
   span.model_request_end
   session.status_idle(requires_action)
   ```

2. The public `agent.tool_use.id` remains the ID accepted by
   `user.tool_confirmation.tool_use_id`.
3. The matching `span.model_request_end` uses real Pi model usage from
   `message_end`, not synthetic zero usage.
4. No duplicate `agent.tool_use` or duplicate pending `tool_confirmation`
   action is created for one Pi tool call.
5. Existing tool-confirmation tests continue to pass.
6. Existing custom-tool tests continue to pass.
7. The event-topology reference no longer lists this as an open hardening gap.

## Verification Plan

Run:

```bash
npx vitest run src/control-plane/__tests__/tool-confirmation-api.test.ts
npx vitest run src/control-plane/__tests__/custom-tools-api.test.ts
npx vitest run src/control-plane/__tests__/runtime-events-api.test.ts
npm run typecheck
```

If the implementation touches runner event ordering more broadly, also run the
full suite:

```bash
npx vitest run
```

## Risks and Mitigations

- **Deadlock risk:** gating `oma.tool_permission_use` too long could prevent
  the API caller from receiving the public `agent.tool_use` ID needed to confirm.
  Mitigation: test that `session.status_idle(requires_action)` appears before
  submitting `user.tool_confirmation`.
- **Duplicate event risk:** releasing a queued permission event and the original
  internal event could both persist `agent.tool_use`. Mitigation: keyed pending
  permission queue with consume-on-release semantics, plus event-count asserts.
- **Span payload regression:** closing spans before Pi `message_end` would lose
  real usage. Mitigation: assert non-zero usage in the ordering regression test.
- **Boundary drift:** pushing span logic into `PiSessionRunner` would mix
  public event concerns into the runner. Mitigation: runner should only order Pi
  and internal runtime events; span materialization stays in the service.

## ADR

### Decision

Fix permission-gated sandbox span ordering at the runtime event ordering
boundary, preferring a runner-side association between gated Pi tool-call
`message_end` events and their corresponding `oma.tool_permission_use` internal
events.

### Drivers

- Preserve hosted-like trace ordering.
- Preserve real model usage on `span.model_request_end`.
- Avoid duplicating pending-action semantics outside
  `persistToolPermissionUse(...)`.

### Alternatives Considered

- Gate all permission events until tool execution ends: rejected because it can
  deadlock ask-gated flows.
- Service-side synthetic span close before permission event: rejected because it
  loses real usage and makes a successful model request look synthetic.

### Consequences

- `PiSessionRunner` may need a small keyed queue for pending permission internal
  events.
- The service remains the owner of public event persistence and pending action
  creation.
- The event topology tracker becomes more precise for trace/UI consumers.

### Follow-Ups

- If the implementation reveals broader coupling in the runner gate, consider a
  separate simplifier PR that names the gated-event phases explicitly.
- UI trace work should consume the corrected order and derive span durations
  from `processed_at` pairs.
