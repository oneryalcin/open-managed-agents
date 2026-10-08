# ADR 0018: Session durability and parking

**Status:** Proposed, 2026-10-08. Decision pending (maintainer). Inputs: #229,
#230, plan [0106](../plans/0106-sandbox-provider-landscape.md) requirement 2,
plan [0145](../plans/0145-road-to-external-testers.md) decisions table.

## Context

Plan 0106 names "indefinite parking on `requires_action`" as an OMA
requirement: a session waiting for a custom tool result or a tool confirmation
should not hold an always-running sandbox. #230 points out that parking is two
problems, compute (stop paying for an idle sandbox) and session (keep the
session's state while nothing runs), and that only the first is a provider
concern.

Reading the code on 2026-10-08 shows the session half is not only a parking
problem; it already affects ordinary idle sessions.

**Facts (main at `163f0b3`):**

1. **The conversation lives only in memory.** `PiSessionRunner` creates every
   Pi session with `SessionManager.inMemory()` and no prior entries
   (`runner.ts`, session factory). Nothing rebuilds it from the event log.
2. **Idle sessions lose the conversation after 15 minutes.** The idle TTL
   (`DEFAULT_IDLE_TTL_MS`) evicts the runtime handle, which disposes the Pi
   session and the sandbox. The next `user.message` runs in a fresh Pi session
   with no history, in a fresh sandbox without the agent's earlier files.
3. **Restarts lose it too, inconsistently.** With `OMA_SQLITE_PATH` the
   control plane's agents, sessions and event log survive a restart, so the
   client sees the full history while the model has none of it.
4. **Waiting sessions never park.** A session paused on `requires_action` has
   an active Pi run (the tool's `execute` is blocked on a promise, per
   [ADR 0005](0005-custom-tools-as-blocking-async-functions.md)), so eviction
   skips it. Its sandbox and Pi state stay alive until the result arrives, or
   until archive, delete or interrupt. After a restart, recovery deliberately
   leaves a paused turn with a pending action alone, so the session still
   reports `requires_action`. But when the result arrives there is no runtime
   to deliver it to, and the claim path closes the turn with a lost-runtime
   result instead of continuing the work.
5. **What makes a durable design feasible.** Pi can persist and rebuild a
   session (`SessionManager.create/open` for files, or
   `SessionManager.inMemory(cwd, opts, entries)` seeded from stored entries).
   It can also resume a run from injected state with `agent.continue()`.
6. **What the sandbox holds.** Pi runs in the control plane, not in the
   sandbox. The sandbox holds the workspace files and any processes the agent
   started (for example a dev server). Freezing process memory is not needed to
   keep a session's work.

Hosted Managed Agents keeps a session's conversation for its whole life: a
message sent to an idle session hours later continues it.

This decision also shapes the next events/runner refactor: turn ownership,
#260 and #254, which plan 0146 lists after #164.

## Options

### A. Hot runtime, stopped container (interim)

Keep the Pi session in memory. While a session waits on `requires_action`,
stop its container (`docker stop` keeps the writable filesystem) and start it
again on resume.

- **Fixes:** sandbox CPU and memory cost while waiting.
- **Does not fix:** facts 1–3 (amnesia after idle TTL or restart), or Pi memory
  held per waiting session. Waits still don't survive a restart.
- **Cost:** small; docker-local only (microsandbox and Podman need their own
  stop/start).

### B. Durable conversation, disposable compute (recommended)

Treat a session as durable state plus compute that can be thrown away and
rebuilt. This is the two-tier shape #230 describes. Staged:

1. **Durable conversation.** Persist Pi session entries per `sesn_*` in the
   deployment database, transactionally with the event log, and rebuild the Pi
   session on any cache miss (eviction or restart). This fixes facts 1–3 on its
   own and is useful even if parking never ships.
2. **Durable workspace.** Keep each session's sandbox filesystem across
   disposal: a per-session volume, or a stopped container that is restarted.
   Processes the agent started do not survive. That is a stated consequence,
   not a bug.
3. **Resumable waits, then parking.** A `requires_action` wait ends the Pi run
   at the tool boundary instead of blocking inside `execute`. The persisted
   conversation then ends in an unanswered tool call. When the result or
   confirmation arrives, OMA rebuilds the session, injects the tool result,
   and calls `agent.continue()`. With that in place, parking means evicting
   everything while waiting. This amends ADR 0005.

- **Fixes:** facts 1–4; restarts become safe for idle and waiting sessions.
- **Cost:** stage 1 is a contained change (storage plus the runner's session
  factory). Stage 3 changes the tool-wait model and the runner's turn ownership,
  so it should be designed together with #260 and #254.
- **Snapshot correctness (#229):** no process memory is frozen, so identity and
  entropy cloning do not arise. 0107 should still state that current providers
  do not support snapshot resume.

### C. Provider snapshot parking (Substrate-style)

Checkpoint the sandbox, including memory (CRIU or VM snapshots), and restore
on resume.

- **Fixes:** compute cost, and keeps agent-started processes alive.
- **Does not fix:** facts 1–3, because the conversation is in the control
  plane, not the sandbox.
- **Cost:** high. It needs every #229 requirement (identity rebinding, entropy,
  runtime pinning, readiness), it's provider-specific, and docker-local has no
  supported checkpoint path. It only makes sense for a future remote or
  Kubernetes tier (ADR 0003).

## Decision

_Pending._ Recommended: **B**, starting with stage 1 (durable conversation) as
an M2 item, since it fixes a correctness gap testers will hit (amnesia after 15
idle minutes or a restart). Stages 2 and 3 follow, with stage 3 shaped together
with the turn-ownership slice (#260, #254). Option A is not needed if B lands.
Option C stays deferred to a remote tier.

## Consequences (if B is accepted)

- Plan 0145: B stage 1 joins M2; stage 3 replaces "turn ownership" as the
  slice after #164.
- ADR 0005 gets amended when stage 3 starts.
- 0103 phase 2 (or its successor) records that durable session state covers
  the conversation, not just the event log (#230 acceptance criterion 1).
- 0107 gains a line per provider: no snapshot resume (#229 then closes as "not
  supported", unless option C is ever picked up).
