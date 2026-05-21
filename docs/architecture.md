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
2. Control plane resolves session → checks Pi's `isStreaming`
3. If idle: `session.prompt(text)`. If streaming: `session.steer(text)` or `session.followUp(text)` depending on the queueing intent
4. Pi runs the loop; emits `tool_execution_start`, `message_update`, `agent_end`, etc.
5. Control plane translates Pi events → Managed Agents event shapes → SSE stream

## Request flow — custom tool round-trip

See [ADR 0005](adrs/0005-custom-tools-as-blocking-async-functions.md) for the rationale. Summary:

```
Agent decides to call a custom tool
    │
    ▼
Pi invokes the AgentTool's async execute()
    │
    ▼
Our async tool body:
    1. Generates server-side event ID (sevt_<custom_tool_use_id>)
    2. Persists + emits `agent.custom_tool_use` event
    3. Persists + emits `session.status_idle` with
       stop_reason: {type: "requires_action", event_ids: [<id>]}
       ← REQUIRED for SDK clients that drain on the idle event.
    4. Stores resolver in pendingToolCalls Map keyed by `custom_tool_use_id`
    5. Returns a Promise (Pi loop awaits)
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
Promise resolves → Pi loop resumes with the tool result, emits
`session.status_running` event for stream consumers
```

> ‼️ **`custom_tool_use_id` is the field name on `user.custom_tool_result`** — distinct from `tool_use_id` (which is used on `user.tool_confirmation` for permission gating, a separate feature). See ADR 0005.

## Engine ↔ API mapping (high level)

| Managed Agents endpoint / event | Pi primitive |
|---|---|
| `POST /v1/agents` | (none — store in SQLite, no Pi call) |
| `POST /v1/sessions` | `createAgentSession()` |
| `POST /v1/sessions/{id}` (update) | mutate session config in our DB; possibly `session.agent.state.tools = …` |
| `events.send` `user.message` | `session.prompt()` / `steer()` / `followUp()` |
| `events.send` `user.interrupt` | `session.abort()` |
| `events.send` `user.custom_tool_result` | resolves a pending tool promise (see ADR 0005) |
| `events.stream` | wraps `session.subscribe()` |
| `events.list` | reads from per-session event buffer in SQLite |
| `agent.message` text deltas | Pi `message_update.text_delta` |
| `agent.thinking` deltas | Pi `message_update.thinking_delta` |
| `agent.tool_use` (built-in) | Pi `tool_execution_start` for sandbox tools |
| `agent.tool_result` | Pi `tool_execution_end` |
| `agent.custom_tool_use` | emitted by our async tool body (Pi `tool_execution_start` is incidental) |
| `session.status_running` | Pi `agent_start` |
| `session.status_idle` | Pi `agent_end` + idle gate logic |

The mapping is not 1:1 in cardinality — Pi emits more granular per-token events; Managed Agents has session-lifecycle events Pi doesn't model. The control plane is responsible for the bidirectional translation.

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

## What lives in the sandbox vs. the control plane

| Concern | Sandbox | Control plane |
|---|---|---|
| `bash`, file ops, `glob`, `grep` | ✅ | |
| `web_fetch`, `web_search` | TBD — could run in sandbox (Pi default) or via control plane (more control) | |
| Pi `AgentSession` instance | | ✅ |
| Custom tool execution | | ✅ |
| MCP tool routing (post-MVP) | | ✅ via Anthropic-style MCP proxy |
| Session state, event buffer, pending calls | | ✅ |
| Files written to `/mnt/session/outputs/` | ✅ (written here) | ✅ (downloaded from here on idle) |

## What we deliberately don't do

- **Re-implement compaction.** Pi handles it. We expose `session.compact()` as an internal lever if needed.
- **Re-implement prompt caching.** It's a Claude API feature; Pi's calls to Anthropic carry whatever cache breakpoints Pi sets.
- **Patch Pi.** If Pi's behavior is wrong for us, we change Pi *configuration*, not Pi *code*. If we can't, we re-evaluate the engine choice.
