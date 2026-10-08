# 0147 — Durable conversation (ADR 0018 stage 1)

## Status

Design, 2026-10-08. Not started. Implements stage 1 of
[ADR 0018](../adrs/0018-session-durability-and-parking.md) and fixes #265. It is
an M2 item in [0145](0145-road-to-external-testers.md).

**Revised after review:** a Codex adversarial pass and an independent review
with real-Pi experiments. The first draft drained "everything Pi has appended
so far" into each event batch, which can save the conversation *ahead* of the
event log, and acknowledged entries before commit. The revision uses
watermarked, commit-acknowledged checkpoints, hands over the unsaved tail
before disposal, and drops blanket tool-result repair. The review log at the
end records each finding.

## Problem

`PiSessionRunner` builds each Pi session with `SessionManager.inMemory()` and
no prior entries, and nothing rebuilds it. After the 15-minute idle eviction,
or any restart, the next `user.message` reaches a model that remembers none of
the session. The event log (durable with `OMA_SQLITE_PATH`) still shows the
full history, so the client and the model disagree.

## Goal and non-goals

**Goal:** after eviction or restart, the model sees the conversation it would
have seen without one. After a crash, any gap is bounded and the model is told
about it.

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
   events service by several events. That's why checkpoints need watermarks.
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
  session), `entry_json`, `pi_version`, `created_at`. The Pi header is the
  first row.
- Append is idempotent on `(workspace_id, session_id, entry_id)`.
- `deleteForSession` removes the conversation with the events. Archive keeps
  both.
- Durable mode and memory mode work unchanged. Memory mode survives idle
  eviction but not a restart.

### Checkpoints: watermarked, committed with the event batch, acknowledged after

1. **Watermark per queued event.** When the runner's listener queues a Pi
   event, it records `w` = how many entries Pi had at that moment. Entries
   below `w` were appended before the event was emitted, so they belong to
   earlier events. Internal OMA events get the same watermark when queued.
2. **Checkpoint up to the committing batch's watermark.** When the service
   commits a batch for an event with watermark `w`, it includes the
   *unacknowledged* entries below `w` in the same transaction. The entry for
   the event itself is saved with the next batch. So **the stored conversation
   is never ahead of the event log**, and lags it by at most one message.
3. **Acknowledge after commit.** The runner keeps an `acked` index per handle.
   It advances only when the service reports a successful commit. A rolled-back
   transaction (including `RuntimeTurnOwnershipLostError`) leaves the entries
   unacknowledged, and the next checkpoint offers them again; idempotent append
   makes repeats harmless.
4. **One hook for every commit path.** The entries ride on
   `RuntimeTurnEventCommit` and are written inside
   `appendBatchWithRuntimeChangesInTransaction`. That covers the plain batch
   call, the `…AndCompleteIdempotency` variant, and the durable coordinator's
   own transaction (`deployment-runtime-event-coordinator.ts`). The tool-action
   collaborators' persist paths are included.
5. **Tail before disposal.** Entries appended after a turn's last event (for
   example auto-compaction after `agent_end`, which runs inside `prompt()`)
   have no later batch to ride on. Two cases:
   - when the turn completes normally, the runner yields a final internal
     `oma.conversation_tail` event with the watermark set to "all entries", and
     the service commits it in the turn-close transaction;
   - when the runner disposes a handle (`closeWhenIdle`, hard error,
     interrupt, eviction), it first flushes the unacknowledged tail to a
     conversation sink, a direct store write outside any event batch. This
     is safe because the turn has ended and no event remains that could be
     ahead of it.
   - **Stated exception:** if a batch failed (SQLite error or ownership lost)
     and the turn then ended, the flush saves entries whose event rows were
     rolled back. On that failure path the conversation keeps what the model
     actually saw rather than staying strictly behind the event log. The
     client sees the turn's `session.error`.

### Rebuild

- On a cache miss, `getOrCreateHandle` loads the stored entries. If there are
  any, it builds the Pi session from `SessionManager.inMemory(cwd, undefined,
  entries)` and sets `acked` to the loaded count.
- No blanket tool-result repair (Pi fact 5). For **unclean ends**, the rebuild
  adds a note (decision D2). An unclean end is a last assistant message with
  unanswered tool calls, or a trailing user message with no reply (a turn
  closed after a crash).

## Decisions needed

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | Checkpoint consistency | (a) watermarked checkpoints in the event-batch transaction, acknowledged after commit, plus the tail rules; (b) the runner writes on its own, outside event transactions | **(a):** the only option where the conversation can never be ahead of the event log. Cost: one optional field on `RuntimeTurnEventCommit`, a watermark per queued event, and a commit acknowledgement |
| D2 | Tell the model when continuity is incomplete? | (a) on rebuild, add a hidden custom message: always "the sandbox was recreated; files from earlier may be gone" (until stage 2), plus, after an unclean end, "the previous turn was cut off by a restart; tool calls without results may or may not have completed, so check before repeating them"; (b) say nothing | **(a).** Without it, Pi fact 6 lets the model believe a completed tool failed and repeat it (for example a second `git push`). The note is model context, not a wire event; PARITY records it as a temporary divergence |
| D3 | How tests reach Pi's faux provider | (a) dev dependency `@earendil-works/pi-ai` pinned to the exact version Pi already uses (0.85.1, in the lockfile); (b) the nested import path; (c) fakes only | **(a):** real-Pi tests without network and with no new third-party code. Note `registerProvider` needs an `apiKey` |

Rejected alternative to D2's unclean-end note: rebuild the completed tool's
real result from the event log. That needs the Pi-to-public tool id mapping
(today only in memory) persisted, plus converting event payloads back into
Pi's result format. It's a lot of machinery for a crash-only window, and
stage 3 reworks tool waits anyway.

## Slices

1. **Store:** the table, idempotent append, list, delete with events, and the
   `RuntimeTurnEventCommit` field written in
   `appendBatchWithRuntimeChangesInTransaction`. Unit tests.
2. **Checkpoints:** runner watermarks, the acknowledgement API, service
   wiring on every commit path, the tail event and the disposal flush.
3. **Rebuild:** seed on cache miss, unclean-end detection, and the D2 notes.
4. **Docs:** close #265; changelog; PARITY divergences (D2 notes, and the two
   pre-existing ones below).

## Tests (each fails for one reason)

Real Pi with the faux provider (D3), through the events service unless noted:

- **Eviction:** after idle eviction, the next model request contains the
  earlier user and assistant messages.
- **Restart:** a new service and runner on the same file-backed store rebuild
  the conversation.
- **Never ahead:** with the service stalled on one event while Pi runs ahead
  (an awaited output-index call), a simulated crash leaves no stored entry
  beyond the last committed batch's watermark.
- **Rollback:** an event batch whose transaction fails (ownership lost) leaves
  its entries unacknowledged, and a later checkpoint stores them.
- **Tail:** auto-compaction entries appended after `agent_end` are stored,
  both for a normal turn end and when `closeWhenIdle` disposes the handle.
- **Hard error:** entries up to the failure are stored when the runner evicts
  on error.
- **Dropped batch:** a closed or deleted session gets no conversation rows.
- **Delete:** deleting a session removes its conversation rows.
- **Unclean end:** a stored conversation ending in an unanswered tool call,
  and one ending in an unanswered user message, rebuild with the D2 note.
  Assert on `transformMessages` output, not "the provider accepted it": faux
  never calls `transformMessages`.
- **Write order (Pi fact 3):** pin that the `message_end` entry exists after
  the listener returns, so a Pi change to the order fails loudly.

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
