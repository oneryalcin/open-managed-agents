# 0147 — Durable conversation (ADR 0018 stage 1)

## Status

Design accepted 2026-10-08 (decisions below). Implementation not started. Implements stage 1 of
[ADR 0018](../adrs/0018-session-durability-and-parking.md) and fixes #265. It is
an M2 item in [0145](0145-road-to-external-testers.md).

**Revised twice after review.** Two Codex adversarial passes and an
independent real-Pi review took apart the first two designs. Both saved the
conversation *during* a turn, alongside the event batches (first a plain
drain, then watermarked checkpoints). Every version had to thread through the
runner's event queue, its gating and coalescing of tool events, disposal, and
turn ownership. Each fix exposed another race in that machinery, the same
territory as #260. This version saves the conversation **only when a turn has
fully settled**, inside the turn-close transaction that is already fenced by
turn ownership. It trades away mid-turn crash fidelity for a design with no
in-flight state. The review log at the end records each finding.

## Problem

`PiSessionRunner` builds each Pi session with `SessionManager.inMemory()` and
no prior entries, and nothing rebuilds it. After the 15-minute idle eviction,
or any restart, the next `user.message` reaches a model that remembers none of
the session. The event log (durable with `OMA_SQLITE_PATH`) still shows the
full history, so the client and the model disagree.

## Goal and non-goals

**Goal:** after eviction or restart, the model sees the conversation it would
have seen without one. After a crash mid-turn, the in-progress turn is
missing from the conversation (bounded to that one turn), and the model is
told about it.

**Non-goals (later ADR 0018 stages):**
- the workspace filesystem across sandbox disposal (stage 2);
- resumable `requires_action` waits and parking (stage 3, with #260 and #254);
- steered messages still in Pi's in-memory queue at a crash (#254).

## Pi facts this design relies on (0.85.1; verified in source and by experiment)

1. **Entries are append-only.** A session is a header plus `SessionEntry`
   records. Every append goes through `SessionManager._appendEntry`, and
   `getHeader()` / `getEntries()` expose them.
2. **Seeding works.** `SessionManager.inMemory(cwd, options, entries)` loads
   entries through `_loadEntries`, which runs `migrateToCurrentVersion`, and
   `createAgentSession` seeds the agent's messages from them.
   - In the experiment, a rebuilt session kept its Pi session id (good for
     prompt caching), appended nothing on rebuild, and the model saw
     `[user, assistant, new user]`.
3. **Write order.** `AgentSession._handleAgentEvent` notifies listeners and
   *then* appends the `message_end` entry, with no `await` in between. Pi does
   **not** wait for OMA: OMA's listener only queues, so Pi can run ahead of the
   events service by several events. That's why the design saves only at
   settled points, never mid-turn.
4. **Context building.** `buildSessionContext()` respects compaction.
5. **The provider request is normalised.** pi-ai's `transformMessages` drops
   aborted and errored assistant messages and fills in `"No result provided"`
   error results for unanswered tool calls when it builds each request. Live
   and rebuilt sessions go through the same transform, so stored aborted or
   errored turns do not make requests invalid.
6. **Some tool outcomes reach the event log first.** Pi emits
   `tool_execution_end` (which OMA persists as `agent.tool_result`) before it
   appends the `toolResult` message. In a parallel batch the result messages
   are appended only after the whole batch finishes. A crash in between leaves
   a completed tool in the event log that is missing from the conversation.
   The model would then see Pi's `"No result provided"`.
7. **Restart recovery does not duplicate user messages.** Recovery re-runs
   only `accepted` turns. A turn is marked `dispatching` (committed) before
   `runUserMessage`, and Pi appends the user entry only when the run starts.

## Design

### Storage: a conversation table next to the event log

- Add `session_conversation_entries` to the **event store's** database, keyed
  by `(workspace_id, session_id, seq)`. Columns: `entry_id` (unique per
  session), `entry_json`, `turn_id` (the turn whose settlement saved it),
  `pi_version`, `created_at`. The Pi header is the first row.
- Append is idempotent on `(workspace_id, session_id, entry_id)`.
- `deleteForSession` removes the conversation with the events. Archive keeps
  both.
- Durable mode and memory mode work unchanged. Memory mode survives idle
  eviction but not a restart.

### Checkpoint: once per settled turn, in the fenced turn-close transaction

1. **Settled point.** `runOnSession` finishes only after `await run`, that is
   after Pi's `prompt()` has resolved, including post-run compaction and any
   steered continuation. Its queue is drained by then. So when the runner's
   generator is about to finish normally, Pi has no in-flight work and every
   event has been yielded.
2. **Settled event, from the owning run only.** At that point, before the
   existing `closeWhenIdle` eviction, the runner yields one internal
   `oma.conversation_settled` event. It carries the entries appended since the
   last *acknowledged* checkpoint and a `release(committed)` callback. It is
   emitted only
   by the generator whose `prompt()` actually ran the Pi turn, never by the
   losing side of the prompt race (`queuedOnRunningTurn`) or the steer path,
   which would otherwise save the winner's partial entries under the wrong
   turn's fence.
3. **The handle stays alive until the checkpoint is released.**
   `handle.running` clears at `agent_end`, but Pi's post-run work (retry,
   compaction, steered continuation) runs after that, and the service may
   still be processing queued events.
   - A **set of hold tokens** per handle, not a boolean. Every `runOnSession`
     that enters the fresh-prompt path adds a token. Idle eviction,
     `closeWhenIdle` eviction, handle replacement and `close()` shutdown wait
     while the set is non-empty.
   - A boolean is wrong here: the loser of the prompt race also starts a
     `prompt()`, and after an interrupt a new turn can start while the old
     turn's close is still pending.
   - A token is removed in exactly two ways. The service calls
     `release(committed)` from a `finally` on **every** exit after consuming the
     settled event: commit, rollback, `RuntimeTurnOwnershipLostError`, or a
     skipped close for a closed or deleted session. Otherwise the runner
     removes it itself when its generator ends without settling (loser of the
     prompt race, hard error).
   - `release(true)` also advances the acknowledged cursor, monotonically, to
     the **endpoint captured when the settled event was emitted**, never to
     the live entry count. A newer run may already have appended entries that
     were not in the committed batch. `release(false)` keeps the entries for
     the next settled turn.
   - `interruptSession`, `closeSession`, archive and delete keep evicting
     unconditionally; holds never block them.
   - Today this race already disposes handles during post-run compaction; the
     token set fixes it as part of this plan.
