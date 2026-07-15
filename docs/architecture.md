# Architecture

Three execution sites, same decomposition as Anthropic's Managed Agents — but all three are on your infrastructure.

## The three sites

```
═══════════════════════════════════════════════════════════════════════
 YOUR INFRA (all of it)
═══════════════════════════════════════════════════════════════════════

  ┌──────────────────────────┐
  │  Control plane           │
  │  Hono + TypeScript       │           Client (SDK or curl)
  │                          │  ←─ HTTPS ──  POST /v1/sessions
  │  - REST endpoints        │              POST /v1/sessions/{id}/events
  │  - SSE stream wrapper    │  ── SSE ──→  GET  /v1/sessions/{id}/events/stream
  │  - Pending-call map      │
  │  - SQLite persistence    │
  └─────┬────────────────────┘
        │ spawns + drives
        ▼
  ┌──────────────────────────┐         ┌──────────────────────────┐
  │  Pi AgentSession         │  ←──→   │  Modal Sandbox           │
  │  (engine: loop +         │  exec   │  Linux + Python          │
  │   compaction +           │         │  /workspace, bash,       │
  │   tool dispatch)         │         │  file ops                │
  └──────────────────────────┘         └──────────────────────────┘
```

The control plane, the Pi loop, and the sandbox are three separate concerns — but in our MVP, control plane + Pi run in the same Node process. The sandbox is the only thing that's genuinely remote.

## Request flow — `POST /v1/sessions`

