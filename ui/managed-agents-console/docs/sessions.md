# Start a session

> [!NOTE] Status: **Shipped alpha for synchronous, single-agent sessions.**

## Create a session

Create a session with an agent and environment. A bare agent ID selects the latest version; an agent reference with a version pins that immutable revision. The stored session keeps the resolved version for runtime execution.

At creation, supply any supported vault and file resources. Resources are validated and prepared before execution; OMA does not support adding or removing them later.

## Start work

Send a `user.message` event to begin a turn. The console supports prompts, interrupts, and confirmation responses when its live API capability allows them. API clients should use the documented idempotency contract for retry-safe writes.

## Follow progress

Use the session detail and [event stream](#docs=events) to inspect complete agent messages, tool calls and results, confirmations, errors, and raw payloads. Persisted history survives an SSE reconnect.

## Current limitations

OMA does not support agent overrides at session creation, live session updates, token previews, multi-agent threads, or hosted-style asynchronous session scheduling.
