# Retry-safe `sessions.create`

`POST /v1/sessions` supports the optional `Idempotency-Key` request header for
retry-safe session creation.

Use this when a client may retry after a timeout, connection drop, or transient
server error. The key prevents one logical session-create request from creating
multiple sessions, duplicate session resource IDs, or duplicate internal mount
snapshots.

## Contract

For `POST /v1/sessions`, OMA scopes an idempotency key to:

```text
workspace + POST + /v1/sessions + Idempotency-Key
```

The request fingerprint uses the exact raw JSON bytes. A retry should resend the
same body bytes.

Behavior:

- Same key and same raw request body: replay the original session response,
  including the same session ID and resource IDs.
- Same key with a different raw request body: return `invalid_request_error`.
- Same key and same body while the first request is still in progress: return
  `409` with `Retry-After`; retry later with the same key.
- Requests without `Idempotency-Key` keep normal non-idempotent behavior.

Completed idempotency keys expire after 24 hours. If the created session is
deleted before then, OMA removes the replay row for that session; retrying the
old key after delete is treated as a new create request.

## Python SDK

```python
from uuid import uuid4

key = f"sessions-create-{uuid4()}"

session = client.beta.sessions.create(
    agent=agent_id,
    environment_id=environment_id,
    extra_headers={"Idempotency-Key": key},
)
```

If the request times out after the server commits it, retry with the same `key`
and the same request body.

## TypeScript SDK

```ts
import { randomUUID } from "node:crypto";

const key = `sessions-create-${randomUUID()}`;

const session = await client.beta.sessions.create(
  {
    agent: agentId,
    environment_id: environmentId,
  },
  {
    headers: { "Idempotency-Key": key },
  },
);
```

## Common Mistakes

- Generate one key per logical session-create request, not one key per retry
  attempt.
- Reuse the exact same JSON body bytes when retrying.
- Do not reuse a key for a different session-create body.
- Do not rely on replay after the 24-hour TTL or after deleting the created
  session.
