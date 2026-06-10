# Session lifecycle flow

This cookbook shows the client shape for a normal session lifecycle:

```text
create -> stream/list -> send events -> interrupt/archive/delete
```

Use it when wiring an SDK client, CLI, or UI that needs retry-safe writes and
predictable terminal-state handling.

## Lifecycle Rules

- Create sessions with `Idempotency-Key` when the client might retry.
- Stream before backfilling with `events.list` so reconnects do not miss events.
- Send each logical `events.send` batch with its own `Idempotency-Key`.
- Use `user.interrupt` to cancel active runtime work without deleting the
  session.
- Use archive when the session is done but history should remain readable.
- Use delete when the session should be cleaned up and future reads should fail.

## Archive vs Delete vs Interrupt

| Action | Use when | Client-visible result |
| --- | --- | --- |
| `user.interrupt` | The user cancels active work but may keep using the session. | OMA records the interrupt, aborts active runtime work, clears pending waits, and leaves the session usable after it settles. |
| `sessions.archive` | The session is done and should be hidden from active workflows, but history should remain readable. | OMA emits `session.status_terminated`. Clients should stop the stream loop. The server does not force-close the stream on archive. |
| `sessions.delete` | The session and related state should be removed. | OMA emits `session.deleted`, closes live streams, removes session/event/runtime/output/idempotency rows for that session, and future reads return `404`. |

Archive rejects truly running sessions. If a session is currently running and
the user wants to finish it, send `user.interrupt`, wait for the session to
settle, then archive.

## Terminal Events

Treat these events as terminal in client stream loops:

- `session.status_terminated`: archive or terminal lifecycle state. Stop
  consuming the stream; history remains readable.
- `session.deleted`: hard-delete state. Stop consuming the stream; the server
  closes live streams and history is removed.

## Python Sketch

In a UI or CLI, run the stream consumer in the background and issue lifecycle
actions from user handlers.

```python
from uuid import uuid4


def idempotency_key(prefix: str) -> str:
    return f"{prefix}-{uuid4()}"


terminal = False
seen: set[str] = set()
last_seen_id: str | None = None


def accept(event):
    global terminal, last_seen_id
    if event.id in seen:
        return
    seen.add(event.id)
    last_seen_id = event.id

    render(event)

    if event.type in ("session.status_terminated", "session.deleted"):
        terminal = True


def consume_events(session_id: str):
    global terminal

    # Attach live delivery first.
    with client.beta.sessions.events.stream(session_id) as stream:
        # Backfill after the stream is attached.
        page = client.beta.sessions.events.list(
            session_id,
            page=last_seen_id,
            order="asc",
        )
        for event in page.data:
            accept(event)

        for event in stream:
            accept(event)
            if terminal:
                break


session = client.beta.sessions.create(
    agent=agent_id,
    environment_id=environment_id,
    extra_headers={"Idempotency-Key": idempotency_key("sessions-create")},
)

# Start consume_events(session.id) in your client event loop.

client.beta.sessions.events.send(
    session.id,
    events=[
        {
            "type": "user.message",
            "content": [{"type": "text", "text": "Summarize this repo."}],
        }
    ],
    extra_headers={"Idempotency-Key": idempotency_key("events-send")},
)

# Cancel active work without deleting the session.
client.beta.sessions.events.send(
    session.id,
    events=[{"type": "user.interrupt"}],
    extra_headers={"Idempotency-Key": idempotency_key("events-send")},
)

# Soft terminal state: history remains readable.
client.beta.sessions.archive(session.id)

# Hard cleanup when the client no longer needs the session.
client.beta.sessions.delete(session.id)
```

## TypeScript Sketch

In a browser, Node app, or CLI, keep the stream consumer separate from button or
request handlers that send messages, interrupt, archive, or delete.

```ts
import { randomUUID } from "node:crypto";

function idempotencyKey(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

let terminal = false;
let lastSeenId: string | undefined;
const seen = new Set<string>();

function accept(event: { id: string; type: string }) {
  if (seen.has(event.id)) return;
  seen.add(event.id);
  lastSeenId = event.id;

  render(event);

  if (
    event.type === "session.status_terminated" ||
    event.type === "session.deleted"
  ) {
    terminal = true;
  }
}

async function consumeEvents(sessionId: string) {
  // Attach live delivery first.
  const stream = client.beta.sessions.events.stream(sessionId);

  // Backfill after the stream is attached.
  const page = await client.beta.sessions.events.list(sessionId, {
    page: lastSeenId,
    order: "asc",
  });
  for (const event of page.data) accept(event);

  for await (const event of stream) {
    accept(event);
    if (terminal) break;
  }
}

const session = await client.beta.sessions.create(
  {
    agent: agentId,
    environment_id: environmentId,
  },
  {
    headers: { "Idempotency-Key": idempotencyKey("sessions-create") },
  },
);

void consumeEvents(session.id);

await client.beta.sessions.events.send(
  session.id,
  {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: "Summarize this repo." }],
      },
    ],
  },
  {
    headers: { "Idempotency-Key": idempotencyKey("events-send") },
  },
);

// Cancel active work without deleting the session.
await client.beta.sessions.events.send(
  session.id,
  { events: [{ type: "user.interrupt" }] },
  {
    headers: { "Idempotency-Key": idempotencyKey("events-send") },
  },
);

// Soft terminal state: history remains readable.
await client.beta.sessions.archive(session.id);

// Hard cleanup when the client no longer needs the session.
await client.beta.sessions.delete(session.id);
```

## Retry Notes

- Generate one `Idempotency-Key` per logical `sessions.create` request.
- Generate one `Idempotency-Key` per logical `events.send` request.
- Retry `409` responses with the same key and request body after the
  `Retry-After` delay.
- Completed keys expire after 24 hours.
- Reusing an old key after deleting its session is treated as a new request or
  a `404`, depending on the endpoint.

See [Retry-safe `sessions.create`](retry-safe-session-create.md) and
[Retry-safe `events.send`](retry-safe-events-send.md) for the full contract.
