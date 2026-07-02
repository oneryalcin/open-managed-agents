# 0113 Hosted Managed Agents auth wire probe

Date: 2026-07-02

Evidence note for issue #129 and plan 0113. Probes the hosted Anthropic API's
authentication failure shapes and middleware ordering so OMA's workspace
authentication stays wire-compatible.

## Environment

- Host: macOS arm64, Darwin 25.4.0
- Probe: Python 3 `urllib` against `https://api.anthropic.com`
- Endpoints: `GET /v1/agents` (Managed Agents beta), `GET /v1/messages`,
  `GET /v1/definitely-not-a-route`
- Invalid-key probes used `x-api-key: sk-ant-invalid-probe-key`; valid-key
  probes used a real key from the local environment for read-only `GET
  /v1/agents` only.

## Results

| # | Request | Status | Body |
| --- | --- | --- | --- |
| 1 | `/v1/agents`, no key, beta + version headers | 401 | `authentication_error` / `"Authentication failed"` |
| 2 | `/v1/agents`, invalid key, beta + version | 401 | same as 1, byte-identical message |
| 3 | `/v1/agents`, no key, no beta | 401 | same as 1 |
| 4 | `/v1/agents`, no key, no beta, no version | 401 | same as 1 |
| 5 | `/v1/agents`, invalid key, no version | 401 | same as 1 |
| 6 | `/v1/agents`, valid key, no beta | 404 | `not_found_error` / `"not found"` (lowercase) |
| 7 | `/v1/agents`, valid key, wrong beta value | 404 | same as 6 |
| 8 | `/v1/agents`, valid key, beta, no version | 400 | `invalid_request_error` / `"anthropic-version: header is required"` |
| 9 | `/v1/agents`, valid key, no beta, no version | 404 | same as 6 (beta gate wins over version check) |
| 10 | `/v1/definitely-not-a-route`, no key | 404 | `not_found_error` / `"Not found"` (capitalized) |
| 11 | `GET /v1/messages`, invalid key | 405 | `invalid_request_error` / `"Method Not Allowed"`, **no `request-id` header** |
| 12 | `PATCH /v1/agents`, no key, beta + version | 405 | `invalid_request_error` / `"Method Not Allowed"`, with `request-id` |
| 13 | `PATCH /v1/agents`, invalid key, beta + version | 405 | same as 12 |
| 14 | `DELETE /v1/agents`, no key, beta + version | 405 | same as 12 |
| 15 | `PUT /v1/agents`, no key, no beta | 405 | same as 12 |

Exact 401 envelope (all auth failures, missing and invalid key identical):

```json
{
  "type": "error",
  "error": {
    "type": "authentication_error",
    "message": "Authentication failed"
  },
  "request_id": "req_011Ccd2Hc6Y7uEkt1ALgPCNC"
}
```

The body `request_id` matches the `request-id` response header. Content type
is `application/json`.

## Ordering conclusion

Empirical middleware order of the hosted API:

```text
1. route+method match  unknown path -> 404; known path, unsupported method
                       -> 405, both even with no credentials
2. authentication      matched route+method, missing/invalid key -> 401,
                       before beta/version
3. beta gate           valid key, missing/wrong anthropic-beta -> 404 "not found"
4. version check       valid key + beta, missing anthropic-version -> 400
```

Notes:

- One generic `"Authentication failed"` message for both missing and invalid
  keys: no information leak about key existence. OMA must do the same.
- Unauthenticated callers CAN distinguish existing routes (401) from unknown
  routes (404). Parity means scoping OMA's auth middleware to known route
  prefixes rather than all paths.
- OMA's current beta-gate 404 message `"not found"` already matches row 6.
- OMA does not implement the `anthropic-version` required check (row 8) at
  all. Separate parity gap, out of scope for #129; belongs with the #64
  header-parity work.
- Rows 12-15 (probed 2026-07-02, second pass): unsupported methods on a known
  Managed Agents path return 405 **before** authentication — same pre-auth
  routing stage as the 404 for unknown paths. OMA currently returns 404 for
  these (`PATCH /v1/agents` -> 404 "Route not found" with beta, 404 "not
  found" without), so a 405-vs-404 method-parity gap exists independent of
  auth. With prefix-scoped auth middleware, OMA's unauthenticated unsupported
  methods become 401 instead; plan 0113 D4 documents this as an accepted
  divergence, with true 405 parity deferred to the #64 header/method parity
  area.
- Row 11 (405 without `request-id` on `/v1/messages`) vs rows 12-15 (405 with
  `request-id` on `/v1/agents`): the missing header is route-specific trivia,
  not load-bearing.
