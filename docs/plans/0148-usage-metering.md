# 0148 — Session usage metering

## Status

Proposed 2026-10-09. An M2 item in [0145](0145-road-to-external-testers.md)
(0114 Arc D). Decisions D1–D3 below were made by the maintainer on 2026-10-09.

## Problem

Sessions return `usage: null`. Each `span.model_request_end` already carries
the request's `model_usage`, but nothing adds it up, so neither the API nor
the console can say what a session used or cost. "What did it cost" is half of
the M2 goal.

## What hosted does (probe 71, 2026-10-09)

[`scratch/71-managed-agents-session-usage-probe.md`](../../scratch/71-managed-agents-session-usage-probe.md),
`claude-sonnet-5`, plus the API reference for `sessions.retrieve`:

- `usage` is never null. A new session has zero tokens, `cache_creation: null`,
  `active_seconds: 0`, `list_cost: {amount: "0", currency: "USD"}`, and
  `server_tool_use` with zero counts.
- Token fields are exactly the sum of the spans' `model_usage`.
  `cache_creation` splits cache writes into `ephemeral_5m_input_tokens` and
  `ephemeral_1h_input_tokens`; spans report only the total.
- Tokens and cost change when a turn ends. `active_seconds` grows while running.
- `list_cost.amount` is an integer string in cents at public list rates, and
  per the API reference includes runtime priced on `active_seconds` (Pi's
  model-only rates already give 5 cents for probe 71's turn 1, so the runtime part
  was not visible there). `list_cost` and
  `server_tool_use` are documented as absent until tracking is available.
- `sessions.list` items carry the same `usage`.
- The reference also has `session.stats` (`active_seconds`,
  `duration_seconds`) and `session.budget` (out of scope here).

## Decisions (2026-10-09)

- **D1 `list_cost` = model cost only.** The sum of Pi's per-request list-price
  cost, in cents. It is **null when any request in the session had no known
  price**: Pi reports zero rates for custom and local models, and a fake `$0`
  would be worse than no number. OMA is self-hosted, so runtime is not priced.
- **D2 totals update per model request**, not per turn. A long running turn
  shows its cost climbing. At idle, token totals match what hosted would show;
  cost differs by hosted's runtime component.
- **D3 time stats included:** `usage.active_seconds`, `stats.active_seconds`
  (equal: one thread per session) and `stats.duration_seconds`.
- **D4 a request cut off mid-flight counts as recorded** (decided after
  review). An interrupt, an archive or a crash closes an open request with a
  synthetic zero-token span end, and Pi's late usage for it is dropped by the
  ownership fence. Such a request counts as zero tokens and $0, consistent with
  the public spans. PARITY.md says cost is a lower bound when requests were cut
  off. Capturing Pi's late usage would mean reopening the drain path that
  plan 0147 had to back out of.
- **D5 #279 first.** `GET /v1/sessions/:id` reports `idle` while a turn runs,
  because nothing updates the row's status. It is fixed before this plan, by
  deriving status from the session's `session.status_*` events, and this
  plan's time stats reuse that walk.

## Design

**Tokens come from the public spans; only what spans lack is stored.**

- `span.model_request_end.model_usage` already has every token field, so
  token totals are read as `SUM(json_extract(payload, '$.model_usage.…'))`
  over the session's span ends. They equal the sum of the public spans by
  construction, on every path, with nothing to backfill. A rollback and
  re-upgrade cannot lose them.
- New table `session_model_request_costs`, keyed by the **span-end event id**:
  workspace, session, `cost_micros` (nullable), `cache_write_1h`, `provider`,
  `model_id`. Written in the same batch as the span event, on the two paths
  that persist real Pi span ends (the runner stream and the tool-confirmation
  permission-use path, which has two call sites). The service knows the
  span-end row id after `materializePersistedEvents`, and passes
  `EventStoreRuntimeChanges.modelRequestCosts`.
- Unpriced, decided at write time from Pi's float: tokens > 0 and
  `!(Number.isFinite(cost.total) && cost.total > 0)` gives `cost_micros =
  NULL`. Never re-derived from `cost_micros == 0`, since a tiny aborted
  request legitimately rounds to 0. A NaN appears for a custom model that
  declares only tiered rates.
- `list_cost` is null iff some span end with tokens > 0 has no cost row or a
  NULL cost. That covers unpriced models, spans written by an older OMA (no
  cost row), and any path that forgot to pass the cost. Zero-token span ends
  (synthetic closures, requests that failed before `message_start`) cost 0
  and need no row.
- `cache_creation`: `null` until the session has a span end. Otherwise
  `ephemeral_1h_input_tokens` is the sum of `cache_write_1h` and
  `ephemeral_5m_input_tokens` is the span cache writes minus that. Span ends
  with no cost row count all of their cache writes as 5m.
