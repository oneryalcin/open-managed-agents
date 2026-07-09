# 0123 — events/service.ts god-class split (extract the persist-and-claim state machines)

Date: 2026-07-09
Issue: [#164](https://github.com/…/issues/164). Successor to #160/#162 (PR #162
already moved the pure helpers out: `request.ts`, `runtime-helpers.ts`,
`session-guards.ts`, `tool-persistence.ts`). Unblocked: #164 said "schedule
after M2"; M2 (MCP vaults) shipped (`40917ed`).

**Handoff plan.** All `file:line` against `main` at `40917ed`; re-confirm
before editing — this file churns.

**Status: DESIGN ONLY.** No code written yet. This doc exists so the seam and
the three behavioral couplings are reviewed *before* `service.ts` is touched,
per the issue's own instruction ("needs its own slice with careful review, not
a pure move").

---

## 1. Why this slice exists / definition of done

`DefaultSessionEventsService` is **2,971 lines / ~70 methods** spanning six
concerns. The issue targets the three "persist-and-claim state machines" that
each re-implement the same pending/interrupted/completed `Map` bookkeeping.

**Definition of done:** the pending-action bookkeeping lives in one reusable
helper; the custom-tool and tool-confirmation persist/claim logic live in two
per-concern collaborators the service composes; `service.ts` drops below ~2,300
lines; **all 80 tests in the six affected suites stay green with zero
behavioral change** (verified byte-diffable event output, not just "passes").

**Non-goals:** `runRuntimePrompts` (the ~350-line orchestrator, 1276–1620), the
abandoned-turn recovery/lease machinery (919–1130), and list/stream/replay
(1139–1220) are *out of scope* — separate future slices.

---

## 2. Corrected mental model (the issue is slightly wrong, and it matters)

The issue says "three near-duplicate persist-and-claim state machines: custom
tools, tool confirmations, MCP tool use." Reading the code (`service.ts`
against `40917ed`), the truth is **two state stores, not three**:

| Concern | Pending store | Interrupted store | Completed cache |
|---|---|---|---|
| Custom tools | `pendingCustomToolActions` (172) | `interruptedCustomToolActions` (183) | **none** |
| Tool confirmations | `pendingToolConfirmations` (184) | `interruptedToolConfirmations` (192) | `completedToolConfirmations` (193) |
| MCP tool use | — *rides confirmations* — | — *rides confirmations* — | — |

**MCP is not a third machine.** `persistMcpToolUse` (2096) and
`persistMcpToolUseWithModelEnd` (2141) call `addPendingToolConfirmation`
(2133, 2237); MCP confirmations are claimed by `claimToolConfirmations` (2498);
MCP only diverges at *draft-generation* time via `isMcpToolUseEventId` (2720).
`persistMcpToolResult` (2247) / `persistMcpConnectionFailed` (2279) carry **no
pending state at all** (turnState `running` only).

So the real shape is: **one shared pending substrate + two persist/claim
concerns, with MCP as a confirmation variant.** The design follows that shape,
not the issue's three-way framing.

The two pending stores are byte-parallel over an identical value shape
(`{ workspaceId; ids: string[]; timer }`, 172-179 ≡ 184-191); the
add/remove/clear/has quartets (2762-2818 ≡ 2820-2872) differ only in which map
field and parameter name they touch. **That** is the genuine duplication.

---

## 3. The three couplings that make this NOT a pure move

Each is guarded by a named behavioral test (§6) — that is what makes the
refactor tractable.

**C1 — `flushPendingActions` is deliberately cross-concern (2928-2963).** It
reads *both* pending stores for one session key, merges
`[...custom.ids, ...confirmations.ids]`, and emits **one**
`session.status_idle{ stop_reason.type: "requires_action" }` carrying the merged
`event_ids`. The two stores cannot flush independently — the coalescing is the
contract. Guard: *"re-emits requires_action with all pending IDs when a second
tool wait arrives later"*, *"does not keep stale requires_action IDs after a
runtime-side tool failure"*.

**C2 — confirmation→MCP terminalization coupling.**
`lostToolConfirmationResultDraft` (2703) branches on `isMcpToolUseEventId`
(2720, a paged full-history scan of `agent.mcp_tool_use`) to pick
`agent.mcp_tool_result` vs `agent.tool_result`. Completion detection
`hasToolResultForToolUseId` (`request.ts:98`) matches `agent.mcp_tool_result`
by `mcp_tool_use_id`. Because MCP rides confirmations, this is *confirmation-
internal* — it does not cross a collaborator boundary if MCP lives with
confirmations. Guard: *"terminalizes … when runtime state is lost"*, *"ask
flow: requires_action lists the mcp use id, allow resumes, replay is
idempotent"*.

