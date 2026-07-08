# Probe 49 — MCP SDK bearer-header seam

Date: 2026-07-08

Script: [`scratch/49-mcp-auth-sdk-probe.mjs`](49-mcp-auth-sdk-probe.mjs)

Purpose for plan 0122 M2: prove whether
`@modelcontextprotocol/sdk@1.29.0`
`StreamableHTTPClientTransport(..., { requestInit: { headers } })` can carry
OMA's `static_bearer` credential on every streamable-HTTP request leg, and
capture the SDK rejection surface for credentialed 401/403 failures.

## Run

```text
node scratch/49-mcp-auth-sdk-probe.mjs
```

The managed sandbox blocks local `listen(127.0.0.1)` with `EPERM`, so the
successful run used the same command with local-loopback permission.

## Result

```json
{
  "sdk_version": "1.29.0",
  "successful_headers": {
    "post_count": 4,
    "get_count": 1,
    "post_authorization": "present",
    "get_authorization": "present",
    "request_methods": ["POST", "POST", "GET", "POST", "POST"]
  },
  "rejection_401": {
    "status": 401,
    "error": {
      "constructor": "StreamableHTTPError",
      "name": "Error",
      "message": "Streamable HTTP error: Error POSTing to endpoint: probe 401",
      "code": 401
    },
    "request_methods": ["POST"],
    "post_authorization": "present"
  },
  "rejection_403": {
    "status": 403,
    "error": {
      "constructor": "StreamableHTTPError",
      "name": "Error",
      "message": "Streamable HTTP error: Error POSTing to endpoint: probe 403",
      "code": 403
    },
    "request_methods": ["POST"],
    "post_authorization": "present"
  }
}
```

## Conclusions

1. `requestInit.headers.authorization` reaches normal POST requests.
2. `requestInit.headers.authorization` reaches the GET/SSE request leg.
3. Credentialed 401/403 connection failures reject as `StreamableHTTPError`
   and expose the HTTP status as `.code`.

## Design consequences

M2 can pass `Authorization: Bearer <token>` directly through
`StreamableHTTPClientTransport`'s `requestInit.headers`; no guarded-fetch
wrapper is needed for the pinned SDK version.

The auth-failure classifier can depend on:

```text
error.constructor.name === "StreamableHTTPError"
error.code === 401 || error.code === 403
credential was injected
```

Hosted classification for unauthenticated 401/403 is covered by probe 50.
