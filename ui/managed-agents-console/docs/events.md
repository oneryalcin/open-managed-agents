# Session event stream

> [!NOTE] Status: **Shipped alpha.** Events are persisted, listable, and streamable over server-sent events (SSE).

## Read the event history

Use `GET /v1/sessions/{id}/events` to page through persisted history, or open the console session detail. Events include user messages and interrupts, tool use and results, agent messages, status changes, model-request spans, and terminal errors where OMA emits them.

## Stream and resume

Use `GET /v1/sessions/{id}/events/stream` for SSE. Send `Last-Event-ID` to resume after a known event. A reconnecting stream is not the source of truth: list persisted events to backfill if a client needs reliable consolidation.

## Text and previews

OMA emits a complete buffered `agent.message` after generation. It does not emit token previews, `agent.thinking`, or `system.message`; requests using the unsupported `event_deltas[]` parameter fail with HTTP 400 rather than silently doing nothing.

## Confirmation and custom tools

`user.tool_confirmation` resolves an ask-gated built-in or MCP tool request. `user.custom_tool_result` resolves a custom-tool wait. These events are part of the session's persisted audit trail.
