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
  includes runtime priced on `active_seconds`. `list_cost` and
  `server_tool_use` are documented as absent until tracking is available.
- `sessions.list` items carry the same `usage`.
- The reference also has `session.stats` (`active_seconds`,
  `duration_seconds`) and `session.budget` (out of scope here).

## Decisions (2026-10-09)

- **D1 `list_cost` = model cost only.** The sum of Pi's per-request list-price
  cost, converted to cents. It is **null when any request in the session had no
  known price**: Pi reports zero rates for custom and local models, and a fake
  `$0` would be worse than no number. OMA is self-hosted, so runtime is not
  priced; PARITY.md says so.
- **D2 totals update per model request**, not per turn. A long running turn
  shows its cost climbing. At idle the values match what hosted would show.
  PARITY.md notes the difference.
- **D3 time stats included:** `usage.active_seconds`, `stats.active_seconds`
  (equal: OMA runs one thread per session) and `stats.duration_seconds`,
  derived from the status events already stored.

## Design

**Capture, in the event store, in the same transaction as the span event.**

- New table `session_model_usage` in the events database, one row per
  `span.model_request_end`: workspace, session, span event id, input, output,
  cache read, cache write 5m, cache write 1h, `cost_micros` (nullable).
- The store derives the token columns from the span row itself whenever it
  persists a `span.model_request_end`, on every path (live, tool-confirmation,
  synthetic span ends from terminalization). So token totals always equal the
  sum of the public spans, the way hosted's do, and no path can forget them.
- Pi-only extras (cost and the 1h cache split) are not on the public span.
  They come through a new `EventStoreRuntimeChanges.modelRequestCosts`, keyed
  by `model_request_start_id`, from Pi's `message_end` (`usage.cost.total`,
  `usage.cacheWrite1h`). A span end with no matching extra gets
  `cost_micros = NULL`, so the session's `list_cost` turns null instead of
  under-counting. Synthetic span ends (zero tokens) count as priced at zero.
- "Unpriced": Pi's `cost.total` is 0 while the request used tokens.
- Migration: create the table and backfill it from existing span events in
  one transaction (same pattern as `ensureConversationTurnsTable`). Backfilled
  rows have `cost_micros = NULL` and all cache writes as 5m, so sessions from
  before this change show tokens but `list_cost: null`.

**Read.**

- `SessionEventStore.usageForSessions(workspaceId, sessionIds)`: one grouped
  `SUM` over `session_model_usage`, plus active seconds from the
  `session.status_running` / `session.status_idle` events (pairs in log order;
  a session still running adds `now - last running`). Uses the existing
  `events_by_workspace_session_type` index.
- The session service fills `usage` and `stats` on retrieve, list, create and
  update from that call (list: one call per page, not per session).
- `list_cost`: `{amount: String(round(sum_micros / 10_000)), currency: "USD"}`,
  or null as above. `server_tool_use`: null, since OMA has no server tools
  yet. The web tools item can fill it later.
- Types, OpenAPI document and SDK-shape tests are updated; `usage: null` goes away.

**Console.** The session list and detail show tokens (in / out / cache) and
cost. The tooltip saying "Session-level usage is not reported by the API" goes.

## Slices

1. **Store and capture:** the table, the migration with backfill, derivation from
   span rows, `modelRequestCosts` on all three span-end paths (runner
   stream, tool-confirmation x2), and store tests.
2. **API:** `usage` and `stats` on session responses, types, OpenAPI, PARITY.md,
   and a real-Pi API test (faux provider with usage and cost) that checks the
   session totals equal the sum of the spans after two turns.
3. **Console:** list and detail display.

## Tests that prevent real bugs

- Totals equal the sum of the public spans after a tool turn plus a second
  turn (the hosted invariant).
- A session with one unpriced request reports `list_cost: null`, not a partial sum.
- A span end persisted through the tool-confirmation path still records its
  cost (otherwise confirmations silently null `list_cost`).
- A pre-existing database is backfilled: tokens are present, `list_cost` is null.
- `active_seconds` covers a running turn live and stops at idle; an
  interrupted or terminalized turn still closes its interval.
- A deleted session's usage rows go with it.

## Out of scope

`session.budget` and spend limits, workspace-level aggregation, runtime
pricing, and `server_tool_use` (until web tools).