1. Client posts `{ agent, environment_id }` — `agent` is the wire field (NOT `agent_id`), accepting either a bare string `"agent_abc"` or an object `{type: "agent", id, version?}`
2. Control plane loads agent config from SQLite (model, system, tools list)
3. Spins up a Modal sandbox via the `Sandbox` interface
4. Creates a Pi `AgentSession` configured with:
   - The agent's model + system prompt
   - Tools wired through our `Sandbox` interface (so Pi's `bash`/`read`/`write` execute in the Modal sandbox, not on the host)
   - Custom tools from the agent's `tools` list as async functions (see [ADR 0005](adrs/0005-custom-tools-as-blocking-async-functions.md))
5. Wires Pi's `subscribe()` into a per-session event buffer + SSE broadcaster
6. Returns the full session object (with field `id`, `status`, `created_at`, etc.) to the client — not a shorthand `{session_id}`

## Request flow — `events.send` with `user.message`

1. Client posts to `/v1/sessions/{id}/events` with `{ type: "user.message", content: [...] }`
2. If the request includes `Idempotency-Key`, the control plane reserves the key
   for the exact method, concrete path, and raw JSON body. Completed same-key
   retries replay the stored response; fresh in-progress retries return `409`;
   same-key/different-body retries return `invalid_request_error`.
3. Control plane resolves session and persists the user event to the event log.
   For idempotent requests, the event rows, runtime ledger changes, and stored
   idempotency response complete in the same SQLite transaction.
4. Runtime ingestion forwards the text into the cached Pi session. If idle: `session.prompt(text)`. If already running: `session.followUp(text)`; Pi owns the turn queue.
5. Pi runs the loop; emits `tool_execution_start`, `message_update`, `agent_end`, etc.
6. Control plane translates Pi events → Managed Agents event shapes → SSE stream

## Request flow — custom tool round-trip

See [ADR 0005](adrs/0005-custom-tools-as-blocking-async-functions.md) for the rationale. Summary:

```
Agent decides to call a custom tool
    │
    ▼
Pi invokes the AgentTool's async execute()
    │
    ▼
PiCustomToolBridge:
    1. Emits an internal runtime custom-tool-use event.
    2. Returns a Promise (Pi loop awaits).
    │
    ▼
DefaultSessionEventsService:
    3. Generates server-side event ID (sevt_<custom_tool_use_id>)
    4. Persists + emits `agent.custom_tool_use` event
    5. Coalesces pending custom-tool IDs and persists + emits
       `session.status_idle` with
       stop_reason: {type: "requires_action", event_ids: [<ids...>]}
       ← REQUIRED for SDK clients that drain on the idle event.
    6. Binds the pending Promise resolver by the public `custom_tool_use_id`.
    │
    ▼
Pi loop suspended (await Promise)
    │
    ▼
Client receives both events from SSE (or via events.list on reconnect),
sees stop_reason.requires_action, executes the tool, posts:
    POST /v1/sessions/{id}/events
    { type: "user.custom_tool_result",
      custom_tool_use_id: "<id>",         ← NOT tool_use_id!
      content: [...],
      is_error?: bool }
    │
    ▼
Control plane: lookup resolver by `custom_tool_use_id` → call it
    │
    ▼
Control plane persists `user.custom_tool_result`, emits `session.status_running`,
then resolves the Promise. Pi resumes with the tool result.
If multiple custom tools are pending and only one result arrives, the control
plane re-emits `session.status_idle{requires_action}` with the remaining IDs.
If `user.custom_tool_result.is_error` is true, the bridge throws a Pi tool
error using the submitted text content; returning `{isError:true}` was probed
and does not set Pi's emitted tool-result error flag.
```

> ‼️ **`custom_tool_use_id` is the field name on `user.custom_tool_result`** — distinct from `tool_use_id` (which is used on `user.tool_confirmation` for permission gating, a separate feature). See ADR 0005.

## Engine ↔ API mapping (high level)

| Managed Agents endpoint / event | Pi primitive |
|---|---|
| `POST /v1/agents`, `POST /v1/agents/{id}`, version history | SQLite materialized head + immutable revisions; no Pi call |
| `POST /v1/sessions` | `createAgentSession()` |
| `POST /v1/sessions/{id}` (update) | mutate session config in our DB; future Pi updates use public tool/session APIs, not internal active-tool mutation |
| `events.send` `user.message` | `session.prompt()` / `steer()` / `followUp()` |
| `events.send` `user.interrupt` | `session.abort()` |
| `events.send` `user.custom_tool_result` | resolves a pending tool promise (see ADR 0005) |
| `events.stream` | wraps `session.subscribe()` |
| `events.list` | reads from per-session event buffer in SQLite |
| `agent.message` | Buffered Pi assistant text emitted after message completion |
| token-preview deltas / `agent.thinking` | Deferred; not advertised by the shipped event union |
| `agent.tool_use` (built-in) | Pi `tool_execution_start` for sandbox tools |
| `agent.tool_result` | Pi `tool_execution_end` |
| `agent.custom_tool_use` | emitted by our async tool body (Pi `tool_execution_start` is incidental) |
| `session.status_running` | Pi `agent_start` |
| `session.status_idle` | Pi `agent_end` + idle gate logic |

The mapping is not 1:1 in cardinality. Pi exposes more granular per-token
updates, but OMA currently persists and streams complete public events;
assistant text arrives as a buffered `agent.message`. Managed Agents also has
session-lifecycle events Pi does not model. The control plane owns this
bidirectional translation and rejects unsupported delta opt-ins rather than
silently ignoring them.

Cycle C mapping is implemented and tested in code, not duplicated as prose:
- Translator: `src/control-plane/sessions/pi/translator.ts`
- Fixture-driven mapping tests: `src/control-plane/sessions/pi/__tests__/translator.test.ts`
- Captured Pi evidence fixtures: `scratch/artifacts/pi-events/*.jsonl`
- Strategy and open design fork: [ADR 0010](adrs/0010-cassette-strategy-for-pi-translation.md), [ADR 0011](adrs/0011-tool-correlation-id-model.md)

## Event log — source of truth

Managed Agents is fundamentally an **append-only event log**. SSE is the live tail; it is *not* the source of truth. Our architecture mirrors this:

```
                       ┌────────────────────────────┐
  Pi.subscribe() ───→  │  Event translator          │
                       │  (Pi events → MA events,   │
                       │   server-side IDs assigned)│
                       └─────┬──────────────┬───────┘
                             │              │
                             ▼              ▼
                    ┌────────────────┐  ┌────────────────────┐
                    │ Persist to     │  │ Broadcast to all   │
                    │ SQLite events  │  │ live SSE listeners │
                    │ table          │  │ on this session    │
                    └────────────────┘  └────────────────────┘
```

**Rules:**

1. **Persist before broadcast.** Every event hits SQLite before being pushed to the SSE stream. A client that's not currently connected can fetch it later via `GET /v1/sessions/{id}/events`.
2. **Event IDs are server-assigned and stable.** UUIDv7 (or `sevt_` prefix + base32). Same event ID across SSE delivery and `events.list` response.
3. **Idempotent receipt.** Clients dedupe on `event.id`. Re-delivering an already-seen event is allowed (encouraged on reconnect).
4. **Append-only.** Events are never mutated after persistence. Corrections happen via *new* events, never by editing old ones.

This is the implementation surface for the reconnect-with-consolidation pattern: on reconnect, the client first attaches a fresh SSE stream (buffering live events from the current point forward), then fetches `events.list` since the last seen ID, then dedupes the consolidated stream by event ID. Attaching the stream first is the gap-safe order; list-first leaves a window where events emitted between list return and stream attach are lost. Without `events.list`, this pattern can't work and any connection drop loses events permanently. `Last-Event-ID` is an additive SSE-level convenience for in-stream resume, not the primary reconnect contract.

### Streaming invariants (B.3 implementation)

These four invariants make the rules above *correct under concurrency*. Each is load-bearing — breaking any one reintroduces a bug that the test suite may not catch, because the failure is timing- or reconnect-dependent. The judgment calls behind two of them (fail-open vs. 400; atomic batch vs. looped publish) are recorded in [ADR 0009](adrs/0009-sse-stream-reconnect-invariants.md).

1. **Persist and notify happen in the same synchronous tick.** `events.send` does `appendBatch(rows)` then `publishPersisted(rows)` with **no `await` between them**. Node is single-threaded; with no suspension point in the gap, no subscriber can register mid-operation and observe a half-applied state. Slipping an `await` in there (e.g. to "clean up" the method) reopens the subscribe-before-replay race — a new subscriber could read history that's missing the just-persisted batch *and* miss the live notify.

2. **Batch append is atomic; fanout writes nothing.** `appendBatch` is a single SQLite transaction (all rows commit or none do — the B.2 guarantee). The broadcaster fanout (`publishPersisted`) only *notifies* already-persisted rows; it performs **zero** DB writes. Do not reintroduce an "append-and-publish" helper that does both: called after `appendBatch` it double-inserts → PRIMARY KEY violation; used instead of `appendBatch` it loops single-row appends → loses batch atomicity.

3. **`Last-Event-ID` is fail-open with a mandatory ownership check.** Parse only well-formed `sevt_…` values. **Before** using one as a resume cursor, verify the cursor event belongs to *this* session. If it's malformed, missing, or from another session → drop it and replay from session start. Never return 400. The ownership check is not optional politeness: IDs are UUIDv7 and sort by time, the store cursor is `id > ?`, so a cursor from a *newer* session is lexically larger and would silently skip this session's real history. Fail-open is safe because `events.list` backfill guarantees no loss; a 400 instead wedges auto-reconnecting clients in a failure loop.

4. **A subscriber is torn down on body-cancel, not only on request-abort.** A live subscriber is a registered in-memory listener; if the client leaves and we don't unregister, listeners accumulate and leak. The SSE route wires a per-stream `AbortController` to **both** the request abort signal **and** `ReadableStream.cancel()` (which also calls `iterator.return()`), so the broadcaster generator's `finally` always runs `removeSubscriber`. The regression test cancels an *idle* stream and asserts the subscriber count returns to zero **without** a later publish — the honest test, because the pre-fix code only cleaned up when the next event happened to arrive.

## What lives in the sandbox vs. the control plane

| Concern | Sandbox | Control plane |
|---|---|---|
| `bash`, file ops (`read`/`write`/`edit`), CMA `glob`, `ls` | ✅ wired in sandbox | `glob` uses bounded provider-owned NUL streaming; Pi `find` is not model-facing. |
| `grep` | ❌ not yet wired — Pi ships `createGrepToolDefinition`; unwired in `sessions/pi/sandbox/provider.ts` (see [PARITY.md](../PARITY.md) Pile B) | |
| `web_fetch`, `web_search` | TBD — could run in sandbox (Pi default) or via control plane (more control); egress boundary now shipped, so unblocked | |
| Pi `AgentSession` instance | | ✅ |
| Custom tool execution | | ✅ |
| MCP tool routing (0122 M1) | | ✅ control-plane MCP client (streamable HTTP, SSRF-guarded); sandbox never dials MCP servers |
| Session state, event buffer, pending calls | | ✅ |
| Files written to `/mnt/session/outputs/` | ✅ (written here) | ✅ (downloaded from here on idle) |

## What we deliberately don't do

- **Re-implement compaction.** Pi handles it. We expose `session.compact()` as an internal lever if needed.
- **Re-implement prompt caching.** It's a Claude API feature; Pi's calls to Anthropic carry whatever cache breakpoints Pi sets.
- **Patch Pi.** If Pi's behavior is wrong for us, we change Pi *configuration*, not Pi *code*. If we can't, we re-evaluate the engine choice.
