# Probe 50 — hosted vaults + `static_bearer` MCP auth

Date: 2026-07-08

Script: [`scratch/50-vaults-hosted-probe.py`](50-vaults-hosted-probe.py)

Purpose for plan 0122 M2: verify hosted Managed Agents vault/credential wire
shapes and capture a live `mcp_authentication_failed_error` frame for a
`static_bearer` credential rejected by a real MCP server.

Sources used before running:

- Local docs crawl: `/tmp/claude-docs/docs/managed-agents/vaults.md` and
  `/tmp/claude-docs/docs/managed-agents/mcp-connector.md`
- Generated SDK types under
  `node_modules/@earendil-works/pi-coding-agent/node_modules/@anthropic-ai/sdk/resources/beta/vaults/`

The script uses raw HTTPS rather than SDK bindings so the captured artifacts
reflect wire JSON directly. It redacts token-like fields and never prints the
API key.

## Run

```text
python3 scratch/50-vaults-hosted-probe.py
```

Requires `ANTHROPIC_API_KEY`. The run used model `claude-sonnet-5` and a
bogus `static_bearer` credential for `https://mcp.linear.app/mcp`.

Second account check: the same script was re-run on 2026-07-08 with
`ANTHROPIC_API_KEY` sourced from `/Users/oner/dev/junk/cwc-workshops/.env`
(overriding the ambient shell key). The M2-relevant results were unchanged:
same response shapes, same duplicate/immutability statuses, same
`vault_ids` echo, and same `mcp_authentication_failed_error` classification
for both bogus static-bearer and no-vault Linear MCP sessions.

## Confirmed wire shapes

Vault create/update/archive responses:

```json
{
  "id": "vlt_...",
  "archived_at": null,
  "created_at": "...",
  "display_name": "...",
  "metadata": { "...": "..." },
  "type": "vault",
  "updated_at": "..."
}
```

Credential create/retrieve/list/archive/rotate responses:

```json
{
  "id": "vcrd_...",
  "archived_at": null,
  "auth": {
    "mcp_server_url": "https://mcp.linear.app/mcp",
    "type": "static_bearer"
  },
  "created_at": "...",
  "display_name": "...",
  "metadata": { "...": "..." },
  "type": "vault_credential",
  "updated_at": "...",
  "vault_id": "vlt_..."
}
```

Observed top-level credential keys:

```json
[
  "archived_at",
  "auth",
  "created_at",
  "display_name",
  "id",
  "metadata",
  "type",
  "updated_at",
  "vault_id"
]
```

Observed `auth` keys for `static_bearer`:

```json
["mcp_server_url", "type"]
```

Secret fields (`token`) were absent from all returned credential JSON.

## Confirmed constraints

| Case | Hosted result |
|---|---|
| Duplicate active `mcp_server_url` in the same vault | 409 `invalid_request_error` |
| Update `mcp_server_url` on an existing static bearer credential | 400 `invalid_request_error` |
| Rotate token with same `mcp_server_url` | 200, same credential id |
| Archive credential | 200, `archived_at` set |
| Create replacement for archived credential with same `mcp_server_url` | 200 |
| Archive vault | 200, `archived_at` set |
| Delete vault | 200 `{ "id": "vlt_...", "type": "vault_deleted" }` |

## Pagination

One-page list responses include only:

```json
{ "data": [...] }
```

A targeted two-vault pagination check with `limit=1` returned:

```json
{
  "keys": ["data", "next_page"],
  "len": 1,
  "next_page": "page_..."
}
```

The terminal page again omitted `next_page` rather than returning
`"next_page": null`.

M2 should model `next_page` as optional on raw JSON, even though the SDK page
wrapper exposes `next_page: string | null`.

## Session `vault_ids`

Session create with:

```json
{ "vault_ids": ["vlt_..."] }
```

returned a session object whose keys included `vault_ids`, and the value echoed
the submitted order:

```json
{
  "vault_ids": ["vlt_..."]
}
```

## Runtime auth failures

Setup:

- Agent declares MCP server:
  `{"type":"url","name":"linear","url":"https://mcp.linear.app/mcp"}`
- Toolset uses `always_allow`.
- Vault contains one `static_bearer` credential for the exact same URL, with a
  bogus token.
- Environment networking sets `allow_mcp_servers: true`.
- A user message asks the agent to use the Linear MCP server.

Captured event:

```json
{
  "type": "session.error",
  "error": {
    "type": "mcp_authentication_failed_error",
    "mcp_server_name": "linear",
    "message": "...",
    "retry_status": {
      "type": "exhausted"
    }
  }
}
```

This closes the M1 caveat: `mcp_authentication_failed_error` is not only an SDK
type; hosted emits it live for a credentialed MCP 401/403-class rejection.

The same probe also created a second session with the same agent/environment
but **no `vault_ids`**. Hosted returned `vault_ids: []` on the session and the
same error discriminator when Linear rejected the unauthenticated MCP connect:

```json
{
  "type": "session.error",
  "error": {
    "type": "mcp_authentication_failed_error",
    "mcp_server_name": "linear",
    "message": "...",
    "retry_status": {
      "type": "exhausted"
    }
  }
}
```

So hosted classifies MCP 401/403 as `mcp_authentication_failed_error` even when
no vault credential was attached. M2 should not require "credential was
injected" as a precondition for this discriminator.

## Cleanup

The script archives/deletes the session, archives the agent, archives/deletes
the environment, and deletes the vault. Hosted may reject immediate session
archive/delete while the session is still settling after the auth failure, so
cleanup retries briefly. A manual retry after the first run confirmed the
session reached `terminated` and then deleted successfully.

## Design consequences

- M2 credential response type should include `display_name`, `metadata`,
  `vault_id`, timestamps, `archived_at`, and `auth` without secret fields.
- `static_bearer.auth` response contains only `{type, mcp_server_url}`.
- Duplicate active URL should be 409.
- Structural URL update should be 400.
- Archived credentials free the URL key.
- Raw list `next_page` should be optional, not required-null.
- `sessions.create` must persist/echo `vault_ids` order-stably.
- Runtime classification rule is confirmed: MCP 401/403 from a reached server
  produces `mcp_authentication_failed_error`, with or without an attached
  vault credential.
