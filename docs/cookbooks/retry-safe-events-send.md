# Retry-safe `events.send`

`POST /v1/sessions/{id}/events` supports the optional `Idempotency-Key`
request header for retry-safe JSON writes.

Use this when a client may retry after a timeout, connection drop, or transient
server error. The key lets OMA distinguish "same logical request retried" from
"new event that should be appended".

## Contract

For `POST /v1/sessions/{id}/events`, OMA scopes an idempotency key to:

```text
workspace + HTTP method + concrete request path + Idempotency-Key
```

The request fingerprint uses the exact raw JSON bytes. A retry should resend the
same body bytes.

Behavior:

- Same key, same session path, same raw request body: replay the original
  response without appending duplicate events or starting duplicate runtime
  work.
- Same key, same session path, different raw request body: return
  `invalid_request_error`.
- Same key and same body while the first request is still in progress: return
  `409`; retry later with the same key.
- Requests without `Idempotency-Key` keep normal non-idempotent behavior.

Completed idempotency keys expire after 24 hours. After expiry, reusing the
same key is treated as a brand-new request and may execute again. Do not rely on
idempotency replay beyond that window.

The header also applies to JSON `POST /v1/sessions` requests. See
[Retry-safe `sessions.create`](retry-safe-session-create.md). Do not use it yet
for file uploads, multipart bodies, or streaming response replay.

## Key format

`Idempotency-Key` must be:

- non-empty;
- at most 255 characters;
- visible ASCII only.

Invalid keys return `400 invalid_request_error` before any idempotency
reservation is created.

## Python SDK

The official Anthropic Python SDK accepts per-request headers through
`extra_headers`.

```python
from uuid import uuid4

from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:3000",
    api_key="local-dev-key",
)

session_id = "sesn_..."
key = f"events-send-{uuid4()}"

response = client.beta.sessions.events.send(
    session_id,
    events=[
        {
            "type": "user.message",
            "content": [{"type": "text", "text": "Hello"}],
        }
    ],
    extra_headers={"Idempotency-Key": key},
)
```

If the request times out after the server commits it, retry with the same `key`
and the same request body.

```python
response = client.beta.sessions.events.send(
    session_id,
    events=[
        {
            "type": "user.message",
            "content": [{"type": "text", "text": "Hello"}],
        }
    ],
    extra_headers={"Idempotency-Key": key},
)
```

## TypeScript SDK

The official Anthropic TypeScript SDK accepts per-request headers through the
request options argument.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";

const client = new Anthropic({
  baseURL: "http://localhost:3000",
  apiKey: "local-dev-key",
});

const sessionId = "sesn_...";
const key = `events-send-${randomUUID()}`;

const response = await client.beta.sessions.events.send(
  sessionId,
  {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: "Hello" }],
      },
    ],
  },
  {
    headers: { "Idempotency-Key": key },
  },
);
```

If the request is retried, keep the same key and body:

```ts
const retry = await client.beta.sessions.events.send(
  sessionId,
  {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: "Hello" }],
      },
    ],
  },
  {
    headers: { "Idempotency-Key": key },
  },
);
```

## Handling responses

- `200`: the event batch was accepted, or a completed response was replayed.
- `409`: another request with the same key and body is still in progress. Wait
  and retry with the same key. A crashed in-progress request becomes retryable
  after roughly five minutes, so use backoff rather than retrying in a tight
  loop.
- `400 invalid_request_error`: the key was reused for a different request body,
  or the request itself is invalid.

## Common mistakes

- Do not generate a new key for each retry of the same logical request.
- Do not reuse one key for different messages or different sessions.
- Do not assume JSON formatting changes are equivalent. The fingerprint uses
  raw request bytes, so retries should resend the same serialized body.
- Do not use the header for endpoints that do not document support for it.
