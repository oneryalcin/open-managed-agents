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

**Reviewed 2026-07-09** by Codex (native + adversarial), Opus (adversarial),
and Sonnet (correctness) — four independent passes. Verdict: seam is right,
proceed with named changes. All findings folded in below; disposition log §9.
The load-bearing correction: the doc had its **risk profile inverted** — C1
(§3) is provably the *safest* coupling; §5.1 is the actual hard problem, and
the collaborator contract was missing two dependencies the persist paths rely
on (lifecycle guards, durable release-close). Fixed in §4–§5.

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

> **Risk note (review correction).** There is **no single shared timer** today:
> each `addPending*` (2779, 2833) owns an independent timer on its own map
> entry, both pointing at `flushPendingActions`; whichever fires first clears
> **both** timers (2933-2940) and drains both maps in one synchronous call.
> The proposed design (per-store timer handle + service-owned flush thunk)
> preserves this exactly, and the drain-then-delete makes any re-entry a safe
> no-op. C1 is the **safest** coupling, not the riskiest — adversarial review
> could construct no double-publish or lost flush. The real hazard is §5.1.

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
  clear(key: string): string[];               // ALWAYS clearTimeout + delete; return drained ids (2798)
  has(key: string): boolean;                  // ids.length > 0 (2810)
  snapshotForFlush(key: string): string[];       // clearTimeout + set timer=undefined, return ids, delete iff empty (2933-2947)
}
```

The timer callback stays a *thunk owned by the service* (`() =>
this.flushPendingActions(ws, sid)`) because the flush is cross-store (C1). The
store owns only the map mechanics + timer handle. Two instances replace the two
inline maps + the eight quartet methods.

**Delete-condition fidelity (the three paths differ — port each verbatim):**
- `remove` (2784, 2838): after filtering ids, delete **iff `ids.length === 0
  && timer === undefined`** — a live timer keeps the entry alive.
- `clear` (2798, 2852): **unconditional** — always `clearTimeout` + `delete`,
  return the drained ids regardless of whether ids/timer were set. This is the
  interrupt/archive/delete cleanup path; it must drop live pending IDs. *(The
  earlier draft wrongly said `clear` shared `remove`'s guard — it does not;
  copying that would leave stale entries and re-emit `requires_action` for
  interrupted/deleted waits.)*
- `snapshotForFlush` (models 2933-2947): force `clearTimeout` + `timer = undefined`,
  then delete **iff `ids.length === 0`** (guard already satisfied). Not a bare
  `= undefined` — the `clearTimeout` matters.

These three governs when a session key leaves the map and must not shift. A
focused `PendingActionStore` unit test for *clear-with-active-timer* and
*clear-with-nonempty-ids* is warranted (the one place a unit test earns its
keep here).

**Shared collaborator dependencies (both files) — the contract the first draft
under-specified.** Beyond `events`/`broadcaster`, every persist path depends on
three things review flagged as missing:

1. **Lifecycle guard.** `persistCustomToolUse` (1883-1884) and every other
   persist method open with `if (closedSessions.has(key)) return; if
   (deletedSessions.has(key)) return;`. Those Sets are service-owned. Inject
   `isClosedOrDeleted(ws, sid): boolean` into both collaborators (or keep the
   guarded entrypoints in `service.ts` and have it call the collaborator only
   past the guard). **Without this, a late runtime emission persists into an
   archived/deleted session and resurrects it.** New verification: late
   custom-tool / builtin-tool / MCP emission after archive+delete is dropped.
2. **Durable release-close.** The release callback bound in `bindCustomToolUseId`
   (1901-1911) does **two** things: `closeReleasedRuntimeAction` (1844 — writes
   a durable `closedActions` via `events.appendBatchWithRuntimeChanges`) **and**
   `removePendingCustomToolAction`. Carrying only the pending removal into the
   collaborator leaves the runtime action `pending` → recovery treats the turn
   as paused-with-pending-action and can wedge. `closeReleasedRuntimeAction`
   needs only `events`, so a collaborator can own it — but it must be moved/called,
   not dropped. New verification: released custom / builtin / MCP actions are
   closed durably, not merely un-pended.
3. **`runtimeRunner` reference, not just a method.** `claimCustomToolResults`
   branches on `this.runtimeRunner?.claimCustomToolResult` *existence* (2405);
   the collaborator needs the optional runner object, and must tolerate it being
   `undefined` (no-runtime construction the tests exercise).

### 4.2 `events/custom-tool-actions.ts` — `CustomToolActions` collaborator (Slice 2)

Owns: one `PendingActionStore` + `interruptedCustomToolActions` (Set-map).
Methods moved in: `persistCustomToolUse` (1875), `claimCustomToolResults`
(2311), `rejectAmbiguousCustomToolResultDuplicates` (2441),
`findPersistedCustomToolResult` (2459), `listCustomToolHistory` (2479),
`customToolTerminalizationRows` (648), `blockInterrupted`. Injected deps:
`events`, `broadcaster`, `runtimeRunner`, `isClosedOrDeleted` (see above).

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
`runtimeTranslator`, `isClosedOrDeleted`.

> **Cohesion caveat (review):** `persistMcpToolResult` (2247) and
> `persistMcpConnectionFailed` (2279) carry **no** confirmation/pending state
> (turnState `running` only) — they are MCP *transcript persisters*, not
> confirmations. Parking them in `ToolConfirmations` is a naming smell, not a
> correctness issue; acknowledge it or split them into an `mcp-transcript.ts`
> if the file earns it. Does not affect the seam.

### 4.4 Atomic cross-concern persist — a hard constraint, not an option

`sendInternal` composes **one** batch across *both* concerns:
`customToolTerminalizationRows` (394) and `toolConfirmationTerminalizationRows`
(401) mutate the **same** `runtimeChanges` object by reference; live custom
acknowledgedActions are pushed at 408-416; then a **single**
`persistRuntimeChangesCompleteIdempotencyAndPublish` (424-435) commits
everything **and** completes the idempotency key atomically (ADR-0015, comment
at 258-259). Therefore the terminalization row-builders MUST remain
**fragment-producers** — return rows + mutate a shared `runtimeChanges` — and
must **not** persist on their own. An implementer who reads "collaborator owns
persist" and lets each collaborator commit its own terminalization **splits the
atomic batch and breaks `sendIdempotent` atomicity**. This is a constraint, not
a design choice.

---

## 5. How each coupling stays correct across the boundary

**C1 (flush coalescing).** `flushPendingActions` stays in the **service** as the
coordinator; it becomes:
```
const ids = [...customTools.snapshotForFlush(key), ...confirmations.snapshotForFlush(key)];
if (ids.length) publish one session.status_idle{requires_action, event_ids: ids};
```
The single-event contract is preserved because the merge/publish never leaves
the service. Collaborators expose `snapshotForFlush`; they do **not** each publish.

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

### 5.1 The real hard problem — turn-lifecycle entanglement in the claim methods

**This is the riskiest part of the refactor and the first draft under-analyzed
it.** The claim methods are *not* "persistence + decision only" — they perform
load-bearing **mutations mid-scan** that the decision itself depends on:

- `claimCustomToolResults` calls `claimTurnForTerminalization(action.turn)`
  inline at **2371** and **2413**; a failed claim throws `runtimeTurnStillOwned`
  (2373/2414) and a successful claim is *what authorizes* the `kind:"terminalize"`
  claim it returns. The decision depends on having already mutated the turn store.
- `claimToolConfirmations` is worse: at **2589** it calls
  `terminalizeLostToolConfirmation` → `persistRuntimeDrafts`, which **writes
  events and publishes, inline, during the claim scan** — a full persist mid-
  decision. It also calls `claimTurnForTerminalization` at **2576** and **2604**.

So "return a pure decision, let the service terminalize later" (the first
draft's preferred option a) is **not feasible as stated** — you cannot cleanly
lift the decision out of its side effects.

The **one** genuinely shared helper is `claimTurnForTerminalization` (1041),
also called by the recovery path (`recoverAbandonedRuntimeTurns`, 972 — *not*
`terminalizeAbandonedRuntimeTurn`/`scheduleAcceptedTurnRecovery`, which the
first draft misattributed; and `claimAcceptedTurn`/`promptsFromAcceptedTurn` are
recovery-only, never called by the claim paths). So the real choice is:

- **(b) inject `claimTurnForTerminalization` into both collaborators.** Honest,
  smallest surgery: the shared helper stays defined in `service.ts` (still used
  by recovery) and is passed in. Collaborators keep their claim logic intact,
  side effects and all. **Recommended.**
- **(c) scan/apply split.** Split each claim method into a pure *scan* (reads +
  throws only) and a separate *apply* the service drives. This is real surgery
  on 2311-2439 and 2498-2625 — a rewrite, not a move — and would also have to
  relocate the inline `terminalizeLostToolConfirmation` persist (2589) out of the
  scan. Higher risk; only worth it if the scan/apply seam pays off elsewhere.

**Decision required before Slice 2 (this is the §5.1 sign-off gate).** Default
to (b) unless there's appetite for (c)'s rewrite. Re-cost Slice 2 for whichever:
it is not the "clean either/or" the first draft implied.

---

## 6. Verification

Baseline (at `40917ed`, this worktree): **80 tests green in ~2s, no docker**,
across the six *machine* suites `custom-tools-api`, `tool-confirmation-api`,
`mcp-events-api`, `session-events-api`, `session-events-idempotency-api`,
`runtime-events-api`. **But three of the external-caller guards below live
OUTSIDE those six** — the run set for Slice 2 MUST additionally include
`session-interrupt-api` and `session-lifecycle-api` (review correction; the
"80/six suites" figure alone does not cover the archive/delete/interrupt
cleanup paths §3 calls out).

Map of coupling → guarding test → suite (must stay green, unchanged assertions):
- C1 → *"re-emits requires_action with all pending IDs when a second tool wait
  arrives later"*; *"does not keep stale requires_action IDs after a
  runtime-side tool failure"* → `mcp-events-api` / `custom-tools-api`.
- C2 (confirmation/MCP terminalization — the correct guards) → the
  `tool-confirmation-api` lost-runtime tests exercising `lostToolConfirmation­
  ResultDraft` and the builtin/MCP result-family split, **and** *"ask flow:
  requires_action lists the mcp use id, allow resumes, replay is idempotent"*
  (`mcp-events-api`). *(The first draft mis-led with a custom-tool terminalize
  test, which never touches `lostToolConfirmationResultDraft`.)*
- lifecycle guard / release-close (§4.2-4.3 new deps) → add new regressions:
  late tool-use/result after archive+delete is dropped; released actions closed
  durably not just un-pended. *(No existing test isolates these — write them.)*
- external callers → *"rejects custom_tool_result after interrupt retires the
  pending custom tool"* (`session-interrupt-api:153`); *"archives a session
  paused on custom-tool requires_action"* (`session-lifecycle-api:301`);
  *"deletes a session paused… without accepting stale results"*
  (`session-lifecycle-api:338`).

Rule: **no test assertion is edited.** If a test needs changing, the refactor
changed behavior — stop and reassess. **Constructor signature must stay
byte-identical** — `custom-tools-api`, `tool-confirmation-api`,
`session-events-idempotency-api`, and `runtime-events-api` `new
DefaultSessionEventsService(...)` directly, so "no public API change" extends to
the constructor (incl. the optional-runtime shape at 212-239). Typecheck
(`src/` clean today; the 11 `scratch/*` errors are pre-existing and unrelated).

---

## 7. Slicing

- **Slice 1 — `PendingActionStore`.** Extract substrate; instantiate twice;
  `flushPendingActions` reads both instances. ~110 dup lines → ~70-line class.
  Low risk, fully guarded by C1 + external-caller tests. Ships as its own PR.
- **Slice 2 — `CustomToolActions` + `ToolConfirmations`, extracted TOGETHER.**
  The god-class break. Depends on Slice 1. Resolve §5.1 (b vs c) first; wire the
  §4.2-4.3 lifecycle-guard + release-close deps and the §4.4 atomic-persist
  constraint. **Do NOT land the custom-only sub-slice on its own** (review):
  if `CustomToolActions` extracts while confirmations stay inline,
  `flushPendingActions`/C1 straddles a collaborator boundary on one side and a
  raw map on the other — the cross-store atomic drain spans two abstraction
  levels, an intermediate arguably *worse* than either endpoint. Extract both,
  or keep flush coordination trivially symmetric across the transition.

Slice 1 is a strict improvement on its own — if Slice 2 never lands you have
~70 lines of dedup and nothing broken (not a worse half-refactored state). It
is the shared foundation Slice 2 composes.

---

## 8. Risks

- **Delete-timing drift (C1 substrate).** Three different delete conditions
  across `remove` (guarded), `clear` (unconditional), `snapshotForFlush` (empty-only
  post-timer-clear) — see corrected §4.1. Easy to flatten by accident; a leaked
  empty entry is silent (the requires_action tests catch gross breakage, not a
  stale entry). Port each verbatim; add the `PendingActionStore` clear-with-timer
  unit test.
- **`recordCompleted` timing (490).** The completed cache is written *after*
  commit in `sendInternal`. Moving it behind `confirmations.recordCompleted`
  must keep that ordering (post-commit) or replay/idempotency shifts.
- **Injected `runtimeRunner`/`runtimeTranslator` are `| undefined`** (runtime is
  optional in the constructor, 216-217). Collaborators must tolerate the
  no-runtime construction the tests exercise.

---

## 9. Disposition log

Four independent review passes, 2026-07-09: Codex native, Codex adversarial,
Opus (adversarial), Sonnet (correctness). Consensus verdict: **seam is right,
proceed with named changes.** MCP-rides-confirmations, `PendingActionStore`, C1,
and C3 all verified against code; "no assertion edited" achievable. Findings and
dispositions:

| # | Finding | Raised by | Severity | Disposition |
|---|---|---|---|---|
| 1 | §5.1 option (a) infeasible — claim methods mutate turn state (2371/2413/2576/2604) & persist inline (2589) mid-scan | Opus | HIGH | **Accepted.** §5.1 rewritten: (a) dropped; choose (b) inject `claimTurnForTerminalization` [recommended] or (c) scan/apply rewrite. Sign-off gate before Slice 2. |
| 2 | Collaborator contract omits archive/delete lifecycle guard (`closedSessions`/`deletedSessions`, 1883-1884) | Codex adv | HIGH | **Accepted.** §4.2-4.3 add injected `isClosedOrDeleted`; new post-archive/delete regressions. Verified in code. |
| 3 | Contract omits durable release-close (`closeReleasedRuntimeAction`, 1844, bound at 1901-1911 alongside pending-remove) | Codex adv | HIGH | **Accepted.** §4.2-4.3 added; new released-action-closed regression. Verified in code. |
| 4 | Atomic idempotency-completing persist (424-435) unmodeled; row-builders must stay fragment-producers | Opus | MED-HIGH | **Accepted.** New §4.4 states it as a hard constraint. |
| 5 | `clear` deletes unconditionally; only `remove` is guarded (§4.1 prose contradicted its own stub) | all four | MED | **Accepted.** §4.1 corrected to three distinct delete conditions + unit test. |
| 6 | Baseline omits `session-interrupt-api` + `session-lifecycle-api` where 3 cited guards live | Codex native, Opus, Sonnet | MED | **Accepted.** §6 run set extended; guards mapped to real suites/lines. |
| 7 | Custom-only sub-split of Slice 2 straddles flush across a collaborator + raw map | Opus | MED | **Accepted.** §7 hard-gates it: extract both collaborators together. |
| 8 | C2 guard mis-mapped to a custom-tool terminalize test (never hits `lostToolConfirmationResultDraft`) | Codex native | P3 | **Accepted.** §6 C2 remapped to `tool-confirmation-api` lost-runtime tests. |
| 9 | §5.1 caller attribution over-broad (only `claimTurnForTerminalization` shared; caller is `recoverAbandonedRuntimeTurns` 972/925, not the two named) | Sonnet | low | **Accepted.** §5.1 narrowed. |
| 10 | `snapshotForFlush` spec "null the timer" too loose — needs `clearTimeout` + `= undefined` | Opus | low | **Accepted.** §4.1 spec tightened. |
| 11 | Constructor must stay byte-identical (4 suites construct directly) | Opus | low | **Accepted.** §6 requires constructor byte-stability. |
| 12 | `runtimeRunner` needed as a *reference* — claim branches on `?.claimCustomToolResult` existence (2405) | Opus | low | **Accepted.** §4 dep note added. |
| 13 | `persistMcpToolResult`/`ConnectionFailed` carry no confirmation state — cohesion smell under `ToolConfirmations` | Opus | nit | **Noted.** §4.3 caveat; optional `mcp-transcript.ts` split. No correctness impact. |
| 14 | C1 is the *safest* coupling, not the riskiest — no double/lost flush constructible; doc's risk profile was inverted | Opus | (reframe) | **Accepted.** §3 risk note added; worry re-pointed at §5.1. |
| — | MCP-rides-confirmations thesis; C3 asymmetry; all §2/§3/§4 line numbers; two pending-store shapes byte-identical; `hasToolResultForToolUseId` MCP match; 80-test baseline | Opus, Sonnet | — | **Confirmed accurate** against code — no change. |

**Net effect on the plan:** seam unchanged; collaborator *contract* gained two
dependencies (lifecycle guard, release-close) + one hard constraint (atomic
persist); §5.1 re-scoped from "easy either/or" to the genuine sign-off gate;
verification set widened by two suites + three new regressions. Slice 1
unaffected and still safe to build first.

### Slice 1 implementation review (2026-07-09)

Slice 1 (`PendingActionStore`, PR #169) reviewed adversarially by Opus and for
correctness by Sonnet (Codex was unavailable — CLI pinned to an unreleased
model). Verdict: **behavior-preserving extraction, ship as-is.** All 5 methods,
~20 call sites, and `flushPendingActions`'s merge/guard/payload semantics
verified byte-equivalent to `main`; 112 tests green; no orphaned timer can fire
against a deleted entry (every delete path clears or requires an unset timer).
Three low-severity fixes folded in before merge: (a) `drainForFlush` →
**`snapshotForFlush`** — the name implied it consumed the ids, which would
mislead Stage 2 callers relying on the re-emit-full-set contract (spec above
updated); (b) hardened the store unit test's "entry survives armed timer" case
to prove no orphaned double-timer (the original assertions passed against a
buggy eager-delete); (c) made the `session-lifecycle` white-box seed carry
`workspaceId` to match the real entry shape.
