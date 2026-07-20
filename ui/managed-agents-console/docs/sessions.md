# Sessions and events

Sessions are the persisted record of one agent working in one environment.

## Create and prompt

Start a session with an agent and environment, then send the initial task as an event. The console can create sessions, send prompts, interrupt execution, and resolve manual tool confirmations when the live API permits those actions.

## Inspect events

Follow the SSE event stream to inspect complete agent messages, tool calls and results, errors, and raw payloads. Persisted history is available for a session after reconnecting.

> [!NOTE] OMA currently exposes buffered complete agent messages, not streaming token previews. It does not advertise unsupported event types as live features.

## Lifecycle

Archive a session to retain it without continuing work, or delete it when it is no longer needed. Archived sessions are read-only.