**C3 — completed-cache asymmetry.** `completedToolConfirmations` (193, written
at 490, scope-cleared at 2874) has **no custom-tool equivalent**; custom
replay/idempotency derives purely from persisted history
(`findPersistedCustomToolResult`, 2459). A "generic" collaborator interface
must **not** force a completed cache onto both concerns.

**Plus** — the pending helpers are called from **five external orchestrators**,
so the collaborator boundary must re-expose the pending surface to them:

| Caller | Line(s) | Calls |
|---|---|---|
| `sendInternal` | 457, 460, 490, 498 | removePending (custom+confirm), `completedToolConfirmations.set`, flush |
| `maybeInterruptRuntime` | 516, 523, 528, 535 | blockInterrupted + clearPending (both) |
| `archiveSession` | 816-820 | clearPending (both) + clearCompleted + clearInterrupted (both) |
| `deleteSession` | 834-838 | same as archive |
| `finishRuntimeTask` | 1254-1255 | clearInterrupted (both) |
| `assertSessionArchivable` | 773 | hasPendingRuntimeActions → hasPending (both) |

---

## 4. Proposed seam

Three new files under `events/`. Service composes them; **no public API of
`SessionEventsService` changes.**

### 4.1 `events/pending-actions.ts` — the shared substrate (Slice 1)

```ts
export class PendingActionStore {
  private readonly pending = new Map<
    string,
    { workspaceId: WorkspaceId; ids: string[]; timer: ReturnType<typeof setTimeout> | undefined }
  >();

  // append id; on first id for a key, schedule the (cross-store) flush thunk.
  add(key: string, workspaceId: WorkspaceId, id: string, scheduleFlush: () => void): void;
  remove(key: string, id: string): void;      // filter ids; delete iff empty AND timer===undefined (2793)
  clear(key: string): string[];               // clearTimeout + delete; return drained ids (2798)
  has(key: string): boolean;                  // ids.length > 0 (2810)
  drainForFlush(key: string): string[];       // null the timer, return ids, delete iff empty (2945)
}
```

The timer callback stays a *thunk owned by the service* (`() =>
this.flushPendingActions(ws, sid)`) because the flush is cross-store (C1). The
store owns only the map mechanics + timer handle. Two instances replace the two
inline maps + the eight quartet methods.

**Delete-condition fidelity (the one subtle bit):** `remove`/`clear` delete
only when `ids.length === 0 && timer === undefined` (2793, 2847); `drainForFlush`
deletes on `ids.length === 0` alone — but only *after* it has forced `timer =
undefined` (2933-2940). Preserve both exactly; this governs when a session key
leaves the map and must not shift.

### 4.2 `events/custom-tool-actions.ts` — `CustomToolActions` collaborator (Slice 2)

Owns: one `PendingActionStore` + `interruptedCustomToolActions` (Set-map).
Methods moved in: `persistCustomToolUse` (1875), `claimCustomToolResults`
(2311), `rejectAmbiguousCustomToolResultDuplicates` (2441),
`findPersistedCustomToolResult` (2459), `listCustomToolHistory` (2479),
`customToolTerminalizationRows` (648), `blockInterrupted`. Injected deps:
`events`, `broadcaster`, `runtimeRunner`.

### 4.3 `events/tool-confirmations.ts` — `ToolConfirmations` collaborator (Slice 2)

Owns: one `PendingActionStore` + `interruptedToolConfirmations` +
`completedToolConfirmations` (C3 lives here, not forced onto custom). Methods
moved in: `persistToolPermissionUse` (1942), `…WithModelEnd` (1987),
`persistMcpToolUse` (2096), `…WithModelEnd` (2141), `persistMcpToolResult`
(2247), `persistMcpConnectionFailed` (2279), `claimToolConfirmations` (2498),
`findPersistedToolConfirmation` (2627), `terminalizeLostToolConfirmation`
(2683), `lostToolConfirmationResultDraft` (2703), `isMcpToolUseEventId` (2720),
`listToolConfirmationHistory` (2739), `toolConfirmationTerminalizationRows`
(698), `clearCompleted`, `recordCompleted` (replaces the raw `.set` at 490),
`blockInterrupted`. **C2 stays entirely inside this file** — MCP is a
confirmation variant. Injected deps: `events`, `broadcaster`, `runtimeRunner`,
`runtimeTranslator`.

---

## 5. How each coupling stays correct across the boundary