4. **Fenced write.** The conversation write is fenced on **turn ownership**
   (owner and generation match the turn row), not on this call being the one
   that closes the turn. So a turn this owner already closed (for example
   `interrupted` by `maybeInterruptRuntime`) still gets its settled entries
   saved, while a stale owner's write is still rejected. For such a turn the
   service sends a checkpoint-only batch without `closedTurns`, since closing
   it again would throw. Checkpoints go straight to the event store, like the
   turn close, never through the runtime event coordinator: its fence accepts
   only pending turns, and it rejects batches carrying checkpoints. Otherwise: The service holds those entries and writes them in the
   **same** `appendBatchWithRuntimeChanges` call that closes the turn, as a new
   `conversationEntries` change applied after `closedTurns`. The turn close is
   owner- and generation-fenced (`closeRuntimeTurnStmt`, which throws
   `RuntimeTurnOwnershipLostError`), so the conversation commits only if this
   owner legitimately closes the turn. A closed or deleted session is skipped,
   as turn close already is.
5. **Acknowledge after commit.** Only `release(true)` advances the cursor,
   and the service calls it only after the transaction commits. On rollback the
   runner keeps the entries and offers them again with the next settled turn of
   that handle.
6. **Nothing else writes.** No checkpoint happens mid-turn, on disposal, on
   hard error, or on `close()`. Those paths don't reach a settled point, so
   their turn is not saved (see "Crash and failure behaviour").
7. **Interrupt settles.** `abort()` resolves `prompt()`, so an interrupted turn
   reaches the settled point and its aborted assistant entry is saved (Pi
   drops it from requests; fact 5). When the turn was already closed
   `interrupted` by `maybeInterruptRuntime`, the ownership fence (step 4)
   still saves its entries, including messages steered into it. A deliberate
   interrupt is never reported to the model as cut off.

The steer path's second runtime task (#245) runs no Pi turn of its own, so it
yields no settled event. The owning task's settled event includes the steered
messages.

### Why no in-flight state

- Never ahead of the event log: the checkpoint commits with the turn close,
  after all of the turn's event rows.
- No stale owner writes: the write sits inside the ownership-fenced close.
- No disposal race: eviction waits for the hold set to empty, which happens
  only after the service's `release`; other disposals write nothing.
- No watermarks, coalescing or gating accounting.

### Crash and failure behaviour

If a turn does not settle normally (process crash, hard runtime error,
ownership loss, close mid-turn), the stored conversation ends at the previous
settled turn. The event log still has that turn's rows and its terminal
`session.error`. On the next rebuild the model would not see that turn's user
message or partial work, so rebuild adds the D2 note, quoting the unanswered
user message(s).

A paused `requires_action` turn has not settled, so a restart loses its
progress. That is unchanged from today and is ADR 0018 stage 3.

### Rebuild

- On a cache miss, `getOrCreateHandle` loads stored entries. If there are
  any, it builds the Pi session from `SessionManager.inMemory(cwd, undefined,
  entries)`, and the acknowledged count is the loaded count.
