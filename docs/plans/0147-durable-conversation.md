# 0147 — Durable conversation (ADR 0018 stage 1)

## Status

Design, 2026-10-08. Not started. Implements stage 1 of
[ADR 0018](../adrs/0018-session-durability-and-parking.md) and fixes #265. It is
an M2 item in [0145](0145-road-to-external-testers.md).

## Problem

`PiSessionRunner` builds each Pi session with `SessionManager.inMemory()` and
no prior entries, and nothing rebuilds it. After the 15-minute idle eviction,
or any restart, the next `user.message` reaches a model that remembers none of
the session. The event log (durable with `OMA_SQLITE_PATH`) still shows the
full history, so the client and the model disagree.

## Goal and non-goals

**Goal:** the model sees the same conversation after eviction or restart as
it would have without one.

**Non-goals (later ADR 0018 stages):**
- the workspace filesystem across sandbox disposal (stage 2);
- resumable `requires_action` waits and parking (stage 3, with #260 and #254);
- steered messages still in Pi's in-memory queue at a crash (#254).

## Pi facts this design relies on (0.85.1; verified by reading the source)

1. **Entries are append-only.** A session is a header plus `SessionEntry`
   records (messages, model and thinking-level changes, compaction, custom
   entries). Every append goes through `SessionManager._appendEntry`.
   `getHeader()` and `getEntries()` expose them; no internals are needed.
2. **Seeding.** `SessionManager.inMemory(cwd, options, entries)` loads stored
   entries through `_loadEntries`, which runs `migrateToCurrentVersion`. So
   entries written by an older Pi are upgraded on load. This matters for the
   Pi 1.x decision (#249).
3. **Write order.** `AgentSession._handleAgentEvent` notifies listeners
   *before* it calls `sessionManager.appendMessage` for a `message_end`. OMA's
   listener only queues events and the events service handles them after a
   microtask hop, so the append has normally happened by then. The design must
   not depend on that; see "Checkpointing".
4. **Context building.** `buildSessionContext()` turns entries into the
   messages the model sees, respecting compaction. Rebuild gets Pi's own
   semantics for free.

## Design

### Storage: a conversation table next to the event log

- Add `session_conversation_entries` to the **event store's** database, keyed
  by `(workspace_id, session_id, seq)`. Columns: `entry_id` (unique per
  session), `entry_json`, `pi_version`, `created_at`. The Pi session header is
  stored as the first row.
- Living in the event store means:
  - checkpoints can commit in the same SQLite transaction as event rows;
  - `deleteForSession` removes the conversation together with the events;
  - durable mode (`OMA_SQLITE_PATH`) and memory mode both work unchanged.
    Memory mode survives idle eviction but not a restart, as before.
- Append is idempotent on `(workspace_id, session_id, entry_id)`, so
  re-draining an already-saved entry is a no-op.

### Checkpointing: drain with the event batch

- The runner keeps, per handle, the index of the last entry it handed out, and
  exposes `drainConversationEntries(workspaceId, sessionId): FileEntry[]`,
  which returns entries appended since then.
- When the events service persists a batch of runtime rows for a session, it
  drains and writes the new entries **in the same transaction**
  (`appendBatchWithRuntimeChanges` gains an optional `conversationEntries`).
- At turn end (after `agent_end`, in the turn-close path) it drains once more,
  so entries appended after the last event batch, such as a trailing
  compaction, are not left behind.
- Batches the service drops (closed or deleted session) drain nothing.

**Invariant:** the stored conversation is never *ahead* of the event log.
After a crash it can lag by at most the entries appended after the last
committed batch. Normally that's none; at worst it's the final message.

### Rebuild: seed on every cache miss

- `getOrCreateHandle` loads the stored entries. If there are any, it builds
  the Pi session from `SessionManager.inMemory(cwd, undefined, entries)`
  instead of a fresh one, then starts the drain cursor at the end.
- The first turn of a new session stores the header and its entries through
  the normal drain.

### Repair before seeding

Stored entries can end in a state the model API rejects or that misleads:

- **Dangling tool calls.** An assistant message whose `toolCall`s have no
  matching `toolResult`: a crash mid-tool, or a restart while waiting on
  `requires_action` (until stage 3). Before seeding, append a synthetic error
  `toolResult` for each, worded like the event log's lost-runtime result
  (`lostToolConfirmationPayload` and friends), so the model and the client see
  the same outcome. These repair entries are stored through the normal drain.
- **Model, provider or tools changed.** The session is pinned to its agent
  version, and rebuild uses that revision, so no repair is needed. Covered by a
  test.

### Workspace reset (until stage 2)

A rebuilt conversation can refer to files a fresh sandbox no longer has. See
decision D2.

### Delete and archive

- `deleteForSession` deletes conversation rows in the same statement group.
- Archive keeps them, as it keeps events.

## Decisions needed

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | Checkpoint consistency | (a) drain into the same transaction as each event batch, plus a turn-end drain; (b) the runner writes on its own, outside event transactions | **(a):** the conversation can never be ahead of the event log, and it costs one optional field on an existing batch call |
| D2 | Tell the model when the workspace was reset? | (a) on rebuild into a fresh sandbox, append a hidden custom message such as "The sandbox was recreated; files from earlier in this session may be gone"; (b) say nothing | **(a) until stage 2.** It's honest to the model and avoids it confidently referring to missing files. It is model context, not a wire event; recorded in PARITY as a temporary divergence |
| D3 | How tests reach Pi's faux provider | (a) add `@earendil-works/pi-ai` as a dev dependency pinned to the exact version Pi already depends on (0.85.1, already in the lockfile); (b) import the nested path; (c) fakes only | **(a):** real-Pi tests without network, with no new third-party code. The lockfile-age check applies |

## Slices

1. **Store:** the table, append (idempotent), list, and delete with the
   events. Unit tests.
2. **Drain and checkpoint:** the runner cursor, `drainConversationEntries`,
   transactional writes in the events service, and the turn-end drain.
3. **Rebuild and repair:** seed on cache miss, dangling tool-call repair, and
   the D2 note.
4. **Docs:** close #265, update the 0.2.0 known issue in the next changelog,
   and PARITY.

## Tests (each fails for one reason)

Real Pi with the faux provider (D3), driven through the events service:

- **Eviction:** after idle eviction, the next turn's model request contains
  the earlier user and assistant messages.
- **Restart:** with a file-backed event store, a new service and runner on the
  same file rebuild the conversation.
- **Dangling tool call:** a stored conversation ending in an unanswered tool
  call rebuilds with a lost-runtime `toolResult`, and the provider accepts the
  request.
- **Never ahead:** a batch the service drops (for example after delete)
  stores no conversation entries.
- **Drain completeness:** entries appended after the last event of a turn (a
  turn-end compaction) are stored.
- **Delete:** deleting a session removes its conversation rows.
- **Write order (Pi fact 3):** pin whether the `message_end` entry is present
  when the service drains it. If the order ever changes, only the turn-end
  drain catches it, and this test says so.

Plus store unit tests: idempotent append, ordering, isolation by session.

## Risks

- **Pi entry format across Pi upgrades:** mitigated by fact 2 (migration on
  load) and by storing `pi_version`. Plan the Pi 1.x upgrade (#249) with a
  load test of stored entries.
- **Storage growth:** the conversation roughly duplicates the event log's
  content. Same data class, same database, deleted together. Retention is out
  of scope.
- **Rebuild cost:** loading a long conversation on each cache miss. Measure
  with the eviction test, and add a cap only if needed.
- **Secrets:** the conversation holds the same tool outputs as the event log,
  and no new secret class. The threat model needs only a sentence.

## Review checklist

- Can the stored conversation ever be ahead of the event log? (D1 invariant)
- Does every model request after a rebuild satisfy tool-call and result
  pairing?
- Does a closed or deleted session ever get conversation rows written?
- Do interrupt and hard-error eviction leave the conversation in a state that
  rebuilds cleanly?
