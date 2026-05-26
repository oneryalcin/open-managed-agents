# ADR 0009: SSE stream reconnect invariants — fail-open cursors, atomic-batch fanout

**Status:** Accepted, 2026-05-26

## Context

[ADR 0007](0007-flue-patterns-we-are-borrowing.md) lifted the *patterns* for live event delivery (replay-then-tail, persist-before-publish, cursor-by-UUIDv7). [ADR 0004](0004-managed-agents-rest-sse-surface-as-north-star.md) pinned the wire contract (`/v1/sessions/{id}/events/stream`, the error envelope, event-type strings). Cycle B.3 *implemented* the SSE stream on top of B.2's persisted log and surfaced two design choices that the patterns alone don't decide. Each has a plausible alternative that a future engineer might reach for; this ADR records why we rejected those alternatives, so the decision isn't re-litigated from a code comment.

The two operational invariants that flow from these choices — *persist-and-notify in one synchronous tick* and *tear down subscribers on body-cancel* — are described in `architecture.md` § Event log → Streaming invariants. This ADR covers only the two **judgment calls**.

Both choices were converged on independently by four review passes (Codex review, Codex adversarial review, an Opus deep review, and a Sonnet parity review against Anthropic's SDK/docs). The adversarial pass specifically challenged the fail-open posture and the single-process broadcaster and found no break.

## Decision 1 — `Last-Event-ID` is fail-open, never 400, with a mandatory cursor-ownership check

On stream connect, parse the `Last-Event-ID` header (or the upstream-equivalent resume cursor). Use it as a resume point **only** when it is a well-formed `sevt_…` value that resolves to an event **in this session**. In every other case — malformed, well-formed but nonexistent, or well-formed but belonging to another session — **drop the cursor and replay from the start of this session.** Never reject the request.

**Why fail-open, not 400.** `EventSource` clients auto-resend `Last-Event-ID` on reconnect. A 400 on a bad cursor turns a transient hiccup into a permanent reconnect-fail loop the client can't escape. Fail-open is *safe* because the reconnect contract (ADR 0007: stream-first + `events.list` backfill + dedupe by `event.id`) already guarantees no event is lost — a dropped cursor costs at most some redundant replay, never correctness. Anthropic's docs do not define a strict-rejection behavior here, so 400 would also be a parity invention.

**Why the ownership check is mandatory, not optional.** Event IDs are UUIDv7 — they sort by creation time. The store cursor is `WHERE id > ?` scoped to the session. A cursor copied from a *newer* session is therefore lexically **larger** than this session's real events, so trusting it blindly would silently skip this session's history and stream nothing — the exact data-loss failure the whole reconnect design exists to prevent. The ownership lookup (`store.retrieve(cursor).session_id === sessionId`) must run *before* the cursor reaches the `id > ?` query.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Return `400 invalid_request_error` on malformed/foreign cursor | Wedges auto-reconnecting clients in a failure loop; not required by upstream; backfill already makes loss impossible. |
| Use the cursor without the session-ownership check | Silent history skip when the cursor is from a newer session (UUIDv7 time-ordering + `id > ?`). The worst kind of bug: invisible, reconnect-only, data-losing. |
| Treat `Last-Event-ID` as the primary reconnect mechanism | It's an additive convenience. The durable contract is stream-first + `events.list` + dedupe; making the header primary would couple correctness to a best-effort header. |

## Decision 2 — atomic batch append, separate notify-only fanout

`events.send` persists the whole batch with `EventStore.appendBatch(rows)` (a single `BEGIN…COMMIT` transaction — all rows or none) and **then** notifies live subscribers with `broadcaster.publishPersisted(rows)`, which performs **no database writes**. The two steps run in the same synchronous tick (no `await` between them). There is no combined "append-and-publish" method on the broadcaster.

**Why split persist from notify.** The naive shape — loop `broadcaster.publish(event)` over the batch, where `publish` does `store.append(event)` then fan out — has two failure modes. (a) Called *after* `appendBatch`, it re-inserts already-persisted rows → PRIMARY KEY violation. (b) Used *instead of* `appendBatch`, it appends row-by-row → a mid-batch failure leaves the log partially written, regressing B.2's atomic-batch guarantee. Separating "persist atomically" from "notify what's persisted" sidesteps both: the transaction owns durability, the fanout owns delivery, neither touches the other's job.

This is also why an `appendAndPublish` convenience method was *removed* during B.3 review rather than kept — it was a dormant version of failure mode (a), with no production caller, one refactor away from a double-write.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Loop `publish()` (append + fanout) per event | Loses batch atomicity (partial-write on mid-batch failure); contradicts B.2. |
| Keep `appendBatch` *and* a combined `appendAndPublish` helper | Double-insert PK violation if both run; a footgun with no caller. Deleted. |
| Make `publishPersisted` also write to the store "for safety" | Double-write. The contract is: rows are durable *before* fanout is called; fanout must not persist. |

## Consequences

- The broadcaster's public surface is `subscribe()` + `publishPersisted()` (notify-only). `EventStore.append` exists for single-row paths but is not part of the send→stream flow.
- Multi-process fanout is **out of scope**: the subscriber registry is an in-process map, so live tail only spans subscribers on the same process. Cross-process delivery (shared bus / pub-sub) is a future cycle; until then `events.list` backfill is the cross-process safety net. Recorded here so it isn't mistaken for an oversight.
- No `retry:` SSE directive and no keepalive heartbeat in B.3 — `EventSource` defaults (~3s reconnect) are acceptable for MVP; both are deferred, not decided against.

## Validation

Empirically verified on branch `feat/cycle-b3-events-stream`: `npm run typecheck`, `npm test` (48 tests / 11 files), `scratch/05-event-store.ts`, and `scratch/09-events-stream.ts` all pass. The fail-open cursor states (malformed / nonexistent / foreign-session / valid) and the idle-cancel subscriber-teardown are each covered by a focused test in `cycle-b3-api.test.ts`.