**C1 (flush coalescing).** `flushPendingActions` stays in the **service** as the
coordinator; it becomes:
```
const ids = [...customTools.drainForFlush(key), ...confirmations.drainForFlush(key)];
if (ids.length) publish one session.status_idle{requires_action, event_ids: ids};
```
The single-event contract is preserved because the merge/publish never leaves
the service. Collaborators expose `drainForFlush`; they do **not** each publish.

**C2 (confirmation→MCP).** No cross-collaborator call — `isMcpToolUseEventId`
and `lostToolConfirmationResultDraft` are private to `ToolConfirmations`. This
is the payoff of modeling MCP as a confirmation variant rather than a third
machine.

**C3 (completed asymmetry).** No shared interface is imposed. Each collaborator
is its own class; they merely both *use* a `PendingActionStore`. `CustomTool­
Actions` simply has no completed cache.

**External callers.** Rewrite the five orchestrators to delegate, e.g.
`this.customTools.clearPending(key)` / `this.confirmations.clearPending(key)`;
`assertSessionArchivable` → `customTools.hasPending(key) || confirmations.has­
Pending(key)`; `sendInternal`'s `completedToolConfirmations.set(...)` (490) →
`this.confirmations.recordCompleted(...)`.

### 5.1 Open seam to resolve during Slice 2 (flagged, not yet decided)

The claim paths call **turn-lifecycle helpers that are shared with the recovery
path** and therefore must NOT move into a collaborator:
`claimTurnForTerminalization` (1041), `claimAcceptedTurn` (1025),
`promptsFromAcceptedTurn` (1057) are also used by
`terminalizeAbandonedRuntimeTurn` (1084) / `scheduleAcceptedTurnRecovery` (991).
Two candidate boundaries:

- **(a)** Collaborators' `claim*` return pure *decision* objects
  (`CustomToolResultClaim[]` / confirmation claims — the discriminated unions at
  ~152-166 already exist); the **service** applies terminalization using the
  shared turn helpers. Keeps turn-lifecycle central; collaborators stay
  persistence+decision only. **Preferred.**
- **(b)** Extract the turn helpers into a fourth shared module injected into both
  collaborators. More moving parts; risks widening scope.

Recommend (a). Decide before writing Slice 2.

---

## 6. Verification

Baseline (at `40917ed`, this worktree): **80 tests green in 2.0s, no docker**,
across `custom-tools-api`, `tool-confirmation-api`, `mcp-events-api`,
`session-events-api`, `session-events-idempotency-api`, `runtime-events-api`.

Map of coupling → guarding test (must stay green, unchanged assertions):
- C1 → *"re-emits requires_action with all pending IDs when a second tool wait
  arrives later"*; *"does not keep stale requires_action IDs after a
  runtime-side tool failure"*.
- C2 → *"terminalizes a custom tool result when runtime state is lost"*; *"ask
  flow: requires_action lists the mcp use id, allow resumes, replay is
  idempotent"*.
- external callers → *"rejects custom_tool_result after interrupt retires the
  pending custom tool"*; *"archives a session paused on custom-tool
  requires_action"*; *"deletes a session paused on custom-tool requires_action
  without accepting stale results"*.

Rule: **no test assertion is edited.** If a test needs changing, the refactor
changed behavior — stop and reassess. Typecheck (`src/` clean today; the 11
`scratch/*` errors are pre-existing and unrelated).

---

## 7. Slicing

- **Slice 1 — `PendingActionStore`.** Extract substrate; instantiate twice;
  `flushPendingActions` reads both instances. ~110 dup lines → ~70-line class.
  Low risk, fully guarded by C1 + external-caller tests. Ships as its own PR.
- **Slice 2 — `CustomToolActions` + `ToolConfirmations`.** The god-class break.
  Depends on Slice 1. Resolve §5.1 first. Ships as its own PR (or two stacked:
  custom, then confirmations+MCP).

Slice 1 is the shared foundation Slice 2 composes, so it is the correct first
step regardless of whether Slice 2 lands immediately after.

---

## 8. Risks

- **Timer/delete-timing drift (C1 substrate).** The `timer === undefined` guard
  divergence between `remove` and `drainForFlush` (§4.1) is easy to flatten by
  accident and would change when keys leave the map. Port verbatim; the
  requires_action tests catch gross breakage but a leaked empty entry is
  silent — eyeball it.
- **`recordCompleted` timing (490).** The completed cache is written *after*
  commit in `sendInternal`. Moving it behind `confirmations.recordCompleted`
  must keep that ordering (post-commit) or replay/idempotency shifts.
- **Injected `runtimeRunner`/`runtimeTranslator` are `| undefined`** (runtime is
  optional in the constructor, 216-217). Collaborators must tolerate the
  no-runtime construction the tests exercise.

---

## 9. Disposition log

_(empty — to be filled after review, before implementation.)_
