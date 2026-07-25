# 0144 — Guided MCP OAuth lifecycle in the console

Date: 2026-07-23
Builds on: 0122–0125 (`mcp_oauth`, runtime refresh, validation, console vaults)

## Outcome

A workspace user can add a URL-based, standards-compliant remote MCP server,
click **Connect**, complete OAuth authorization in a browser, and receive an
encrypted `mcp_oauth` vault credential without seeing or pasting an access or
refresh token. The existing session MCP runtime remains the only token consumer
and continues to own automatic refresh.

This slice deliberately does not add an MCP marketplace, provider-specific
OAuth adapters, stdio OAuth, or hosted deployment/analytics work.

## Protocol and security decisions

- Use the pinned MCP SDK's OAuth client implementation for RFC 9728 protected
  resource discovery, RFC 8414/OIDC authorization-server discovery, client
  registration, OAuth 2.1 authorization code + PKCE, resource indicators, and
  code exchange. Do not create a second hand-written OAuth implementation.
- All discovery, registration, and token requests use OMA's SSRF-guarded MCP
  fetch and a bounded timeout/body wrapper. Redirects remain disabled.
- Authorization attempts are process-local, expire after ten minutes, and are
  single-use at callback. Each attempt binds an opaque public flow id and a
  separate high-entropy OAuth `state` to one workspace, vault, server URL, and
  operation (`connect` or `reauthorize`). Restarting OMA invalidates pending
  attempts and never affects completed credentials.
- The callback cannot depend on the console's `SameSite=Strict` workspace
  cookie because it arrives cross-site from the authorization server. It uses
  only the server-held state binding; start/status/reauthorize still require the
  authenticated workspace cookie and same-origin writes.
- Tokens, client secrets, authorization codes, and PKCE verifiers never enter a
  console JSON response, URL hash, browser storage, application log, or error
  message. The callback returns a fixed safe HTML completion/failure page.
- Successful connect creates the existing `mcp_oauth` credential shape.
  Successful reauthorization rotates the existing credential's encrypted
  access/refresh tokens. Existing scheduling, refresh coordinator, validation,
  archive, and session injection paths remain authoritative.
- A callback consumes state before exchanging the code. Duplicate callbacks
  are rejected and cannot exchange or overwrite credentials twice.

## API surface (OMA console extension)

These routes live under `/console`, not CMA-compatible `/v1`:

- `POST /console/mcp-oauth/flows`
  - body: `vault_id`, `mcp_server_url`, optional `display_name`
  - authenticates the workspace console session and same-origin request
  - returns `{ flow_id, authorization_url, expires_at }`
- `POST /console/mcp-oauth/reauthorize`
  - body: `vault_id`, `credential_id`
  - requires an active `mcp_oauth` credential in the same workspace
  - returns the same start response
- `GET /console/mcp-oauth/flows/:flowId`
  - workspace-bound status: `pending | completing | connected | failed |
    expired`, plus a stable safe error code/message and credential id when
    connected
- `GET /console/mcp-oauth/callback?code=&state=`
  - consumes the attempt, exchanges the code, persists the credential, and
    returns fixed HTML that notifies/closes the popup
  - OAuth callback errors (`error`, `error_description`) are normalized to safe
    user-facing failure states; provider text is not reflected into HTML

Existing `/v1` endpoints remain responsible for Validate and archive/delete.
The console adds only exact, named write capabilities for credential archive
and the console OAuth flow endpoints.

## Console interaction

- “Add credential” offers **OAuth connection** (default) and **Static bearer**.
  OAuth asks only for a display name and MCP server URL; no token fields exist.
- Connect opens a popup synchronously, starts the server flow, navigates the
  popup to the returned authorization URL, and polls status as a fallback to a
  same-origin `postMessage` completion notification.
- Popup blocking, unsupported registration/discovery, provider denial,
  callback failure, expiry, and lost appliance state have distinct actionable
  messages.
- Active OAuth rows expose Validate, Reauthorize, and Disconnect. Disconnect
  archives the credential after confirmation; secrets remain encrypted history
  and are no longer resolvable by sessions.
- The existing session form remains the vault-attachment surface. No MCP token
  or credential id is copied into the agent/session configuration.

## Verification

Automated tests:

1. Hermetic OAuth/MCP fixture proves discovery -> DCR -> PKCE authorization ->
   callback code exchange -> encrypted credential creation. Responses and logs
   contain no token/code/verifier/client secret.
2. State is workspace-bound, ten-minute bounded, single-use, and callback-safe
   without a cookie. Wrong/expired/replayed state performs no token request.
3. Reauthorize rotates rather than duplicates; disconnect archives; status and
   validation continue to use existing endpoints.
4. Unsupported discovery/registration, user denial, malformed callback, token
   endpoint error, timeout/body cap, and SSRF rejection map to stable states.
5. Console API guards deny representative unrelated writes before fetch; UI
   helpers cover popup/status state mapping without persistent browser storage.
6. Existing refresh and MCP bridge suites prove that the resulting credential
   refreshes automatically and supplies a bearer token to an MCP tool call.

Manual acceptance before merge:

1. Start the loopback appliance and open Vaults.
2. Create/open a vault, enter `https://mcp.notion.com/mcp`, click Connect, and
   complete consent in the popup without copying a token.
3. Observe Connected, run Validate, create an agent with the same MCP URL,
   attach the vault to a new session, and successfully invoke one Notion tool.
4. Reauthorize and repeat Validate; then Disconnect and confirm the credential
   is no longer usable for a new session.
