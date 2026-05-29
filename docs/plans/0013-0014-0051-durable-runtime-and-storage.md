# Plan: Durable Runtime Waits and Snapshot Cleanup

Issues:

- [#14](https://github.com/oneryalcin/open-managed-agents/issues/14)
- [#51](https://github.com/oneryalcin/open-managed-agents/issues/51)
- Narrow duplicate-safe `user.custom_tool_result` retries related to
  [#13](https://github.com/oneryalcin/open-managed-agents/issues/13), but not
  full #13 request-level idempotency.

## Goal

Move the next durability boundary from "single process, in-memory wait maps are
acceptable" to "failure modes are explicit and retryable":

1. make duplicate `user.custom_tool_result` submissions safe and
   contractually pinned;
2. make pending custom-tool waits and builtin confirmations fail explicitly
   across restart/handoff instead of staying silently dead;
3. make internal file snapshot cleanup retryable before any durable
   `FileStorage` backend exists.

This plan intentionally groups the three issues because they share the same
architectural question: OMA has two stores/process boundaries today, and the
current in-memory shortcuts are correct only for the single-process MVP.

## Evidence

### Pi SDK: no resumable pending-tool primitive

Checked first, per project rule:

```bash
node -p 'require("./node_modules/@earendil-works/pi-coding-agent/package.json").version'
gh api repos/earendil-works/pi/contents/packages/coding-agent/docs/sdk.md \
  --jq .content | base64 --decode | rg -n "customTools|execute|AbortSignal|abort|clearQueue|followUp|steer"
rg -n "class AgentSession|customTools|execute\\(|AbortSignal|clearQueue|abort\\(" \
  node_modules/@earendil-works/pi-coding-agent/dist -g '*.d.ts' -g '*.js'
```

Facts:

- Installed Pi package is `@earendil-works/pi-coding-agent@0.75.4`.
- SDK custom tools are still async `execute(toolCallId, params, signal, ...)`
  functions passed through `customTools`.
- `AgentSession.abort()` remains `abortRetry(); agent.abort(); await
  agent.waitForIdle();`.
- `clearQueue()`, `followUp()`, and `steer()` exist for queue management.
- There is no public API to take a persisted `agent.custom_tool_use` ID and
  inject a result into a freshly-created `AgentSession` after the original
  process/Pi Promise is gone.

Conclusion: #14 cannot honestly implement "recover and resume the same Pi
turn" with the current SDK. The valid v1 choices are:

- keep sticky process ownership while a tool wait is pending; or
- explicitly fail/terminalize orphaned waits after restart/handoff.

### Current OMA custom-tool model

ADR 0005 and ADR 0011 are still accurate:

- `PiCustomToolBridge` emits an internal `oma.custom_tool_use`, then returns a
  Promise that Pi awaits.
- `DefaultSessionEventsService` materializes that as public
  `agent.custom_tool_use` with a server `sevt_*` ID.
- Clients answer with `user.custom_tool_result.custom_tool_use_id = sevt_*`.
- The bridge's process-local map resolves the Pi Promise.
- The same public-ID model now also exists for builtin confirmations:
  `agent.tool_use.id = sevt_*`, answered by `user.tool_confirmation.tool_use_id`.

The unresolved state is partly durable in the event log, but the only handle
that can resume the Pi turn is process-local.

### Hosted duplicate-result probe

Probe:

```bash
set -a
. /Users/mehmetoneryalcin/dev/junk/cwc-workshops/ship-your-first-managed-agent/.env
set +a
uv run --with anthropic python scratch/33-managed-agents-custom-tool-idempotency-probe.py \
  | tee scratch/artifacts/33-managed-agents-custom-tool-idempotency-probe-output.txt
```

Findings:

- Hosted accepts a duplicate `user.custom_tool_result` for the same
  `agent.custom_tool_use`.
- The duplicate is persisted as a second distinct `user.custom_tool_result`
  event.
- Repeating the same request with the same `Idempotency-Key` header still
  produced a fresh event; the header did not replay/dedupe the first response.
- The extended probe waits for `agent.message` plus final
  `session.status_idle{stop_reason:{type:"end_turn"}}` before submitting the
  duplicate, so the duplicate behavior is not just an in-flight continuation
  race.
- After submitting the stale duplicate, the probe uses event `processed_at`
  timestamps, not list order, to wait for later lifecycle events. The captured
  hosted run emits another `session.status_idle(end_turn)` after the duplicate
  in both no-key and same-key cases.
- The runtime side effect is still single-resolution: the duplicate is not a
  second custom-tool execution. Hosted emits additional lifecycle noise after a
  stale duplicate, but the probe does not establish a useful idempotency-key
  contract. OMA should keep the safer v1 invariant: append the duplicate user
  row, never resolve the runtime twice, and avoid synthesizing model-authored
  content.

Important correction to #13: the issue body asks for "request-level
idempotency". Hosted behavior is not request-level idempotency. We should not
invent a non-hosted idempotency-key contract and call it parity. The custom-tool
contract pinned here is narrower: duplicate result rows may be accepted, but the
runtime wait must resolve at most once. That does **not** close full
request-level idempotency for `events.send` batches such as duplicated
`user.message`; either keep #13 open for request-level retry safety or split this
work into a new "duplicate-safe custom-tool results" issue.

### Snapshot cleanup hazard

Current hard delete:

1. reads `session_file_mount_snapshots`;
2. synchronously deletes snapshot metadata/resource/session rows;
3. best-effort deletes internal snapshot bytes;
4. swallows byte-delete failure.

For `InMemoryFileStorage` this is harmless because internal snapshot delete is
a synchronous map delete. For any durable backend it loses the only durable
mapping needed to retry a failed byte delete.

Naive reordering is not enough: deleting bytes first and then failing the
metadata transaction strands a session that references missing bytes. This
needs a retryable ledger, not just a reordered call.

## Design

### A. Do not close #13 here; add duplicate-safe custom-tool results

Add durable duplicate handling for `user.custom_tool_result` similar in spirit
to the builtin confirmation replay path, but with the conservative part of the
hosted semantics:

1. Before claiming an in-memory runtime callback, inspect the durable
   `pending_runtime_actions` row and prior accepted `user.custom_tool_result`
   rows for the requested `custom_tool_use_id`. Duplicate classification must
   happen before persistence and before resolving any Pi Promise; the live
   runtime path is not allowed to bypass duplicate checks.
2. Within one submitted batch, reject ambiguous duplicates before persistence:
   multiple `user.custom_tool_result` rows for the same `custom_tool_use_id` with
   different content fail the whole request; identical same-batch duplicates are
   collapsed to one runtime acknowledgement plus, if hosted-compatible row echo
   parity is desired, duplicate persisted user rows that are explicitly marked as
   duplicates and never resolve the runtime twice.
3. If there is no matching `agent.custom_tool_use`, return the existing 404
   `No pending custom tool call: <id>`.
4. If there is a matching `agent.custom_tool_use` and at least one prior
   `user.custom_tool_result` for that ID, compare the submitted result to the
   already accepted result. Different content is rejected before persistence.
   Identical retries then branch on the durable turn state:
   - If the action's `turn_id` has a `completed` or `terminalized`
     `pending_runtime_turns` row, classify it as a stale duplicate:
     - accept and persist the duplicate user row;
     - do not call the runtime;
     - do not emit an extra OMA `session.status_running` in v1;
     - return the newly persisted row in the send response.
   - If the turn is still live/acknowledged under the current owner lease, this
     is an in-flight retry: accept and persist the duplicate user row, but do
     not resolve the Pi Promise a second time and do not terminalize. The original
     runtime continuation remains responsible for completion.
   - If the turn is live under a different valid owner lease, return the
     wrong-owner retryable 409/503 contract without appending a row.
   - If the lease is expired/abandoned and no local runtime can continue, use the
     orphaned-turn terminalization path.
   Do **not** infer completion solely from event ordering or from a later
   uncorrelated `session.status_idle(end_turn)`; current event rows do not carry
   enough durable turn correlation to make that safe.
   If the submitted content differs from the prior accepted result, reject with a
   caller-safe conflict/invalid-request error and do not append a contradictory
   user row until a hosted probe proves different-content duplicates are accepted.
5. If there is a matching `agent.custom_tool_use`, no prior accepted result, and
   the current process owns the live pending runtime callback, atomically mark the
   action `acknowledged` / `runtime_resolution_committed` (or equivalent) in the
   EventStore before resolving the Pi Promise. Only the transition from
   `pending -> acknowledged` is allowed to receive the runtime commit; concurrent
   duplicates observe `acknowledged` and follow the in-flight retry branch without
   resolving the runtime again.
6. If there is a matching `agent.custom_tool_use` but no runtime pending call
   and no durable evidence that the turn completed after the result, this is
   #14's orphaned-turn case, not a harmless duplicate. Follow the #14
   terminalization contract below. This includes the crash window where a prior
   `user.custom_tool_result` was persisted but the runtime never consumed it.

Do not add `Idempotency-Key` support in this PR unless a later hosted probe
shows a supported header contract. The current probe shows the opposite.

This intentionally does not try to mimic every hosted lifecycle event around
stale duplicates. The compatibility property that matters for #13 is narrower
and safer: duplicate submissions do not 404 once the first result is accepted,
but identical retries also do not resolve or execute the tool twice. Different
content for the same completed `custom_tool_use_id` is explicitly out of scope
for v1 unless a later probe proves hosted behavior.

Tests:

- duplicate custom-tool result after first result succeeds: second `send`
  returns 200, persists a second user row, and does not call the runtime a
  second time;
- in-flight identical retry after the first user row was persisted but before
  turn completion, with the current process still owning the live lease: accepts
  and persists the duplicate row, does not resolve the runtime twice, and does
  not terminalize;
- live pending runtime callback plus prior accepted row: duplicate
  classification runs before the in-memory claim/commit path, so a different
  second result is rejected before persistence and the Pi Promise is not resolved
  with contradictory content;
- same in-flight retry on a wrong-owner process with another valid owner lease:
  returns the retryable wrong-owner contract without appending a row;
- duplicate custom-tool result after the first user row was persisted but before
  completion, with an expired/abandoned lease and no local runtime, does **not**
  use the stale-duplicate fast path; it must claim/terminalize the orphaned turn
  or return a retryable owner/lease error without appending a new row;
- duplicate with different content is rejected before persistence, because probe
  33 only proves identical-result duplicates and OMA should not create
  contradictory tool-result history on inference;
- unknown ID stays 404;
- same-batch duplicate for one `custom_tool_use_id` is rejected or explicitly
  ordered before persistence; if accepted as duplicate rows, only one row can
  transition the action to `acknowledged` and resolve the runtime.

### B. Resolve #14 by terminalizing orphaned waits explicitly

Because Pi cannot resume a lost Promise, v1 should fail orphaned waits
explicitly rather than pretending recovery exists.

However, recovery must never terminalize waits still owned by a live process,
and a turn with multiple paused actions must have exactly one authoritative
owner and one terminalization outcome. Before any automatic startup/handoff scan
exists, add a durable owner/lease contract at the **turn** level, with actions as
children of that turn:

Turn identity contract:

- Mint exactly one opaque internal `turn_id` when OMA accepts a
  runtime-starting `user.message`, in the same persistence transaction as that
  user event. Do this before acknowledging the send response and before the
  asynchronous `runRuntimePrompts` / equivalent prompt dispatch can start.
- The `turn_id` is not inferred from public event ordering. It is carried in an
  internal `RuntimeTurnContext` through Pi runner callbacks, custom-tool bridge
  `execute(...)` Promises, builtin tool-permission gating, runtime draft event
  translation, user-result/confirmation commit callbacks, and completion/error
  handling.
- Every `agent.custom_tool_use`, ask-gated `agent.tool_use`, corresponding
  pending action row, runtime-derived output, completion, and terminalization for
  that prompt uses the same `turn_id`.
- Parallel custom tools and mixed custom-tool plus builtin confirmation waits in
  one model turn must share one `turn_id`; never mint one turn per action.
- Follow-up or later user messages get new `turn_id` values. The existing
  prompt/followUp race logic must attach the correct turn context to each queued
  prompt before any runtime side effect is emitted.
- The internal turn id may be stored as private event metadata or only in the
  pending-runtime tables, but duplicate classification, recovery, and fencing
  must use this minted token. Public event shapes do not need to expose it.
- Each accepted runtime-starting turn must also durably identify the triggering
  user event row(s). Do not recover by scanning "the latest user.message" or by
  event ordering. Preferred shape: store `trigger_event_ids` on
  `pending_runtime_turns` in the same transaction that appends the accepted
  `user.message` event(s). An equivalent private `turn_id` metadata field on the
  event row is acceptable only if accepted-turn recovery can load the prompt by a
  stable event id / turn id lookup without inference.

```sql
CREATE TABLE IF NOT EXISTS pending_runtime_turns (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  lease_expires_at TEXT NOT NULL,
  state TEXT NOT NULL, -- accepted | dispatching | running | paused | terminalizing | terminalized | completed
  trigger_event_ids TEXT NOT NULL, -- JSON array of runtime-starting user event ids
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  terminalized_at TEXT,
  PRIMARY KEY (workspace_id, session_id, turn_id)
);
```

```sql
CREATE TABLE IF NOT EXISTS pending_runtime_actions (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  state TEXT NOT NULL, -- pending | acknowledged | closed
  acknowledged_at TEXT,
  closed_at TEXT,
  close_reason TEXT, -- completed | terminalized | interrupted | archived | deleted | timeout
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, session_id, action_id),
  FOREIGN KEY (workspace_id, session_id, turn_id)
    REFERENCES pending_runtime_turns(workspace_id, session_id, turn_id)
);
```

Storage boundary requirement:

- EventStore must become workspace-aware before delete fencing is implemented.
  Current event rows/API are keyed by `session_id` only; that is not enough for
  an in-transaction `(workspace_id, session_id)` fence check. Add
  `workspace_id` to persisted event rows, backfill it from the session store (or
  fail migration if a row cannot be mapped), and require `workspaceId` on
  EventStore append/appendBatch/list/retrieve/delete APIs. User-event writes,
  runtime-derived writes, stream/list reads, and cleanup paths must pass
  `workspaceId` from the route/runtime context rather than doing an out-of-band
  session-store lookup inside an append transaction.
- `pending_runtime_turns`, `pending_runtime_actions`, and the event-log append
  must share one atomic write boundary. Preferred implementation: colocate the
  pending-runtime tables in `EventStore` and expose a unit-of-work method that
  appends events and mutates pending-runtime state inside the same synchronous
  SQLite transaction.
- Do not split pending-runtime ownership state into `SqliteSessionStore` while
  event history lives in `EventStore` unless a new store abstraction provides an
  equivalent single transaction across both. The current separate
  `DatabaseSync` stores do not provide that guarantee.
- Every transition that makes runtime state visible in the event log must update
  the pending turn/action rows in that same unit of work: creating a paused
  action, acknowledging user input, writing runtime output, marking a turn
  completed, and terminalizing an orphaned turn.
- Accepting a runtime-starting `user.message` is also a runtime-state transition:
  it must append the user event and create the `pending_runtime_turns` row with
  `state='accepted'` plus `trigger_event_ids` in the same unit of work. A crash
  after the send response but before prompt dispatch is then recoverable by
  loading the exact persisted event payload by id.
- Before invoking Pi or any runtime side effect, transition the turn from
  `accepted` to `dispatching` in its own committed/fenced store update. Only
  after that commit may the process call Pi. Transition to `running` with the
  first runtime output/status write. This is the barrier that distinguishes
  "safe to restart because dispatch never began" from "runtime side effects may
  already exist; do not restart blindly."

Rules:

- When a runtime-starting `user.message` is accepted, create one
  `pending_runtime_turns` row for its `turn_id` with the live owner's
  `owner_id`, `owner_generation`, `state='accepted'`, and lease. Runtime dispatch
  first transitions that row to `dispatching`, first runtime output transitions
  it to `running`, and paused tool waits transition it to `paused`. The turn row,
  not each action row, is the fencing authority.
- Lease timing is part of the contract, not an implementation detail:
  - use store/database time for lease comparisons and renewal writes, not
    independent process wall clocks;
  - default lease TTL: 120 seconds;
  - default renewal cadence: every 30 seconds for the entire lifetime of a live
    turn, including `paused` / awaiting-user-input states where no runtime output
    is being produced, and before any user-result commit after a long wait;
  - recovery may claim a turn only after `lease_expires_at` is at least one
    renewal period in the past according to store time, giving normal event-loop
    stalls/GC pauses a grace window;
  - if the live owner cannot renew before writing, or renewal discovers a stale
    generation, the owner must fail closed: stop accepting/committing user input
    for that turn, stop runtime-derived writes, and abort/close best-effort.
- When `agent.custom_tool_use` or ask-gated `agent.tool_use` is persisted,
  insert a pending-runtime-action row in the same synchronous persistence
  boundary.
- The process that owns the live Pi turn has a stable `owner_id` and renews the
  turn lease while it can still produce model/runtime output for that turn.
- Every turn claim or lease renewal atomically increments or verifies
  `owner_generation`. Treat `(turn_id, owner_id, owner_generation)` as the
  fencing token.
- Every runtime-derived persistence path that can write model output,
  `agent.tool_result`, `session.status_*`, or commit a user result must assert
  the current turn fencing token before writing. If the token is stale, the old
  runner must stop writing and be aborted/closed best-effort.
- `user.custom_tool_result` and `user.tool_confirmation` do **not** delete the
  pending action row merely because the user input was accepted. Mark
  `acknowledged_at` if useful, but keep the action row until the runtime-derived
  result/continuation is durably written or the turn is terminalized. Otherwise a
  crash after user acceptance but before model continuation has no recovery row.
- Interrupt, archive, delete, timeout, and successful runtime completion close
  the whole turn: update the turn row to `terminalized` or `completed` and mark
  child action rows `state='closed'` with a `close_reason` in the same guarded
  persistence boundary that writes the terminal lifecycle events.
- Do not immediately delete closed child action rows. They are the durable
  `action_id -> turn_id` index needed to prove that later duplicate
  `user.custom_tool_result` submissions are stale duplicates, not crash-window
  orphans. A future compaction can remove old closed rows only if it preserves an
  equivalent action-to-turn/outcome index for duplicate classification.
- A recovery process may terminalize only a `pending_runtime_turns` row whose
  lease has expired, or a turn it already owns and has explicitly decided to
  abandon.
- No process may scan incomplete event history and terminalize rows without
  first acquiring the corresponding durable turn lease.

Define an incomplete runtime action as a child action row whose turn is not
`completed` or `terminalized` yet:

- `agent.custom_tool_use`, whether still waiting for the first
  `user.custom_tool_result` or already acknowledged via `acknowledged_at`, until
  the runtime continuation or terminalization completes the turn;
- `agent.tool_use` with `evaluated_permission: "ask"`, whether still waiting for
  `user.tool_confirmation` or already acknowledged via `acknowledged_at`, until
  the runtime writes the corresponding `agent.tool_result` or terminalization
  completes the turn.

User input rows acknowledge an action; they are not proof that the runtime
consumed the input or completed the turn.

When one or more `user.custom_tool_result` / `user.tool_confirmation` entries
arrive for incomplete actions in the same turn but the runtime runner has no
pending commit:

1. atomically claim the expired/abandoned `turn_id` in `pending_runtime_turns`;
2. if another live owner still holds the lease, return a caller-safe retryable
   error **without** persisting the submitted user row;
3. group the submitted batch by `turn_id`, then validate **every** turn-group
   before writing anything. A request that contains multiple abandoned turn
   groups is all-or-nothing at the `events.send` request boundary: if any group
   is invalid, stale, owned by a live runner, or would require a retryable
   conflict, reject the whole request before persisting any user row or terminal
   lifecycle event;
4. once every group is validated and every needed turn claim is held, persist
   all acceptable acknowledgements, mark/clear all affected pending runtime
   actions, append one terminal lifecycle sequence per terminalized turn, and
   mark those turns `terminalized` in one EventStore unit-of-work. If the
   EventStore cannot make the multi-turn write atomic, reject multi-turn
   abandoned retry batches as unsupported rather than partially committing one
   turn-group and failing another;
5. do not partially accept one sibling action and reject/drop another sibling
   from the same submitted batch;
6. do not call the runtime.

For builtin confirmations, the existing #15/#38 terminalization path is close:
accepted persisted confirmation with no runtime pending appends an
`agent.tool_result` error plus `session.status_idle(end_turn)`. Keep that shape
and make the custom-tool path equally explicit.

Custom-tool terminalization needs a wire shape decision because there is no
`agent.custom_tool_result` event type in OMA's current subset. Preferred v1:

- append `session.error` with a caller-safe message such as
  `Custom tool result <id> was accepted, but runtime state is no longer available and the custom tool execution outcome is unknown.`;
- append `session.status_idle` with `stop_reason: { type: "end_turn" }`.

Do not synthesize an `agent.message`; that would imply model authorship.
Do not synthesize `agent.tool_result`; custom tools are intentionally filtered
from `agent.tool_result` translation today.

Whole-turn rule: once runtime state is lost, the entire paused turn is
unrecoverable. OMA must not terminalize one custom-tool wait while leaving
sibling custom-tool waits or builtin confirmations pending for the same turn.
The terminalization sequence is per turn and is guarded by the single
`pending_runtime_turns` fencing token. Later retries for sibling action IDs
should see the `terminalized` turn row and must not append another terminal
sequence.

Post-terminalized action behavior:

- If a later `user.custom_tool_result` targets the same action that already has
  an accepted identical result in a `terminalized` turn, accept it as an
  identical stale retry, persist the duplicate row, and do not append another
  terminal sequence.
- If a later `user.custom_tool_result` targets a sibling action in that
  terminalized turn that never had an accepted result, reject with a caller-safe
  conflict/invalid-request error and do not append a user row. The turn is
  already over and the runtime cannot consume the result.
- If the later result content differs from any already accepted result for that
  action, reject before persistence as above.
- Builtin confirmation siblings follow the same principle: once the turn is
  terminalized, late confirmations for not-yet-acknowledged sibling tool uses are
  rejected and do not create a second terminalization sequence.

Legacy/pre-ledger data strategy:

- Before this ships in any deployment with persisted event history, run a startup
  reconciliation step for sessions that already have `requires_action` history
  but no `pending_runtime_turns` row because they were created before the ledger
  existed.
- Preferred behavior: create a migration-owned turn row such as
  `turn_id = legacy:<requires_action_event_id>` plus child action rows for the
  `stop_reason.event_ids`, immediately claim that synthetic turn, and
  terminalize it with the same `session.error + session.status_idle(end_turn)`
  shape. This is honest: Pi cannot resume the old Promise.
- If a deployment can prove there are no persisted paused sessions (for example
  in the current local/in-memory zero-user setup), document that as a deployment
  precondition. Do not silently fall back to event-order inference.
- `events.send` for a legacy paused session with no turn row must either run the
  same reconciliation/terminalization path or return a retryable/startup
  reconciliation error; it must not append accepted result rows before a turn
  claim exists.

Recovery entry points:

- `events.send` must terminalize when a result/confirmation arrives after
  restart/handoff and the matching runtime Promise is gone, but only after it
  owns the expired/abandoned `pending_runtime_turns` row. If another live owner
  still holds the turn lease, return a caller-safe retryable error without
  appending the user row or terminal events.
- Durable/multi-process deployments require sticky session routing by
  `session_id` (or owner-directed forwarding with equivalent semantics) while a
  turn lease is live. A wrong-owner process with no local Promise and a valid
  remote owner lease must return a retryable 409/503 with `Retry-After` and must
  not accept the result. Without sticky routing or forwarding, durable
  multi-process runtime waits are unsupported; deployment construction should
  fail closed rather than rely on load-balancer luck.
- Add an explicit service method, for example
  `recoverAbandonedRuntimeTurns(workspaceId, ownerId)`, that scans durable
  pending-runtime-turn rows, claims only expired leases, and terminalizes those
  abandoned turns on process startup or handoff. Do not mutate history from
  read-only `list`/`stream` calls.
- `recoverAbandonedRuntimeTurns(...)` must also handle `state='accepted'` turns
  that were durably accepted with a `user.message` but never dispatched to Pi
  before a crash. `accepted -> dispatching` is the barrier that proves whether Pi
  side effects may have started, so an expired `accepted` turn is recoverable:
  claim it under the fenced turn token, transition it to `dispatching` exactly
  once, then load and run the persisted user prompt by `trigger_event_ids`. This
  does **not** close #13's broader request-level idempotency gap: if a client
  retried the whole `events.send` request and created a second accepted
  user-message turn, both durable turns may still run until a future request-dedupe
  layer exists. For `dispatching`, `running`, or `paused` turns, runtime side
  effects may already have happened; after lease expiry, recovery must terminalize
  rather than dispatching the same prompt again.
- In current in-memory deployments this method can be called by tests and by
  deployment construction. A durable/multi-process deployment must call it as a
  startup ownership-recovery step before accepting traffic.

Tests:

- recreate `DefaultSessionEventsService` over the same event/session stores
  after `agent.custom_tool_use + requires_action`, then submit
  `user.custom_tool_result`: the result is persisted and the session is
  explicitly terminalized, with no runtime call;
- crash after accepting `user.message` but before runtime dispatch: the event log
  has the user row and a `pending_runtime_turns(state='accepted',
  trigger_event_ids=[...])` row. Startup recovery claims the accepted turn,
  transitions `accepted -> dispatching` under the turn fence, loads the prompt by
  the recorded event id, dispatches it exactly once, and never leaves the prompt
  silently pending with no runtime owner;
- multiple `user.message` entries in one `events.send` batch: each accepted turn
  records its own triggering event id(s), and recovery dispatches the matching
  persisted prompt for each turn without relying on event order;
- accepted-turn stale owner fencing: if owner A crashes before dispatch, owner B
  claims and dispatches the accepted turn; any late owner A attempt to transition
  or dispatch with the old generation fails closed;
- duplicate client retry remains out of scope: if two distinct accepted
  `user.message` turns already exist because the whole HTTP request was retried
  without request-level dedupe, recovery may dispatch both. That is the remaining
  #13 request-idempotency gap, not a reason to drop a single recoverable accepted
  turn;
- crash after committing `state='dispatching'` but before first runtime output:
  startup recovery does not dispatch the prompt again; after lease expiry it
  terminalizes the turn explicitly;
- crash window after accepted user input but before runtime continuation:
  persist a prior `user.custom_tool_result` or `user.tool_confirmation` without
  a completed/terminalized turn marker, then retry after restart. The retry must
  claim/terminalize the orphaned turn, not classify the prior row as a completed
  stale duplicate;
- unrelated later turn completion is not stale-duplicate proof: create an
  orphaned custom-tool wait, append an unrelated later
  `session.status_idle(end_turn)`, then retry the result. It must follow the
  orphaned-turn path because no completed/terminalized row exists for the
  original action's turn;
- legacy pre-ledger paused history: event log contains
  `agent.custom_tool_use + requires_action` but no pending-turn/action rows.
  Startup reconciliation creates/claims a synthetic legacy turn and terminalizes
  it, or the service refuses traffic with a clear precondition failure; it never
  accepts a result via event-order inference;
- live-owner handoff: if another process still owns a valid turn lease, a
  result/confirmation request with no local pending runtime must return a
  retryable error without appending the submitted user row;
- non-sticky deployment guard: constructing a durable multi-process deployment
  without sticky `session_id` routing or owner-directed forwarding fails closed;
  with sticky routing, a result reaches the live owner and resolves normally;
- delayed-but-live owner: owner A pauses longer than one renewal cadence but
  less than the TTL plus grace; owner B recovery must not claim or terminalize.
  When A renews before writing, the turn remains live;
- long human pause: a `paused` custom-tool or builtin-confirmation wait remains
  live beyond TTL plus grace because the owner keeps renewing during the wait;
  recovery must not claim or terminalize while those renewals continue;
- stale owner after lease steal: owner A pauses beyond TTL plus grace, owner B
  claims/terminalizes, then A resumes. A's renewal/fencing check must fail
  closed before any runtime-derived write or user-result commit;
- turn identity: parallel custom tools and mixed custom-tool plus ask-gated
  builtin confirmation emitted from one model turn all have the same internal
  `turn_id`; a later follow-up prompt has a different `turn_id`;
- no per-action turn split: if one action in a multi-action turn is orphaned,
  terminalization clears/closes every sibling action under the same turn id;
- injected crash/failure between event append and pending-row insert/update
  rolls back both sides; there must be no visible `requires_action` without a
  pending turn/action row;
- EventStore API boundary: append/list/stream/delete calls require
  `workspaceId`, persisted event rows store `workspace_id`, and runtime-derived
  writes carry `workspaceId` through `RuntimeTurnContext`. Tests should simulate
  two workspaces with the same `session_id` (or a forced store fixture) and prove
  turn/action rows plus event reads do not cross tenants;
- injected crash/failure between terminal event append and turn terminalization
  rolls back both sides; there must be no terminal history with a still-owned
  pending turn;
- successful completion retains a closed action-to-turn tombstone. A later
  duplicate `user.custom_tool_result` for that action uses the closed action row
  plus completed turn row as proof, not event ordering;
- recovery scan terminalizes an incomplete custom-tool wait without waiting for
  a client retry only after the prior owner lease expires;
- two service instances over the same stores: instance B recovery must not
  terminalize instance A's live wait while A's lease is valid;
- stale owner fencing: after B claims an expired turn and terminalizes it, A
  must fail closed if it later tries to persist runtime output or commit a
  result with the old `(turn_id, owner_id, owner_generation)`;
- two pending custom tools in one turn: one orphaned result terminalizes the
  whole turn and clears both pending actions;
- two sibling custom-tool results submitted in the same retry batch after runtime
  loss: claim the turn once, persist both acceptable acknowledgements, append one
  terminal sequence, and close both actions; if any sibling acknowledgement is
  invalid, reject the entire turn-group before writing any row;
- multi-turn abandoned retry batch: validate all turn groups before writing. If
  one group is invalid or still live-owned, the entire HTTP request fails with no
  acknowledgements or terminal events persisted for any other group. If all
  groups are valid, all acknowledgements and terminal sequences commit in one
  EventStore unit-of-work, or the request is rejected as unsupported;
- mixed custom-tool plus builtin confirmation in one turn: orphan handling
  clears both pending action types and appends only one terminal sequence;
- after that terminalization, a late result for the sibling custom-tool action
  with no prior accepted result is rejected without appending a user row and
  without appending another terminal sequence;
- after that terminalization, an identical retry for the already-accepted action
  is accepted as a duplicate user row without appending another terminal
  sequence;
- already-resolved custom-tool use is ignored by recovery;
- pending builtin confirmation existing terminalization still passes;
- interrupted/archive/delete pending waits are not terminalized a second time.

### C. Resolve #51 with a pending internal-snapshot-delete ledger

Add a durable deletion ledger beside `session_file_mount_snapshots`, owned by
the session store because it needs the session/resource/snapshot mapping:

```sql
CREATE TABLE IF NOT EXISTS pending_internal_snapshot_deletes (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  snapshot_file_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_attempt_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (workspace_id, session_id, resource_id)
);
```

Also add delete fencing in the same store/unit-of-work used by event appends,
plus a narrow session-delete job/tombstone hidden from public retrieve/list:

This fence intentionally uses `(workspace_id, session_id)`. Do not rely on
globally unique session IDs as an implicit tenant boundary; the EventStore
schema/API migration above is part of this plan.

```sql
CREATE TABLE IF NOT EXISTS event_session_delete_fences (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  delete_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, session_id)
);
```

```sql
CREATE TABLE IF NOT EXISTS pending_session_deletes (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  delete_generation INTEGER NOT NULL,
  phase TEXT NOT NULL, -- tombstoned | events_cleaned | metadata_deleted | completed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (workspace_id, session_id)
);
```

Hard-delete orchestration:

Hard delete has two different atomicity problems: event/runtime cleanup and
snapshot-byte cleanup. The snapshot ledger only solves the byte cleanup side; a
delete job/tombstone solves the cross-store event/session-row boundary.

Required ordering:

1. In the event store, synchronously create or bump
   `event_session_delete_fences.delete_generation`. This is the authoritative
   delete write barrier. The event append transaction itself must check this
   fence and append in the same database transaction; a split session-store check
   followed by event-store append is forbidden.
2. In the session store, synchronously create or bump
   `pending_session_deletes.delete_generation` with the same generation and mark
   the session as `deleting`/tombstoned so public retrieve/list no longer exposes
   it as an active visible session. Do not delete event history or snapshot rows
   in this step. This transaction is idempotent and is the durable delete intent.
   - A crash after step 1 but before step 2 is recoverable from
     `event_session_delete_fences`: event writers already fail closed, and
     public session reads plus delete retry/startup reconciliation must consult
     the event fence (or a reconciled tombstone cache) and hide/recreate the
     missing `pending_session_deletes` row before accepting traffic. A
     fenced-but-visible session is not an allowed steady state.
   - A crash or manual partial state with a session-store tombstone but no event
     fence is also recoverable, but cleanup must not run from that state. Retry or
     sweeper must create the missing event fence first, then continue. This state
     should only occur from interrupted legacy code or injected tests; the normal
     delete path is fence-first.
   - Every user-event append path and every runtime-derived persistence path must
     check `event_session_delete_fences` inside the same event-store transaction
     that would append. If a fence exists or the caller's generation is stale,
     the write fails closed and no event is appended.
   - Delete cleanup must acquire this fence before deleting event history or
     closing runtime/broadcaster state. Cleanup writes use a separate,
     generation-scoped EventStore unit-of-work: only the delete owner holding the
     matching `(workspace_id, session_id, delete_generation)` may append the
     required terminal/delete lifecycle rows while the fence exists. That
     cleanup-owned append path must reject arbitrary user/runtime event types,
     must be idempotent on retry, and must not be available to stale runtime
     owners.
3. Run idempotent event/runtime cleanup after both fences/tombstones exist:
   close/abort the runtime best-effort, close pending runtime turns, append any
   required terminal lifecycle event through the matching cleanup-owned
   generation token, stop broadcaster state, and make `events.deleteSession(...)`
   safe to call more than once.
4. If event/runtime cleanup fails, keep the tombstone/delete job with
   `last_error`. Public reads remain hidden/tombstoned, and retry or a sweeper
   resumes from the job rather than exposing a visible session with erased or
   half-erased history.
5. After event/runtime cleanup succeeds, mark the delete job `events_cleaned`.
6. Run the synchronous session-store metadata transaction:
   - copy snapshot rows into `pending_internal_snapshot_deletes`;
   - delete `session_file_mount_snapshots`, `session_resources`, and `sessions`;
   - mark the session-delete job `metadata_deleted` or keep enough job state to
     drive snapshot cleanup;
   - commit.
7. Attempt byte cleanup after commit.
8. On byte cleanup success, remove the pending-delete rows and mark/remove the
   session-delete job as completed.
9. On byte cleanup failure, keep the rows with `attempt_count`,
   `last_attempt_at`, and a caller-safe `last_error`. The API may still report
   delete success because byte cleanup is safely queued and observable.

Crash windows:

- Crash after tombstone but before event cleanup: public reads do not expose the
  session as active; retry/sweeper resumes event cleanup from
  `pending_session_deletes`.
- Crash after event cleanup but before metadata delete: public reads still see a
  tombstone/deleting state, not a normal session with erased history; retry
  resumes metadata delete.
- Crash after metadata delete: snapshot byte cleanup is recoverable through the
  pending snapshot-delete ledger and/or session-delete job. Retry must not depend
  on the now-deleted session row to find snapshot bytes.

Add an explicit sweeper method, for example
`sweepPendingInternalSnapshotDeletes(workspaceId)`, so durable deployments can
retry. Do not hide it inside unrelated reads.

Idempotent retry rule: `deleteInternalSnapshot(workspaceId, fileId) === false`
means the internal object is already absent for that workspace and should clear
the pending row. Durable storage implementations must throw for retryable I/O
or authorization failures; returning `false` is the converged "not present"
state. This covers the crash window after byte deletion succeeds but before the
ledger row is removed.

Tests:

- forced storage delete failure during session hard-delete leaves pending
  ledger rows and returns success, with the original session metadata gone;
- forced event/runtime cleanup failure before session-store delete leaves the
  session/resource/snapshot rows intact but tombstoned/hidden, with a
  `pending_session_deletes` row carrying the error;
- concurrent `events.send` or runtime output racing with hard delete: once the
  delete tombstone/fence is committed, no user or runtime event can append before
  or after event cleanup; stale writers fail closed;
- fenced cleanup append: with a delete fence present, normal user/runtime append
  attempts fail, while the cleanup-owned unit-of-work with the matching
  `delete_generation` can append exactly the allowed terminal/delete lifecycle
  rows once. A stale or wrong-generation cleanup token cannot append, and the
  cleanup path cannot append arbitrary user/runtime event types;
- retry after crash between fence creation and cleanup lifecycle append:
  retry/sweeper uses the same `delete_generation` to append the missing
  terminal/delete lifecycle rows once, then continues cleanup;
- EventStore tenant fence: after creating
  `event_session_delete_fences(workspace_id=A, session_id=S)`, appends for
  `(A,S)` fail inside the event-store transaction while a forced fixture for
  `(workspace_id=B, session_id=S)` remains unaffected. No append path may do a
  session-store lookup to discover workspace during the fenced write;
- injected crash after `event_session_delete_fences` creation but before
  `pending_session_deletes` creation: event writers fail closed, public
  retrieve/list hides or reconciles the fenced session, and retry/sweeper creates
  the missing session-store tombstone before cleanup;
- injected crash or manual partial state with a session-store tombstone but no
  event-store delete fence: cleanup refuses to run until retry/sweeper creates
  the missing fence; no event history is deleted while event writers can still
  append;
- retry after event/runtime cleanup succeeds and session rows were already
  removed still runs or schedules the pending snapshot sweeper instead of
  relying on the deleted session row;
- crash after event cleanup but before metadata delete does not expose a visible
  session with erased history; retry resumes from the delete job;
- retry/sweep after storage recovers deletes bytes and clears the ledger;
- crash-after-byte-delete simulation: a pending row whose snapshot is already
  absent is cleared by the next sweep;
- no pending rows are left for successful in-memory delete;
- snapshot byte quota is released only when storage deletion succeeds, not when
  metadata is removed;
- cross-workspace pending rows cannot be swept from the wrong workspace.

## Implementation Split

Recommended PR order:

1. **#14 + duplicate-safe custom-tool results.** Implement duplicate-safe
   custom-tool results and orphaned runtime action terminalization together. Do
   not close #13 as "request-level idempotency" unless the PR also adds durable
   request-level retry safety for all `events.send` batches, including
   `user.message`. Without that broader dedupe, file/comment a narrower issue for
   duplicate-safe custom-tool results and leave #13 open.
2. **#51 pending snapshot delete ledger.** Separate storage concern; keep out of
   runtime wait code.

Do not ship a custom-tool duplicate PR that accepts no-runtime stale duplicates
unless it can prove completed/terminalized turn state without event-order
heuristics. The current plan's intended path is one combined #14/runtime-ledger
plus custom-tool duplicate-safety implementation PR. Keep #51 separate unless
the reviewer finds a shared durable-job abstraction genuinely pays for itself;
default is no shared abstraction.

## Non-Goals

- No attempt to resume a lost Pi `AgentSession` turn after process restart.
- No Redis/Postgres dependency in this slice.
- No hosted-incompatible `Idempotency-Key` contract unless a new probe shows
  the header is supported for Managed Agents events.
- No generic background job framework for #51; a narrow pending-delete ledger
  and explicit sweeper are enough.
- No durable file backend implementation.

## Review Questions

1. Is accepting duplicate custom-tool-result rows, rather than replaying the
   first row, the right hosted-compatible interpretation of probe 33?
2. Is `session.error + session.status_idle(end_turn)` the cleanest terminal
   custom-tool orphan shape, or should OMA reject the result and only expose
   recovery through a startup scan?
3. Should #14 require sticky process routing as production policy in addition
   to terminalization, or is explicit fail-after-handoff enough for MVP?
4. Does the #51 ledger belong in the session store, or should file storage own a
   generic internal-object cleanup table once durable backends arrive?