- **Unclean end, by content coverage rather than turn order.** The event store
  computes it, because it has the event log and the turn ledger; the runner's
  `getOrCreateHandle` has no trigger ids. The store's load call returns
  `{ entries, uncovered }`.
  - **Candidates:** `user.message` events that actually dispatched a prompt.
    Their dispatched text is `textFromContent(content)` (text blocks joined
    with newlines and trimmed). Image-only or whitespace-only messages never
    reach Pi and are not candidates.
  - **Excluded:** trigger events of turns still pending (they are about to be
    delivered, including the one starting now), and of turns closed
    `interrupted` (a deliberate interrupt).
  - **Matching:** walk candidates and stored user entries in order, comparing
    dispatched text. Candidates left unmatched are uncovered: their turn never
    settled.
  - Turn order would mislabel steered messages: they belong to the earlier
    turn's checkpoint, not their own runtime turn. Duplicate texts still match
    correctly because matching is in order.
- **Notes are idempotent.** A D2 note is added through Pi's custom-message
  entry, which the model sees as a user message and the next checkpoint saves.
  Rebuild skips a note when an identical one is already the last note entry,
  so repeated rebuilds don't pile them up.
- No tool-result repair (Pi fact 5).

## Decisions

**Decided 2026-10-08 (maintainer): D1 (a), D2 (a), D3 (a)**, as recommended
below.

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | When to save the conversation | (a) once per settled turn, in the ownership-fenced turn-close transaction; (b) during the turn, alongside event batches, with watermarks and commit acknowledgement | **(a).** No in-flight state, so none of the queue, coalescing, disposal or ownership races that two review rounds found in (b). Cost: a crash mid-turn loses that turn from the conversation, covered by the D2 note |
| D2 | Tell the model when continuity is incomplete? | (a) on rebuild, add a hidden custom message: always "the sandbox was recreated; files from earlier may be gone" (until stage 2), plus, after an unclean end, "your previous turn was cut off by an error or restart before it finished. The user had asked: <message>. Its partial work, including tool calls, may or may not have taken effect; check before repeating anything"; (b) say nothing | **(a).** Without it, the model loses the interrupted request entirely and may repeat side effects. The note is model context, not a wire event; PARITY records it as a temporary divergence |
| D3 | How tests reach Pi's faux provider | (a) dev dependency `@earendil-works/pi-ai` pinned to the exact version Pi already uses (0.85.1, in the lockfile); (b) the nested import path; (c) fakes only | **(a):** real-Pi tests without network and with no new third-party code. Note `registerProvider` needs an `apiKey` |

Rejected alternative to D2's unclean-end note: rebuild the interrupted turn
from the event log. That needs the Pi-to-public tool id mapping (today only in
memory) persisted, plus converting event payloads back into Pi messages. It's
a lot of machinery for a crash-only window, and stage 3 reworks turn
persistence anyway.

## Slices

1. **Store:** the table, idempotent append, list, delete with events, and the
   `conversationEntries` change applied after `closedTurns` in the same
   transaction. Unit tests.
2. **Settled checkpoint:** the runner's settled event with `ack`, and the
   service writing it in the turn-close call.
3. **Rebuild:** seed on cache miss, unclean-end detection, and the D2 notes.
4. **Docs:** close #265; changelog; PARITY divergences.

## Tests (each fails for one reason)

Real Pi with the faux provider (D3), through the events service unless noted:

- **Eviction:** after idle eviction, the next model request contains the
  earlier user and assistant messages.
- **Restart:** a new service and runner on the same file-backed store rebuild
  the conversation.
- **Settled only:** no conversation rows exist for a turn while it is still
  running (gate the faux model mid-turn and inspect the store).
- **Post-run work included:** entries Pi appends after `agent_end` (auto
  compaction) are in the settled checkpoint.
- **Steered message included:** a message steered into a running turn is in
  that turn's checkpoint, and after eviction the next rebuild adds **no**
  unclean-end note for it.
- **Prompt race:** with two concurrent first sends, the losing task saves and
  acknowledges nothing; only the owning run's checkpoint is written.
- **No eviction before settle:** eviction attempted during gated post-run
  compaction, and while the service is stalled on output indexing, waits until
  the checkpoint is acknowledged.
- **Fenced:** when the turn close throws `RuntimeTurnOwnershipLostError`, no
  conversation rows are written and the entries are offered again on the next
  settled turn.
- **Release on every exit:** after a rolled-back close, and after a skipped
  close for a deleted session, the handle's hold set is empty and idle
  eviction proceeds.
- **Overlapping runs:** an interrupt followed by a new message while the old
  turn's close is still pending keeps the handle held until both release.
- **Interrupt is not an unclean end:** after an interrupt and eviction, the
  rebuild adds no cut-off note. This includes a paused owner with a message
  steered into it before the interrupt.
