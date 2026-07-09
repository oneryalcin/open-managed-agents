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
  - `authorize()` returns the header value together with the identity snapshot
    that produced it. MCP request handling retains that call-local snapshot so
    a later 401 is fenced by the token's actual `authVersion`, not a mutable
    connection-wide version that another parallel call may already have moved.
  - Use Node `AsyncLocalStorage` for that correlation: each high-level MCP
    connect, discovery, or tool-call operation gets an isolated context; the
    fetch wrapper records every authorization snapshot used and records the
    matching snapshot when its response is 401/403. The operation catch path
    attaches that snapshot to the classified failure. Never use a
    connection-global "last authorization" slot.
  - `identity` must include `{ workspaceId, vaultId, credentialId,
    authVersion, authType }`.
  - Fingerprint becomes `credentialId:authVersion`, not
    `credentialId:updatedAt`.

- Extend vault resolution for runtime use:
  - `VaultCredentialResolution` should include `vaultId`, `authType`,
    `authVersion`, `expiresAt`, `refreshStatus`, `authHintAt`, and the
    access/static token only.
  - Add a metadata-only runtime read returning `vaultId`, `credentialId`,
    `authType`, `authVersion`, `expiresAt`, `refreshStatus`, `authHintAt`,
    `nextRefreshAt`, and `refreshAttempts` without reading or decrypting the
    sealed secret. `authorize()` performs this cheap read on every request and
    re-resolves the token only when `authVersion` changes or an admitted refresh
    is due.
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
  - Static bearer binding returns the cached token, never invokes OAuth
    refresh, and re-resolves only when the metadata-only read observes an
    `authVersion` change.
  - OAuth binding caches `{ accessToken, expiresAt, authVersion }` and calls
    `RefreshCoordinator` only when stale and due, hinted, forced, or
    version-changed. A transient failure's persisted `nextRefreshAt` suppresses
    repeated lazy attempts until due; hint-triggered attempts remain governed
    by the forced-refresh floor.
  - For lazy admission, `nextRefreshAt` absent or at/before now is due. An
    `invalid` credential, a fixed-token OAuth credential with no refresh block,
    or a transient credential whose `nextRefreshAt` is still future injects the
    cached stale token without a refresh attempt.
  - After every coordinator outcome, including `outcome: "ok"` with
    `persisted: "stale"`, re-resolve the current persisted credential and
    update the binding cache. The store, never an unpersisted refresh result,
    is authoritative for the token used by a retry.
  - If the metadata read no longer finds an active credential, immediately
    clear the cached authorization and fail locally before egress. Retain prior
    token values only for scrubbing, mark the connection to close, classify the
    local error through the connection-failed path, and do not refresh or retry
    the revoked binding.

- Keep scrubbing correct across token rotation:
  - Replace fixed `knownSecrets` arrays with `knownSecrets()` provider in the
    MCP bridge.
  - Retain every bearer value handed out by the binding for that connection's
    lifetime. `knownSecrets()` returns each full bearer and bare token; the
    existing scrubber owns deduplication and longest-first ordering.
  - Release the retained set when the MCP connection closes. Do not use a
    one-previous-token bound: an in-flight request using token A must remain
    scrub-safe across A -> B -> C rotation.

- Add 401-hint and retry-once behavior:
  - The MCP bridge owns tool retry because it owns the tool-call context.
    `forceRefresh()` is async and returns a discriminated result:
    `ready`, `skipped_floor`, or `failed`. `ready` means the binding has
    re-resolved a currently persisted token after coordinator success, or that
    re-resolution found a token/version changed from the rejected call's
    snapshot. It includes CAS-loss cases where another writer's token won.
    A failed/skipped coordinator outcome with the same persisted token is not
    `ready`.
  - On MCP `callTool` transport rejection with code 401/403 and OAuth identity,
    stamp `auth_hint_at`, fenced by the rejected binding's `authVersion`, then
    call `forceRefresh()`.
  - In `RefreshCoordinator`, check and join the per-credential single-flight
    before consulting the forced-refresh floor. If no flight exists, record the
    floor timestamp when the forced attempt is admitted, not when it completes.
    Hint-triggered refresh uses this same admission path.
  - If `forceRefresh()` returns `ready`, retry the same MCP tool request exactly
    once. Do not emit/count the first rejection.
  - If refresh fails, is skipped by the floor, or the retry fails, use the
    existing failure path. Refresh failure/floor skip and a final 401/403 remain
    auth failures; if the retry returns another status, classify the final
    status rather than the first rejection.
  - Do not retry aborts, timeouts, non-auth failures, unauthenticated
    connections, or static bearer connections.
  - Operation timeouts remain per attempt: a call, refresh, and retry may each
    consume their configured timeout. Re-check the tool-call abort signal after
    refresh and do not launch the retry if the turn was cancelled meanwhile;
    terminalize it as aborted without a connection-failure event or budget
    increment.