- `provider` and `model_id` make a null cost diagnosable and allow repricing
  later.
- No backfill and no startup scan. `deleteForSession` deletes the cost rows.

**Time, by walking the status events.** For each session, walk its
`session.status_*` events in id order. `running` opens an interval if none is
open. `idle` (any stop reason), `rescheduled` and `terminated` close it.
Closers with nothing open are ignored. An interval still open at read time
adds `now - opened_at`, unless the session is terminated. So a
`requires_action` wait and a retry backoff do not count, and an archive
mid-run closes the interval at termination. A crash-to-recovery gap counts
as active, which is acceptable and documented.
`duration_seconds` runs from `created_at` to now, frozen at `archived_at` for
an archived session.

**Read: totals kept by triggers (changed during implementation).** Summing at
read time measured about 150 ms for a page of 20 sessions with 2000 turns
each (tokens and the status walk, about 70 ms each), synchronous on every
list poll. So the totals are kept per session in `session_usage_totals`, by
SQLite triggers on `events` and `session_model_request_costs`:
- span-end inserts add tokens and count spans with tokens;
- cost inserts add cost and the 1h split, and count a span as priced only if
  it used tokens, so a zero-token span's $0 cannot stand in for a missing cost;
- status inserts keep `active_ms` and `running_since` by the walk below.

Because the triggers live in the database, events written by an older OMA
after a rollback still count. The table is backfilled once, in the
transaction that creates it, and the triggers are created after the
backfill. `list_cost` is null while spans with tokens outnumber priced ones.
A list page now reads one row per session: about 9 ms for that page,
almost all of it the #279 status lookup.

The session service gets `runtimeView` (status from #279, usage, time) and
fills `usage` and `stats` on create, retrieve and list. `duration_seconds`
runs from `created_at` to now, frozen at `archived_at`. An idempotent create
renders its response once, so a replay matches it exactly. The dead
`sessions.usage` column is no longer read. `server_tool_use` is null until
web tools exist.

**Console.** The session list and detail show tokens and cost. The "not
reported by the API" tooltip goes.

**PARITY.md and the tester brief (0145).** Cost is an estimate from the price
table bundled with the pinned Pi version (0.85.1): it can drift from
Anthropic's prices, or be unknown for a newer model, until Pi is upgraded
(#249). Cost is model-only, priced at Pi's rates, not Anthropic's
list prices. Pi prices the requested model when a fallback serves the
request. Cost is a lower bound when requests were cut off. Totals update per
request.

## Slices

0. **#279 (separate PR, #280, merged):** session status from status events.
1. **Store and capture** (shipped together with slice 2, since only the API
   makes capture testable as behaviour): the cost table and its write on both span-end paths,
   the token and cost read, and the time walk. Also move `events/store.ts`'s
   `ensure…` migrations into their own module (hygiene; this slice adds one).
2. **API:** `usage` and `stats` on session responses, types, OpenAPI,
   PARITY.md, and a real-Pi API test.
3. **Console:** list and detail display.

## Tests that prevent real bugs

- After a tool turn plus a second turn, the totals equal the sum of the
  public spans, and `list_cost` matches Pi's rates. Probe 71's turn 1 at
  `claude-sonnet-5` rates gives "5".
- One unpriced request makes `list_cost` null; a NaN cost does too.
- A span end persisted through the tool-confirmation path records its cost.
- Spans with no cost row, as written by an older OMA, give tokens and a null
  `list_cost`.
- Archiving a running session stops `active_seconds` from growing.
  `requires_action` and `running → running` sequences are counted once.
- Deleting a session removes its cost rows.

## Out of scope

`session.budget` and spend limits, workspace-level aggregation, runtime
pricing, `server_tool_use` (until web tools), and capturing late usage for
cut-off requests (D4).

## Review log

- **Codex adversarial (plan, 2026-10-09):**
  - Synthetic ends are not proof of zero cost: decided by D4.
  - An existence-only backfill loses rows after a rollback: removed, since
    tokens are now read from the spans.
  - Archive leaves an interval open: fixed by the state walk.
  - List replays history: accepted with the load check above as the guard.
- **Fable (plan, 2026-10-09):**
  - The time derivation needs a state walk: adopted.
  - Token columns and the backfill are unnecessary: removed.
  - Key the cost row by span-end id: adopted.
  - Spell out the unpriced rule (decide at write time, NaN, zero-token):
    adopted.
  - Define `duration_seconds` and `cache_creation`: done.
  - Name the read dependency: done.
  - Record provider and model: adopted.
  - Found #279 along the way.