- **Cursor endpoint:** a release after a newer run has appended entries
  advances the cursor only to the released checkpoint's endpoint.
- **Undispatched and pending messages:** an image-only message, and a message
  whose turn is still pending at rebuild, produce no cut-off note.
- **Notes don't pile up:** two rebuilds in a row leave one workspace note.
- **Closed or deleted session:** no conversation rows are written.
- **Delete:** deleting a session removes its conversation rows.
- **Unclean end:** after a turn that ends in a hard error, the next rebuild's
  model context contains the D2 note quoting the unanswered user message.
  Assert on the seeded messages (or `transformMessages` output), not on the
  faux provider accepting the request, because faux never calls
  `transformMessages`.
- **Workspace note:** a rebuild into a fresh sandbox includes the D2 workspace
  note, and a session that was never evicted does not.

Plus store unit tests: idempotent append, ordering, isolation by session.

## PARITY divergences to record

- D2 notes (temporary, until stage 2/3).
- Pre-existing: the translator emits `agent.message` for an aborted
  assistant's partial text, which the model never sees (Pi fact 5).
- Pre-existing: a turn closed after a crash leaves an unanswered user message;
  the model sees consecutive user turns, the client sees `session.error`.
  D2's note explains it to the model.

## Risks

- **Pi entry format across upgrades:** mitigated by migration on load (fact 2)
  and the stored `pi_version`. Plan the Pi 1.x upgrade (#249) with a load test.
- **Storage growth:** roughly duplicates the event log's content; same data
  class, same database, deleted together. Retention is out of scope.
- **Rebuild cost:** loading a long conversation on each cache miss; measure in
  the eviction test, and add a cap only if needed.
- **Secrets:** same tool outputs as the event log; no new secret class.

## Review log

- **Codex adversarial, 2026-10-08:**
  - unrestricted drain can save ahead of queued events → watermarks;
  - the cursor acknowledged before commit → acknowledge after commit;
  - a missing result doesn't mean a lost outcome → no blanket repair, D2
    unclean-end note;
  - repairing aborted calls makes orphan results → dropped (Pi fact 5);
  - the turn-end drain ran after disposal → tail event and disposal flush.
- **Independent review (Fable, real-Pi experiments), 2026-10-08:**
  - wrong hook method → `RuntimeTurnEventCommit` /
    `appendBatchWithRuntimeChangesInTransaction`;
  - acknowledge after commit (agrees);
  - eviction race (agrees);
  - the repair test was vacuous with faux → assert on `transformMessages`;
  - recovery does not duplicate user messages (fact 7);
  - two PARITY divergences.
  - It also judged the first draft's invariant sound; that assumed the service
    keeps pace with Pi, which fact 3 rules out, so the watermark change stands.
- **Codex adversarial, second pass on the watermark design, 2026-10-08:**
  - coalesced permission/MCP events carry watermarks that cover sibling tool
    calls whose public events are not committed;
  - the disposal flush let a stale owner write after ownership loss;
  - disposal is not a settled point (post-run compaction runs after
    `agent_end`; hard-error eviction can happen while `prompt` still runs).

  Response: replaced in-turn checkpointing with one checkpoint per settled
  turn inside the fenced turn-close transaction. That removes all three
  classes rather than patching each one.
- **Codex adversarial, third pass on the settled design, 2026-10-08:**
  - the losing side of the prompt race also completes normally → settled event
    only from the owning run;
  - eviction can precede settlement because `handle.running` clears at
    `agent_end` → `turnActive` held until acknowledgement (fixes a
    pre-existing race too);
  - turn-order unclean detection mislabels steered messages → content
    coverage.

  These are local conditions, not a new layer; the settled design stands.
- **Final review of the accepted plan, 2026-10-08 (Codex adversarial and
  independent real-Pi review, run on the merged plan):**
  - Confirmed: the end of the owning run is a settled point (steered and
    compaction entries are present when `prompt()` resolves), and every normal
    turn close goes through the fenced transaction.
  - A failed or skipped close left the eviction hold set forever → mandatory
    `release(committed)` on every service exit (both reviewers).
  - A boolean hold is wrong for overlapping runs → token set.
  - Interrupt does settle → saved normally, never reported as cut off.
  - Content coverage false positives (undispatched, multi-block, pending
    turns), and the check can't run in `getOrCreateHandle` → computed by the
    event store using `textFromContent`, excluding pending and interrupted
    triggers (both reviewers).
  - Notes accumulated across rebuilds → idempotent.
- **Focused Codex pass on that revision, 2026-10-08:**
  - `release(true)` must advance only to the endpoint captured at settlement
    → specified, monotonic;
  - a deliberately interrupted turn could lose its entries (and look like a
    cut-off for messages steered into it) because its normal close fails the
    ownership check → the conversation write is fenced on turn ownership, not
    on closing the turn.