- Recover clock-valid revoked credentials during initial dial:
  - On connect or discovery rejection with code 401/403 and OAuth identity,
    use the same fenced hint + forced-refresh path and redial once when it
    returns `ready`.
  - Do not count or emit the first auth rejection. Count and surface only the
    final failure; never redial more than once and never apply this path to
    static, unauthenticated, timeout, or non-auth failures.

- Wire the runtime provider in the default app composition:
  - Hoist creation of one guarded MCP fetch into default app wiring, construct
    one `RefreshCoordinator` with the vault store and that fetch, and pass the
    same fetch to the runner plus the coordinator to the credential resolver.
  - Preserve the existing explicit runner/MCP test override seam.

## Test Plan

- Unit/bridge tests:
  - Per-request fetch injection uses token A for connect/discovery and token B
    for a later tool call on the same `McpConnection`.
  - Tool-result scrubbing catches a token produced after connection creation.
  - A tool request sent with token A remains in flight while the binding rotates
    A -> B -> C; an echoed A is still scrubbed from events and model output.
  - Static bearer still injects and scrubs correctly with no refresh calls.
  - Metadata-only checks on unchanged credentials perform no secret-store
    reveal; rotating an unexpired credential without a 401 makes the same warm
    connection use the new token on its next request.
  - Archiving or deleting a credential clears the binding cache, sends no
    further outbound request with the old token, and closes the warm handle;
    retained values still scrub any already in-flight response.

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
  - A forced refresh that loses its CAS to operator rotation re-resolves the
    operator's token, retries with it, and never uses the discarded token.
  - Parallel calls retain distinct authorization snapshots: if a token-A call
    fails after another call advances the binding to B, the hint write is still
    fenced with A's version.
  - Simultaneous 401s join one admitted forced-refresh single-flight before the
    floor check; the token endpoint sees one request and all waiters observe the
    same persisted token.
  - Repeated hostile 401s inside the forced-refresh floor do not hammer the
    token endpoint and surface the existing auth-failed signal.
  - Repeated requests after a transient lazy-refresh failure observe
    `nextRefreshAt`, inject the stale token, and do not call the token endpoint
    again before the backoff is due.
  - `invalid` status and fixed-token OAuth credentials past expiry inject stale
    without attempting refresh, then follow normal auth-failure handling.
  - Refresh failure never throws from the provider; stale token is injected and
    normal auth-failed handling proceeds.
  - Connect/discovery 401/403 on a clock-valid OAuth token stamps a hint,
    refreshes, redials once, and succeeds without consuming the failure budget;
    hostile repeated auth failure is redialed only once.
  - Abort arriving during forced refresh suppresses the tool retry. Tests treat
    operation timeouts as per-attempt budgets rather than one shared deadline,
    and assert an aborted terminal result with no connection-failure event or
    budget increment.
  - If the retry fails with a non-auth status, the terminal event classifies
    that final status; it is not mislabeled from the initial 401/403.

- Composition test:
  - Default app wiring gives the runner and `RefreshCoordinator` the same
    guarded fetch and leaves the explicit MCP override seam intact.

- Regression gates:
  - Existing MCP suite remains green.
  - Existing slice 3 coordinator tests remain green.
  - Full suite must pass outside sandbox if listener tests hit `EPERM`.

## Assumptions and Defaults

- Use an in-process forced-refresh floor map in `RefreshCoordinator` for this
  slice; no new DB column.
- Keep the provider token cache in memory per connection; the store remains
  the source of truth for auth version and refresh persistence.
- A metadata-only store read per MCP HTTP request is accepted; a secret-store
  read/decrypt per request is not.
- Retain all tokens issued by a binding until its connection closes. Session
  lifetime bounds retention; credential confidentiality takes priority over a
  one-token history cap.
- Operation timeouts are per attempt, not a shared call-refresh-retry deadline.
- Retry assumes protocol-conforming 401/403 responses reject authentication
  before tool execution. OMA accepts an at-least-once residual for a broken or
  hostile server/proxy that executes a side-effecting tool and then falsely
  returns 401/403; there is no MCP idempotency key or declaration to gate on.
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
