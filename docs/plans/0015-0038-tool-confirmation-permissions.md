# Plan: Builtin Tool Confirmation Permissions

Issues:

- [#15](https://github.com/oneryalcin/open-managed-agents/issues/15)
- [#38](https://github.com/oneryalcin/open-managed-agents/issues/38)

## Goal

Support Managed Agents `always_ask` confirmation for OMA-owned builtin tools:

1. emit `agent.tool_use` with `evaluated_permission: "ask"`;
2. emit `session.status_idle` with
   `stop_reason: { type: "requires_action", event_ids: [<agent.tool_use id>] }`;
3. accept `user.tool_confirmation`;
4. resume the same Pi turn with an allowed or denied tool result;
5. preserve the existing `user.custom_tool_result` path unchanged.

This is the builtin permission-confirmation slice. MCP uses the same hosted
wire shape, but OMA does not currently instantiate MCP tools in the Pi runtime.
Keep the design compatible with future MCP confirmation events, but do not
claim MCP execution parity until the MCP runtime exists.

## Evidence

### Upstream Pi SDK

The upstream SDK docs were checked first, per project rule:

```bash
gh api repos/earendil-works/pi/contents/packages/coding-agent/docs/sdk.md \
  --jq .content | base64 --decode | rg -n "abort|clearQueue|followUp|steer|tool|permission|confirm"
```

Relevant result:

- The docs cover `AgentSession.abort`, `steer`, `followUp`, queue behavior,
  and custom tools.
- They do not document an Anthropic Managed-Agents-style
  `user.tool_confirmation` / `evaluated_permission` pause surface.

Installed SDK checked next:

```bash
node -p 'require("./node_modules/@earendil-works/pi-coding-agent/package.json").version'
rg -n "evaluated_permission|tool_confirmation|always_ask|permission_policy|beforeToolCall|tool_call" \
  node_modules/@earendil-works/pi-coding-agent/dist -g '*.js' -g '*.d.ts'
```

Facts:

- Installed package is `@earendil-works/pi-coding-agent@0.75.4`.
- No public runtime surface exposes hosted Managed Agents permission
  confirmations directly.
- Pi custom tool `execute(toolCallId, params, signal, onUpdate, ctx)` is still
  the stable provider-owned execution boundary.

### Existing OMA/Pi probes

Existing probes still matter:

- `scratch/19-e0-builtin-operations-injection.ts` proved direct builtin
  Operations injection can work but depended on internal active-tool mutation
  and leaked host environment shape into the Operations path. Superseded.
- `scratch/21-e2-define-tool-builtins.ts` proved the current accepted route:
  provider-owned builtin-shaped tools registered through Pi `customTools` with
  public names like `bash`, `noTools: "builtin"`, and an exact `tools`
  allowlist.

That means the permission gate belongs around OMA's provider-owned builtin
tool definitions, not in Pi's hidden builtins.

### Anthropic Python SDK and CWC examples

The CWC repo at `/Users/mehmetoneryalcin/dev/junk/cwc-workshops` contains a
current Anthropic SDK example and `.env` for live probes.

The installed Anthropic Python SDK (`0.103.1`) generated types show:

- `agent.tool_use` and `agent.mcp_tool_use` include
  `evaluated_permission?: "allow" | "ask" | "deny"` and optional
  `session_thread_id`.
- `user.tool_confirmation` has:
  - `tool_use_id`;
  - `result: "allow" | "deny"`;
  - optional `deny_message`;
  - optional `session_thread_id`.
- The type docs say `tool_use_id` is the top-level `agent.tool_use` or
  `agent.mcp_tool_use` event ID, and `session.status_idle.stop_reason.event_ids`
  points at the pending confirmable event IDs.
- Hosted probe 32 shows `agent.tool_use.tool_use_id` is `null` for confirmable
  builtin tool uses. The public confirmation identifier is the top-level
  `agent.tool_use.id`.

CWC `ship-your-first-managed-agent` confirms the client pattern:

- UI treats `agent.tool_use` / `agent.mcp_tool_use` with
  `evaluated_permission === "ask"` as confirmable.
- The confirm route sends `user.tool_confirmation`.

### Hosted probe 32

Probe:

```bash
set -a
. /Users/mehmetoneryalcin/dev/junk/cwc-workshops/ship-your-first-managed-agent/.env
set +a
mkdir -p scratch/artifacts
uv run --with anthropic python scratch/32-managed-agents-tool-confirmation-probe.py \
  | tee scratch/artifacts/32-managed-agents-tool-confirmation-probe-output.txt
```

Findings:

1. A builtin `agent_toolset_20260401` with
   `permission_policy: { type: "always_ask" }` emits `agent.tool_use` with
   `evaluated_permission: "ask"`.
2. Hosted then emits `session.status_idle` with
   `stop_reason: { type: "requires_action", event_ids: [<agent.tool_use id>] }`.
3. Sending `user.tool_confirmation` echoes the user event, with
   `processed_at: null` in the send response.
4. The later `events.list` row for the same `user.tool_confirmation` has
   `processed_at` set to a non-null timestamp.
5. The requested bash command writes a unique file as a durable side effect.
   The probe verifies no `agent.tool_result` exists before confirmation.
6. After an `allow`, hosted emits:
   - `session.status_running`;
   - `agent.tool_result` with `is_error: false`;
   - final `session.status_idle` with `stop_reason: { type: "end_turn" }`.
   A same-session verification command then proves the side-effect file exists.
7. After a `deny`, hosted emits:
   - `session.status_running`;
   - `agent.tool_result` with `is_error: true`;
   - final `session.status_idle` with `stop_reason: { type: "end_turn" }`.
   A same-session verification command then proves the side-effect file is still
   absent, which rules out pre-confirmation execution for the denied request.
8. The probe verdict was `all_ok: true` and the throwaway environment was
   deleted.

## Current OMA State

Already present:

- `user.tool_confirmation` is in `EVENT_TYPES`.
- `parseUserEvent` validates:
  - `tool_use_id`;
  - `result` allow/deny;
  - `deny_message` only for deny.
- Builtin sandbox tools are provider-owned Pi `customTools`, registered under
  public builtin names through `sandbox.tools`.
- The translator maps non-custom Pi `message_end` tool calls to
  `agent.tool_use`, and `tool_execution_end` to `agent.tool_result`.
- Custom tools have a separate bridge:
  `agent.custom_tool_use` + `user.custom_tool_result`.

Missing:

- No pending-confirmation store for `user.tool_confirmation`.
- No `evaluated_permission` field on emitted builtin `agent.tool_use`.
- No `session.status_idle{requires_action}` for builtin permission waits.
- No distinction between `always_allow`, `always_ask`, and `never_allow` at
  runtime.
- No `agent.mcp_tool_use` event type yet.

Important runner constraint:

The Pi runner currently gates sandboxed builtin events until it verifies the
sandbox provider actually handled the tool call. This is a safety invariant:
client-visible builtin tool output must not be published if Pi bypasses the
provider. For `always_ask`, however, the client must see the `agent.tool_use`
before execution so it can approve or deny. The implementation must keep the
provider-bypass guard while allowing the permission prompt to surface.

## Design

### 1. Resolve builtin tool surface and permission policy

Add a small runtime tool-surface resolver:

```ts
export type BuiltinToolPermission = "allow" | "ask" | "deny";

export interface BuiltinToolAccess {
  enabled: boolean;
  permission: BuiltinToolPermission;
}

export type BuiltinToolAccessResolver = (
  workspaceId: WorkspaceId,
  sessionId: string,
  toolName: SandboxedBuiltinToolName,
) => BuiltinToolAccess;
```

Wire it from deployment app construction using the existing stores:

1. session row -> agent id/version;
2. agent row -> `agent_toolset_20260401`;
3. per-tool `configs[].enabled` and `configs[].permission_policy` overrides;
4. `default_config.enabled` and `default_config.permission_policy`;
5. default enabled `true`, but only when `agent_toolset_20260401` is present;
6. default policy `always_allow`.

Absence of `agent_toolset_20260401` means the builtin surface is empty. A
sandbox provider being configured is not enough to expose `bash`, `read`,
`write`, `edit`, `find`, or `ls`. This must hold for:

- `tools: []`;
- custom-tool-only agents;
- MCP-only agents.

Enabled-state is part of the permission boundary:

- disabled tools must not be included in the Pi `tools` allowlist;
- disabled tools must not be registered as provider-owned custom tool
  definitions;
- if Pi still emits a disabled tool call because of stale state or a bug, fail
  closed before publishing output.

Policy mapping:

- `always_allow` -> `"allow"`;
- `always_ask` -> `"ask"`;
- `never_allow` -> `"deny"`;
- unknown policy values -> caller-safe runtime configuration error before
  executing the tool.

Do not derive policy from request/session input at runtime without the stored
agent row. Sessions use the agent version they were created with.

This resolver should return the effective tool surface for the whole session
when constructing the Pi handle, not only answer one-off execution checks. The
runner's active-tool assertion should validate exactly the enabled sandboxed
builtins plus any external custom tools.

### 2. Add a builtin permission bridge

Add a bridge alongside `PiCustomToolBridge`, not inside it:

- custom tools wait on `user.custom_tool_result` and emit
  `agent.custom_tool_use`;
- builtin permissions wait on `user.tool_confirmation` and emit
  `agent.tool_use`.

The bridge should expose:

```ts
interface RuntimeToolPermissionAskEvent {
  type: "oma.tool_permission_use";
  piToolCallId: string;
  name: SandboxedBuiltinToolName;
  input: JsonObject;
  evaluatedPermission: "ask";
  bindToolUseId(id: string, release: () => void): void;
  rejectToolUse(error: Error): void;
}
```

`DefaultSessionEventsService` materializes that ask event as:

```json
{
  "type": "agent.tool_use",
  "name": "<tool>",
  "input": {},
  "evaluated_permission": "ask"
}
```

Then it binds the public `sevt_*` ID into the bridge and emits:

```json
{
  "type": "session.status_idle",
  "stop_reason": {
    "type": "requires_action",
    "event_ids": ["<agent.tool_use sevt id>"]
  }
}
```

Clients echo the top-level `sevt_*` event ID in
`user.tool_confirmation.tool_use_id`; Pi's `toolu_*` stays internal bridge
state. Do not expose Pi's internal tool-call ID in a client-facing
`agent.tool_use.tool_use_id` field for confirmable builtin tools. The runner
must keep an internal map from Pi tool-call ID -> public `agent.tool_use.id` so
`agent.tool_result.tool_use_id` can also reference the public event ID, matching
hosted behavior.

This is a correction to the provisional builtin/MCP portion of ADR 0011. The
custom-tool decision remains unchanged: `agent.custom_tool_use.id` is the
public `custom_tool_use_id`, and Pi's custom-tool call ID stays internal.

Only `"ask"` uses this bridge and emits `requires_action`. `"deny"` is not a
pending confirmation.

### 3. Wrap sandbox builtin tool definitions

Wrap each provider-owned sandbox tool definition in the runner:

- `"allow"`:
  - execute the provider tool immediately;
  - translated `agent.tool_use` includes `evaluated_permission: "allow"`;
  - current provider-bypass validation remains.
- `"ask"`:
  - on `execute`, emit `oma.tool_permission_use` before running provider
    operations;
  - wait for `user.tool_confirmation`;
  - on allow, run the underlying provider tool and return its result;
  - on deny, use Pi's top-level tool-error path, not a returned error-shaped
    payload. Existing OMA/Pi evidence says returning `{ isError: true }` from a
    custom tool does not necessarily set raw `tool_execution_end.isError`.
    Prefer throwing a dedicated permission-denied error from the wrapper (or
    another focused-probe-verified mechanism) so the raw Pi
    `tool_execution_end.isError === true` and the translated
    `agent.tool_result.is_error === true`;
  - honor the Pi `AbortSignal` by rejecting the pending confirmation and
    removing it from the pending store.
- `"deny"`:
  - do not run provider operations;
  - do not emit `requires_action`;
  - do not create a pending confirmation;
  - translate the original Pi tool call to one `agent.tool_use` with
    `evaluated_permission: "deny"`;
  - use the same verified top-level Pi tool-error path as denied `"ask"` so the
    stream contains one `agent.tool_result` with `is_error === true`;
  - mark the Pi tool call ID as permission-denied so the sandbox bypass guard
    accepts the absence of provider invocation only for that call;
  - publish `agent.tool_result.tool_use_id` as the public `agent.tool_use.id`,
    not the Pi `toolu_*`;
  - add a focused hosted probe before freezing exact `never_allow` message
    text if client-visible text matters.

### 4. Avoid duplicate `agent.tool_use`

The internal `oma.tool_permission_use` event must not go through the generic
sandboxed-event gate after `activeSandboxedToolCalls` is non-empty. Otherwise
the runner can deadlock:

1. Pi emits `message_end` with a sandboxed builtin call.
2. The runner marks the call active and gates later sandboxed events.
3. Pi calls the tool wrapper.
4. The wrapper emits `oma.tool_permission_use` and waits for approval.
5. If the runner gates that internal event behind `tool_execution_end`, the
   client never sees the approval request, so `tool_execution_end` never
   happens.

Implementation rule:

- handle `oma.tool_permission_use` before the generic
  `activeSandboxedToolCalls.size > 0` gate;
- materialize only that confirmable `agent.tool_use` and
  `session.status_idle{requires_action}` before execution;
- keep the original Pi `message_end`, `tool_execution_start/update`, and later
  `tool_execution_end` gated until provider execution is validated.
  - for `"deny"`, validation is the explicit permission-denied marker, not a
    provider invocation;
  - for `"allow"` and approved `"ask"`, validation remains the provider
    invocation recorded by the sandbox provider.

Because `message_end` already contains the Pi tool call, the runner must also
prevent double publication when an `ask` confirmation was materialized by the
internal permission event.

Implementation rule:

- track Pi tool call IDs whose public `agent.tool_use` was already emitted by
  the permission bridge;
- when releasing gated sandboxed events after tool completion, suppress the
  duplicate `message_end` tool-use draft for those IDs;
- still allow the `tool_execution_end` draft to become `agent.tool_result`.

This keeps:

- one `agent.tool_use`;
- one `session.status_idle{requires_action}`;
- one `user.tool_confirmation`;
- one `agent.tool_result`.

### 5. Claim `user.tool_confirmation` before persistence

Mirror `claimCustomToolResults`, with one extra rule: confirmation is a
side-effect boundary, so retry-after-timeout must be deterministic.

Do not redefine the append-only event-log meaning of `processed_at`. In OMA's
durable store, a persisted user event keeps a stable acceptance timestamp and is
never mutated after append. Hosted probe 32's `processed_at: null` applies to
the immediate `events.send` response echo only. Implement that as a transient
API response projection for the newly accepted `user.tool_confirmation`, not as
the stored row and not as an SSE/list representation. `events.list` and replayed
SSE must expose the persisted non-null acceptance timestamp for the same event
ID.

1. Parse and validate the event.
2. Look up pending and completed confirmation state by the scoped natural key
   `(workspaceId, sessionId, tool_use_id)`. Also verify that the referenced
   `agent.tool_use` event belongs to the same session before accepting or
   replaying a confirmation. A confirmation posted to the wrong session path or
   wrong workspace must behave like no pending confirmation exists and return
   caller-safe 404, not replay another session's accepted row.
3. If a matching `user.tool_confirmation` was already completed for the same
   `(workspaceId, sessionId, tool_use_id)` and same result/deny message, return
   the original persisted user event row without resolving the tool again.
4. If a matching confirmation was already completed for the same scoped key
   with a different result/deny message, reject caller-safely; do not attempt to
   re-decide the already-consumed permission.
5. If the user event was persisted but the runtime confirmation was not
   completed, a retry with the same payload must either:
   - find the still-pending runtime confirmation and commit it using the
     existing persisted user event; or
   - reject with a clear runtime-lost error if the pending runtime confirmation
     no longer exists.
   It must not return the persisted row as successful while the session remains
   paused.
6. Before persisting a new user event, claim the pending confirmation from the
   runtime runner. The claim must be rollback-safe:
   - either it is a non-mutating lookup/reservation until `commit()`; or
   - it has an explicit `release()` path that restores availability if any
     persistence, publish, or status-running step fails before `commit()`.
   The client must be able to retry the same confirmation after such a failure
   without losing or double-resolving the pending runtime permission.
7. If no matching pending confirmation exists, return caller-safe 404:
   `No pending tool confirmation: <id>`.
8. Persist the `user.tool_confirmation`.
9. Return the send-response echo for `user.tool_confirmation` with
   `processed_at: null` by projecting the returned event only. The persisted
   row, `events.list`, and replay/SSE surfaces keep the durable non-null
   acceptance timestamp, matching the append-only event-log contract while still
   matching hosted confirmation echoes.
10. Emit `session.status_running`.
11. Commit the claim to resolve the pending tool Promise.
12. Record the completed confirmation outcome keyed by
    `(workspaceId, sessionId, tool_use_id)` only after the runtime claim has
    been committed.
13. If other confirmations/custom tools remain pending, re-emit
   `session.status_idle{requires_action}` with only the remaining IDs.

This is not full request-level idempotency for every event type. It is the
minimum natural-key replay needed for a side-effecting confirmation approval:
if the client loses the first response after the tool has been allowed, a retry
must not report "not accepted" while the tool is already running or complete;
and if the first attempt persisted but failed before runtime resolution, a retry
must not falsely report success while the tool is still blocked.

Keep `user.tool_confirmation` separate from `user.custom_tool_result`:

- `user.custom_tool_result.custom_tool_use_id` resolves
  `agent.custom_tool_use`;
- `user.tool_confirmation.tool_use_id` resolves `agent.tool_use` /
  future `agent.mcp_tool_use`.

### 6. Coalesce pending requires-action IDs across both wait types

Today the service coalesces only custom-tool waits. Generalize the pending idle
emitter so it can include:

- pending custom tool IDs;
- pending builtin confirmation IDs.

When a single response resolves one pending action while another remains, emit
`session.status_idle{requires_action}` with the remaining IDs, matching the
custom-tool behavior already implemented.

### 7. Keep archive and interrupt semantics coherent

The session-archive fix allows archive while waiting on custom-tool input by
checking pending custom actions. Extend that logic so builtin confirmation
waits also count as paused-awaiting-input, not actively running.

Interrupt behavior:

- `user.interrupt` clears pending custom tool waits and pending builtin
  confirmations;
- stale `user.tool_confirmation` after interrupt returns 404, not silent ignore;
- the runtime abort still owns Pi cancellation.

Archive/delete behavior:

- archive/delete clears pending confirmations and closes the runtime, same as
  custom-tool waits;
- no confirmation can resolve after archive/delete.

### 8. MCP scope

Add type-level and service-level seams so future MCP permission confirmations
use the same pending-confirmation store:

- reserve `agent.mcp_tool_use` in the event type list only if the implementation
  can emit/test it honestly;
- otherwise leave it out and document that MCP runtime execution remains a
  follow-up.

Do not fake MCP execution through builtin tests. If a live MCP probe is needed,
make it a separate probe and plan amendment after the runtime can instantiate
MCP tools.

## Tests

### Parser/service

- `user.tool_confirmation` rejects:
  - missing `tool_use_id`;
  - invalid `result`;
  - `deny_message` on allow;
  - no pending confirmation -> 404.
- `user.tool_confirmation` is persisted before the confirmation Promise is
  resolved, and `session.status_running` is emitted before runtime resumes.
- `user.tool_confirmation` send-response echoes expose `processed_at: null`,
  while later event-list and replay/SSE rows for the same event ID expose the
  persisted non-null `processed_at`. The null echo is a transient response
  projection only; the stored row is immutable.
- if persistence or publish fails after claiming a pending confirmation but
  before committing it, the claim is released or was never destructively
  consumed; retrying the same confirmation can still resolve the original
  pending permission exactly once.
- retrying the same accepted `user.tool_confirmation` for the same
  `(workspaceId, sessionId, tool_use_id)` returns the original user event and
  does not resolve or execute the tool again.
- replaying or submitting a known confirmable `tool_use_id` on the wrong
  session path or wrong workspace returns caller-safe 404 and never returns
  another session's persisted confirmation row.
- retrying after a persist-succeeded / commit-not-called failure commits the
  still-pending runtime confirmation exactly once, or rejects clearly if the
  runtime pending state is gone.
- retrying the same scoped `(workspaceId, sessionId, tool_use_id)` with a
  different result/deny message rejects without changing the already-accepted
  outcome.
- stale confirmation after `user.interrupt` returns 404.
- mixed pending custom tool + builtin confirmation re-emits requires_action
  with only remaining IDs after one is resolved.
- archive during pending builtin confirmation succeeds and terminates the
  session, matching the requires-action archive parity from #60.

### Runner/bridge

- `always_allow` builtin:
  - emits one `agent.tool_use` with `evaluated_permission: "allow"`;
  - does not expose a client-facing Pi `toolu_*` as `tool_use_id`;
  - executes provider operation;
  - emits one `agent.tool_result` whose `tool_use_id` points at the public
    `agent.tool_use.id`.
- disabled builtin tools:
  - are absent from the Pi active tool allowlist;
  - are absent from registered provider-owned tool definitions;
  - fail closed if an event for that tool still appears.
- absent `agent_toolset_20260401`:
  - exposes no sandboxed builtin tools even when a sandbox provider exists;
  - custom-only and MCP-only agents do not inherit bash/read/write/edit/find/ls.
- `always_ask` builtin:
  - emits one `agent.tool_use` with `evaluated_permission: "ask"`;
  - does not expose a client-facing Pi `toolu_*` as `tool_use_id`;
  - exposes the real tool name and input before approval, so the client can
    inspect exactly what it is allowing or denying;
  - emits `session.status_idle{requires_action}` pointing at the public
    `agent.tool_use.id`;
  - does not publish any `agent.tool_result` before confirmation;
  - executes exactly once after allow, proved by both public tool result and
    durable side-effect presence;
  - returns `agent.tool_result.is_error === false` after allow;
  - after deny, raw Pi `tool_execution_end.isError === true` and translated
    `agent.tool_result.is_error === true`;
  - after deny, durable side-effect absence proves provider execution did not
    happen before or after rejection;
  - does not emit duplicate `agent.tool_use` after tool completion.
- `never_allow` builtin:
  - emits one `agent.tool_use` with `evaluated_permission: "deny"`;
  - does not expose a client-facing Pi `toolu_*` as `tool_use_id`;
  - emits no `requires_action`;
  - never invokes provider operations;
  - raw Pi `tool_execution_end.isError === true`;
  - emits one translated `agent.tool_result` with `is_error === true` whose
    `tool_use_id` points at the public `agent.tool_use.id`;
  - resumes the turn without waiting for `user.tool_confirmation`.
- abort while waiting:
  - removes pending confirmation;
  - rejects later `user.tool_confirmation`;
  - does not execute provider operation.
- provider bypass guard still holds:
  - if Pi emits sandboxed builtin output without provider execution for an
    allow path, the runner fails closed before publishing output.

### API

- End-to-end Hono test:
  - create agent with `agent_toolset_20260401.default_config.permission_policy`
    `always_ask`;
  - create session;
  - send user message;
  - observe `agent.tool_use` ask + `requires_action`;
  - send allow;
  - observe result and final idle.
- Same for deny.
- Existing custom-tool round-trip tests remain unchanged and still pass.

## Non-Goals

- No Pi hidden-builtin mutation path.
- No host builtin fallback.
- No durable pending-confirmation recovery across process restart; that remains
  the same family as durable custom-tool waits (#14).
- No full MCP runtime implementation.
- No multiagent `session_thread_id` routing beyond accepting/preserving the
  field once the event type supports it.
- No general request-level idempotency across all event types; #13 remains for
  the broader event-send contract.

## Acceptance Criteria

1. Hosted probe 32 remains committed as the contract evidence and passes with
   `all_ok: true`, and its verifier side-effect checks prove:
   - no public tool result exists before confirmation;
   - deny leaves the requested side effect absent in the same session;
   - allow creates the requested side effect in the same session.
2. `always_ask` builtin tool calls pause before provider execution and publish:
   `agent.tool_use(evaluated_permission:"ask")` ->
   `session.status_idle(requires_action)`.
3. `user.tool_confirmation allow` resumes execution and publishes a successful
   `agent.tool_result`.
4. `user.tool_confirmation deny` resumes the turn through a verified top-level
   Pi tool-error path: raw `tool_execution_end.isError === true` and translated
   `agent.tool_result.is_error === true`.
5. `always_allow` continues to run without client confirmation and includes
   `evaluated_permission:"allow"` on `agent.tool_use`.
6. `never_allow` denies without provider invocation and without
   `requires_action`, while still producing raw
   `tool_execution_end.isError === true` and translated
   `agent.tool_result.is_error === true`.
7. `enabled:false` removes builtin tools from the active runtime surface.
8. Agents without `agent_toolset_20260401` have no builtin tool surface.
9. `user.tool_confirmation` send echoes use `processed_at: null`; later list and
   replay/SSE rows for the same confirmation use non-null persisted
   `processed_at`.
10. Pending confirmation state participates in interrupt/archive/delete cleanup.
11. Retrying an already-accepted confirmation is deterministic and does not
   rerun side effects.
12. A persisted-but-uncommitted confirmation retry does not falsely succeed
    while the runtime remains paused.
13. Existing custom-tool behavior and tests are unchanged.
14. Typecheck and full Vitest suite pass.
