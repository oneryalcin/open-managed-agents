# ADR 0011: Tool Correlation ID Model (`sevt_*` vs `toolu_*`)

**Status:** Accepted (Option A), 2026-05-26

## Context

Cycle C.1 translator preserves Pi tool-call correlation IDs (`toolu_*`) in payload fields (for example `agent.tool_use.payload.tool_use_id`), while top-level Managed Agents event IDs are server-stamped (`sevt_*`) per existing event-log design.

Anthropic SDK consumers may correlate tool round-trips via `agent.tool_use.id` semantics. Our current design keeps server event IDs uniform, which creates a cross-cycle decision for C.2/D when inbound `user.*tool_result` is wired.

## Decision

### Option A — Uniform `sevt_*` event IDs + inbound translation (**accepted**)

- Keep top-level event IDs as `sevt_*` for all event types.
- Preserve `toolu_*` correlation IDs in payload.
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

SDK clients still round-trip correctly because they echo whatever `ev.id` we emit as `tool_use_id`; we resolve that server ID back to Pi's `toolu_*` internally.

## Current state

- C.1 preserves Pi `toolu_*` correlation IDs in payload while keeping top-level IDs server-assigned.
- Runtime inbound correlation mapping is implemented in Cycle D.

## Exit criteria for this ADR

- [x] Selected option documented as **Accepted**.
- [ ] Matching tests added for end-to-end correlation (tool-use emit -> user result ingest -> Pi resume).
- `docs/roadmap.md` and relevant runtime docs updated to reflect final model.
