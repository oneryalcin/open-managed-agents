# Client retry and cleanup loop

This cookbook combines the three client behaviors that make an OMA session
robust in normal network conditions:

1. send user events with `Idempotency-Key`;
2. reconnect by combining SSE with `events.list`;
3. clean up sessions when the client is done.

## Recommended loop

For each user action:

1. Generate one idempotency key for the logical `events.send` request.
2. Send `POST /v1/sessions/{id}/events` with that key.
3. Open or keep an SSE stream on `GET /v1/sessions/{id}/events/stream`.
4. Track the latest event ID seen by either SSE or `events.list`.
5. If the stream drops, reconnect the stream first, then backfill with
   `GET /v1/sessions/{id}/events?page=<last_seen_id>`.
6. Dedupe by event `id`.
7. When the client no longer needs the session, call `DELETE /v1/sessions/{id}`.

The stream-first reconnect order is important. It prevents a gap where an event
is committed after a list request returns but before the replacement stream is
attached.

## Retry-safe send

Use the same key for retries of the same event batch. Do not generate a new key
for each retry. See [Retry-safe `events.send`](retry-safe-events-send.md) for
the full key format, TTL, `409`, and mismatch contract.

Python:

```python
from uuid import uuid4

key = f"events-send-{uuid4()}"

client.beta.sessions.events.send(
    session_id,
    events=[
        {
            "type": "user.message",
            "content": [{"type": "text", "text": "What changed?"}],
        }
    ],
    extra_headers={"Idempotency-Key": key},
)
```

TypeScript:

```ts
import { randomUUID } from "node:crypto";

const key = `events-send-${randomUUID()}`;

await client.beta.sessions.events.send(
  sessionId,
  {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: "What changed?" }],
      },
    ],
  },
  {
    headers: { "Idempotency-Key": key },
  },
);
```

## Reconnect without losing events

OMA persists every event before publishing it to SSE. Clients should therefore
treat SSE as live delivery and `events.list` as durable backfill.

On reconnect:

1. Open `GET /v1/sessions/{id}/events/stream`.
2. Fetch `GET /v1/sessions/{id}/events?page=<last_seen_id>&order=asc`.
3. Merge streamed and listed events.
4. Drop duplicates by event `id`.
5. Update `last_seen_id` whenever a larger event ID is accepted.

`Last-Event-ID` is supported as an SSE convenience, but the durable reconnect
pattern is still stream first, then list backfill.

Python sketch:

```python
seen: set[str] = set()
last_seen_id: str | None = None


def accept(event):
    global last_seen_id
    if event.id in seen:
        return
    seen.add(event.id)
    last_seen_id = event.id
    render(event)


with client.beta.sessions.events.stream(session_id) as stream:
    for event in stream:
        accept(event)

# If the stream drops, reconnect first, then backfill.
with client.beta.sessions.events.stream(session_id) as stream:
    page = client.beta.sessions.events.list(
        session_id,
        page=last_seen_id,
        order="asc",
    )
    for event in page.data:
        accept(event)
    for event in stream:
        accept(event)
```

TypeScript sketch:

```ts
const seen = new Set<string>();
let lastSeenId: string | undefined;

function accept(event: { id: string }) {
  if (seen.has(event.id)) return;
  seen.add(event.id);
  lastSeenId = event.id;
  render(event);
}

for await (const event of client.beta.sessions.events.stream(sessionId)) {
  accept(event);
}

// If the stream drops, reconnect first, then backfill.
const stream = client.beta.sessions.events.stream(sessionId);
const page = await client.beta.sessions.events.list(sessionId, {
  page: lastSeenId,
  order: "asc",
});
for (const event of page.data) accept(event);
for await (const event of stream) accept(event);
```

## Cleanup

When the client is done with a session, delete it:

Python:

```python
client.beta.sessions.delete(session_id)
```

TypeScript:

```ts
await client.beta.sessions.delete(sessionId);
```

Deleting a session removes its session row, event rows, pending runtime rows,
pending runtime actions, session-output metadata, and `events.send`
idempotency responses for that session. Retrying an old idempotency key after
delete returns `404` instead of replaying a stale response.

## Checklist

- Reuse the same `Idempotency-Key` for retries of the same `events.send`.
- Do not reuse a key for different messages.
- Treat `409` as "wait and retry with the same key."
- Track `last_seen_id`.
- On reconnect, attach the stream before listing backfill.
- Dedupe by event `id`.
- Delete sessions when they are no longer needed.
