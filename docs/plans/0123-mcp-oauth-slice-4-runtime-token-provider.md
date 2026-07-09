# Slice 4 Plan — Fetch-Layer MCP Token Provider + 401-Hint Retry

Date: 2026-07-09
Parent plan: [0122 MCP connector](0122-mcp-connector.md), M3 §7B.
Implements: §7B.9 slice 4.

## Summary

Wire M3 OAuth credentials into the live MCP runtime without adding the
validate endpoint or ticker yet. After this slice, static bearer and OAuth
credentials are injected by a per-request fetch wrapper, OAuth tokens refresh
on stale/hinted use, warm MCP handles can pick up new tokens without
reconnecting, and MCP auth failures can force-refresh and retry one tool
request once.

Keep slice boundaries strict: no `mcp_oauth_validate`, no wake loop/ticker, no
deployment shutdown loop work.

## Key Changes

- Replace frozen MCP Authorization headers with a credential binding:
  - Change `McpCredentialResolver` to async and return a binding object:
    `fingerprint`, `identity`, `authorize()`, `forceRefresh()`, and
    `knownSecrets()`.
  - `identity` must include `{ workspaceId, vaultId, credentialId,
    authVersion, authType }`.
  - Fingerprint becomes `credentialId:authVersion`, not
    `credentialId:updatedAt`.

- Extend vault resolution for runtime use:
  - `VaultCredentialResolution` should include `vaultId`, `authType`,
    `authVersion`, `expiresAt`, `refreshStatus`, `authHintAt`, and the
    access/static token only.
  - OAuth resolution still returns only `access_token`, never the sealed JSON
    blob or refresh/client secrets.
  - Add a narrow auth-hint write path, preferably through
    `RefreshCoordinator`, fenced by `authVersion`.

- Move credential resolution into the parallel MCP dial path:
  - `prepareMcp` must resolve credentials inside the existing `Promise.all`
    dial map so N OAuth refreshes do not serialize N servers.
  - Preserve pre-commit `vaultIds` context for file-resource prewarming.

- Update `McpConnection.connect`:
  - Remove `requestInit.headers.Authorization`.
  - Wrap the supplied guarded fetch so every request calls
    `binding.authorize()` and sets `Authorization` on a fresh `Headers`.
  - Keep the underlying guarded fetch authoritative for SSRF and redirect
    policy.
  - Static bearer binding returns the cached token and never refreshes.
  - OAuth binding caches `{ accessToken, expiresAt, authVersion }` and calls
    `RefreshCoordinator` only when stale, hinted, forced, or version-changed.

- Keep scrubbing correct across token rotation:
  - Replace fixed `knownSecrets` arrays with `knownSecrets()` provider in the
    MCP bridge.
  - Provider returns current bearer + bare token and immediately previous
    bearer + bare token, longest-first if ordering is local.
  - Bound retained previous values to one prior token to avoid unbounded secret
    retention.

- Add 401-hint and retry-once behavior:
  - On MCP `callTool` transport rejection with code 401/403 and OAuth
    identity, stamp `auth_hint_at`.
  - Attempt one forced refresh if outside the per-credential forced-refresh
    floor.
  - If forced refresh succeeds, retry the same MCP tool request exactly once.
  - If refresh fails, is skipped by the floor, or the retry fails, use the
    existing auth-failed event path.
  - Do not retry aborts, timeouts, non-auth failures, unauthenticated
    connections, or static bearer connections.

## Test Plan

- Unit/bridge tests:
  - Per-request fetch injection uses token A for connect/discovery and token B
    for a later tool call on the same `McpConnection`.
  - Tool-result scrubbing catches a token produced after connection creation.
  - Static bearer still injects and scrubs correctly with no refresh calls.

- Runner tests:
  - Async credential resolution remains parallel across servers.
  - `credentialId:authVersion` resets MCP failure budget on auth rotation.
  - Cosmetic metadata/`updated_at` changes do not reset the failure budget.
  - Pre-commit session creation with `vault_ids` and file resources dials with
    credentials.

- OAuth refresh behavior:
  - Expired OAuth token refreshes before a request and the MCP server observes
    the fresh token.
  - Warm handle mid-turn refresh works without reconnect.
  - Auth 401/403 stamps hint, force-refreshes, retries once, and succeeds
    without surfacing a failure.
  - Repeated hostile 401s inside the forced-refresh floor do not hammer the
    token endpoint and surface the existing auth-failed signal.
  - Refresh failure never throws from the provider; stale token is injected and
    normal auth-failed handling proceeds.

- Regression gates:
  - Existing MCP suite remains green.
  - Existing slice 3 coordinator tests remain green.
  - Full suite must pass outside sandbox if listener tests hit `EPERM`.

## Assumptions and Defaults

- Use one guarded MCP fetch instance in default app wiring and pass it both to
  the runner and `RefreshCoordinator`.
- Use an in-process forced-refresh floor map in `RefreshCoordinator` for this
  slice; no new DB column.
- Keep the provider token cache in memory per connection; the store remains
  the source of truth for auth version and refresh persistence.
- Do not expose refresh token or client secret through any new runtime result
  object.
- Defer validate endpoint, proactive ticker, due-row claiming, and wake-loop
  shutdown wiring to later slices.

## Current Source Anchors

These are review anchors against the current branch at the time this handoff
was written; re-confirm before editing:

- `src/control-plane/sessions/pi/mcp/client.ts`: connect-time
  `authorization` is still passed through SDK `requestInit.headers`, and
  `callTool()` has no retry awareness.
- `src/control-plane/sessions/pi/mcp/bridge.ts`: `McpCredentialResolver` is
  still synchronous, `knownSecrets` is a fixed array, and
  `onTransportFailure` does not receive credential identity.
- `src/control-plane/sessions/pi/runner.ts`: credentials resolve before the
  parallel dial map and failure fingerprints still come from the current
  resolver result.
- `src/control-plane/vaults/oauth-refresh.ts`: `RefreshCoordinator` owns
  token-endpoint refresh and CAS/fencing, but does not yet expose the
  auth-hint / forced-refresh floor surface this slice needs.

