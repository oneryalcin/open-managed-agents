# Subscribe to webhooks

> [!WARNING] Status: **Not ready in v1.** OMA has no webhook endpoint registration, signing, delivery queue, retry policy, or event-family subscription API.

## Current alternative

Use the persisted session event API and SSE stream from an application you control. Your application is responsible for reconnecting, backfilling history, deduplicating events, and delivering any downstream notifications.

## Compatibility note

Do not expose a webhook receiver expecting OMA callbacks. A future webhook surface will document its event names, signature verification, delivery semantics, and retry behavior before it is considered available.
