# ADR 0011: Tool Correlation ID Model (`sevt_*` vs `toolu_*`)

**Status:** Accepted (Option A), 2026-05-26

## Context

Cycle C.1 translator preserves Pi built-in/MCP tool-call correlation IDs (`toolu_*`) in payload fields (for example `agent.tool_use.payload.tool_use_id`), while top-level Managed Agents event IDs are server-stamped (`sevt_*`) per existing event-log design.

Anthropic SDK consumers may correlate tool round-trips via `agent.tool_use.id` semantics. Our current design keeps server event IDs uniform, which creates a cross-cycle decision for C.2/D when inbound `user.*tool_result` is wired.

## Decision

### Option A — Uniform `sevt_*` event IDs + inbound translation (**accepted**)

- Keep top-level event IDs as `sevt_*` for all event types.
- Preserve Pi `toolu_*` correlation IDs in payload when the public event schema has a Pi-tool correlation field (`agent.tool_use.tool_use_id`, `agent.tool_result.tool_use_id`).
- For Managed Agents custom tools, expose the public `agent.custom_tool_use.id` (`sevt_*`) as the client-facing `custom_tool_use_id`; keep Pi's `toolu_*` internal to the runtime bridge.
- Inbound tool-result handling must map echoed `sevt_*` back to `toolu_*` before forwarding to Pi.

### Option B — SDK-faithful tool-use event IDs

- For `agent.tool_use` / `agent.custom_tool_use`, emit top-level `id = toolu_*`.
- Keeps direct SDK-style correlation without inbound translation.
- Breaks uniform `sevt_*` event-ID model for those event types.

## Why Option A

Option B breaks the B.3 event-log ordering/cursor contract from ADR 0009.

Our replay/pagination/reconnect machinery uses lexical event ID ordering (`ORDER BY id`, `id > cursor`) on server IDs that are `sevt_*` (UUIDv7, time-ordered). `toolu_*` IDs do not share that ordering domain. Mixing `toolu_*` into top-level event IDs introduces cross-domain ordering behavior and undermines the append-only cursor model that B.3 depends on.

Option A keeps:

- one uniform top-level event ID model,
- unchanged B.2/B.3 persistence and SSE transport assumptions,
- a localized translation cost at inbound tool-result handling (Cycle D).

SDK clients still round-trip correctly because they echo whatever `ev.id` we emit. For built-in/MCP tool results, the inbound path resolves that server ID back to Pi's `toolu_*` internally. For custom tools, the blocking async function is registered in a pending-call map keyed by the public `sevt_*` custom-tool event ID, so Pi's `toolu_*` never needs to leave the runtime bridge.

## Current state

- C.1 preserves Pi `toolu_*` correlation IDs in payload while keeping top-level IDs server-assigned.
- Runtime inbound correlation mapping for Managed Agents custom tools is implemented in Cycle D: `agent.custom_tool_use.id` is a `sevt_*`, `session.status_idle{requires_action}.stop_reason.event_ids` points at one or more pending `sevt_*` custom-tool use IDs, and `user.custom_tool_result.custom_tool_use_id` resolves the matching pending Pi Promise through the runtime bridge.
- Built-in/MCP inbound tool-result correlation remains a future `user.tool_confirmation` / permission-gating concern.

## Exit criteria for this ADR

- [x] Selected option documented as **Accepted**.
- [x] Matching tests added for custom-tool end-to-end correlation (custom-tool use emit -> user result ingest -> Pi resume), including parallel pending calls and partial-result remainder re-emission.
- [x] `docs/roadmap.md` and relevant runtime docs updated to reflect the custom-tool model.
- [ ] Matching tests added for future built-in/MCP tool-result correlation when that inbound path is implemented.
