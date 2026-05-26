# ADR 0011: Tool Correlation ID Model (`sevt_*` vs `toolu_*`)

**Status:** Proposed, 2026-05-26

## Context

Cycle C.1 translator preserves Pi tool-call correlation IDs (`toolu_*`) in payload fields (for example `agent.tool_use.payload.tool_use_id`), while top-level Managed Agents event IDs are server-stamped (`sevt_*`) per existing event-log design.

Anthropic SDK consumers may correlate tool round-trips via `agent.tool_use.id` semantics. Our current design keeps server event IDs uniform, which creates a cross-cycle decision for C.2/D when inbound `user.*tool_result` is wired.

## Decision needed

Choose one model before Cycle D round-trip wiring:

### Option A — Uniform `sevt_*` event IDs + inbound translation

- Keep top-level event IDs as `sevt_*` for all event types.
- Preserve `toolu_*` correlation IDs in payload.
- Inbound tool-result handling must map echoed `sevt_*` back to `toolu_*` before forwarding to Pi.

### Option B — SDK-faithful tool-use event IDs

- For `agent.tool_use` / `agent.custom_tool_use`, emit top-level `id = toolu_*`.
- Keeps direct SDK-style correlation without inbound translation.
- Breaks uniform `sevt_*` event-ID model for those event types.

## Current state

- No runtime consumer in C.1 depends on the final choice yet.
- C.1 intentionally keeps this unresolved and documents it in translator comments.
- Resolution is required in C.2/D when custom-tool result correlation becomes live behavior.

## Exit criteria for this ADR

- Selected option documented as **Accepted**.
- Matching tests added for end-to-end correlation (tool-use emit -> user result ingest -> Pi resume).
- `docs/roadmap.md` and relevant runtime docs updated to reflect final model.

