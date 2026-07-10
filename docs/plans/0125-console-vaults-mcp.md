# Plan 0125 — Console Vaults/MCP Panel (browse, health, validate)

Date: 2026-07-10 (rev 3 — independent practicality review folded; see
§Review log)
Builds on: plan 0120 (console served from appliance, #157), plan 0122 §7A/§7B
(M2/M3 vaults + `mcp_oauth`, #171/#172).

## Context and decisions

M3 shipped the full `mcp_oauth` surface, but an operator has no way to see it.
The fleet-operational fields an operator most needs — `refresh_status`,
`next_refresh_at`, `refresh_attempts`, and `auth_hint_at` — are deliberately
absent from `/v1/vaults` because hosted does not expose them and `/v1` remains
wire-exact (probe 52). The OMA console is not parity-constrained.

Operational health belongs on the ADMIN tier. A new paginated admin endpoint
returns a token-free presentation record plus runtime metadata. It inherits the
admin prefix middleware and `RouteClass` accounting (app.ts:281-299, :893).
It is not gated on `OMA_ENABLE_MCP`: reading stored metadata causes no egress,
and vault CRUD is available when MCP execution is disabled.

**Do not merge `/v1` and `/admin` records in the browser.** The `/v1`
credential shape deliberately omits `auth_version`, so the former rev 2 join on
`(vaultId, credentialId, authVersion)` could not be constructed. Two separately
fetched datasets would not be atomic anyway. Instead the console has two clear
views:

1. **Workspace Vaults** uses only the workspace key and `/v1`. It provides
   wire-visible browsing and Validate.
2. **Admin Credential Health** uses only the admin key and the new `/admin`
   endpoint. The endpoint is the authoritative presentation record for that
   view.

This keeps the existing key-tier rule intact: the admin key goes only to
`/admin`, the workspace key only to `/v1` (`api.js:buildRequestHeaders`). It also
avoids minting a permanent, unrestricted workspace key merely to inspect health.
The existing explicit Mint key flow remains available when an operator actually
wants a workspace key; no new “Mint key & browse” shortcut is added.

**Scope: slices A-C only.** Credential lifecycle forms remain a named follow-up.

## Slice A — workspace vault browsing (zero backend work)

### Routing and loading

- Add “Vaults” to `NAV` as a real route, following the Files pattern. Support
  `#vaults` and `#vault=<encoded id>` in `routeHash`/`readRouteTarget`.
- Do not add vaults to `loadConsoleData`. Its all-or-nothing `Promise.all` is the
  critical boot path; a vault failure must not push the whole console into mock
  mode or delay first paint.
- On entering the Vaults list in live API mode, fetch only
  `/v1/vaults?include_archived=true` through the existing cursor pager. The list
  shows id, display name, created time, and archived state. **Do not show a
  credential count**: it is not present in the vault response and does not
  justify an N+1 fan-out.
- On opening one vault, fetch only that vault's credentials from
  `/v1/vaults/{vaultId}/credentials?include_archived=true`. The explicit query
  flag is required because archived credentials are hidden by default. The
  creation-side maximum is 20 active credentials, so one `limit=100` page is
  normally enough; still use the cursor helper and surface its safety-cap
  warning.
- List and detail have their own loading, error, empty, and retry states. A
  credential-detail failure does not invalidate the already loaded vault list.
- Keep warnings panel-local. Do not overwrite or append blindly to
  `apiState.warnings`, which owns the core boot resources and would otherwise
  lose or duplicate warnings across refreshes.
- Scope async results to a monotonically increasing workspace-load epoch plus
  the requested vault id. Changing the workspace key, leaving the detail, or
  opening another vault makes an older result stale; stale results are dropped
  rather than rendered under the new selection.

There is no arbitrary 50-vault ceiling and no concurrency-pool helper. A
workspace with 500 vaults can list all pages and open any one of them while
issuing only the requests the operator asked for.

### Rendering

- Vault detail shows credential id, display name, auth type, `mcp_server_url`,
  `expires_at` as a relative time, and archived state. For `mcp_oauth`, show the
  readable refresh subset: token-endpoint host, scope, and endpoint auth method.
- Render all server-controlled strings as React text children. Do not create
  `href` or `src` attributes from `mcp_server_url`, `token_endpoint`, probe
  response bodies, or other server-controlled strings.
- No consumed response contains a secret: M2's write-only API serialization is
  the primary guarantee. The UI mapper explicitly selects display fields rather
  than spreading raw API objects.

### Non-live modes

- Demo mode renders vault fixtures and returns a canned Validate result; it
  performs zero vault network calls.
- Mock/offline mode also renders fixtures and performs zero vault network calls,
  but Validate is disabled because the existing mock contract says live writes
  are unavailable. Demo and mock must not be treated as the same write mode.

## Slice B — admin credential health

### Backend

- Add a paginated store query such as
  `listWorkspaceCredentialAdminMetadata(workspaceId, opts)`. It joins
  `vault_credentials` to `vaults`, is workspace-scoped, includes archived
  vaults and credentials, orders deterministically by credential id descending,
  and uses the existing `limit <= 100`/cursor discipline. Archived credential
  history is unbounded, so a bare unbounded array is not acceptable here.
- The SELECT explicitly names only presentation and runtime columns. It never
  reads the secrets store or any sealed secret value. Returned fields:
  - `vaultId`, `vaultDisplayName`, `vaultArchivedAt`
  - `credentialId`, `credentialDisplayName`, `credentialArchivedAt`
  - `authType`, `mcpServerUrl`, `hasRefresh`, `authVersion`
  - optional `expiresAt`, `refreshStatus`, `refreshAttempts`, `nextRefreshAt`,
    `authHintAt`
- Add `GET /admin/workspaces/:id/mcp-credentials?limit=&page=` returning the
  ordinary paginated envelope `{data, has_more, next_page}`. This endpoint is
  intentionally not a bare-array admin list. Existing workspace/key endpoints
  predate pagination, but archived credential history can grow indefinitely and
  should not extend that precedent.
- The admin service checks that the workspace exists before listing, following
  `listKeys`: unknown workspace returns 404 rather than a misleading empty page.
- Wire the admin service to the narrow store capability it needs; update
  `AdminService`, `DefaultAdminService`, `ControlPlaneServices`, and deployment
  assembly construction explicitly. Do not reach through `VaultService` into a
  concrete SQLite store.

### Console

- Add “Credential health” on each AdminPanel workspace row. It opens an
  admin-only route keyed by the workspace id and fetches only the paginated admin
  endpoint. It never mints a workspace key and never calls `/v1`.
- Group rows by vault for readability, but pagination remains credential-based;
  grouping is presentation only and must tolerate a vault continuing on the
  next page.
- Health states are exhaustive:
  - green `ok`
  - yellow `transient`, including attempt count and next retry
  - red `invalid`
  - neutral `not attempted` when `hasRefresh` is true and `refreshStatus` is null
  - neutral `n/a` for static bearer or OAuth without refresh metadata
- Show expiry and next refresh as relative times, an auth-hint-pending badge when
  `authHintAt` is set, and archived vaults/credentials dimmed.
- Refresh is manual plus route entry. No polling.
- An admin 401 follows the existing admin reauthentication flow. Because this is
  an admin-only route, no workspace context has to survive or be reconstructed.
  After successful admin login, return to Admin; the operator can reopen health.

## Slice C — Validate in the workspace view

Validate is the console's first live `/v1` write under a workspace key. Existing
AdminPanel provisioning writes are already live `/admin` writes.

### Exact write capability

- `api.js` keeps deny-by-default enforcement at the private `request()`
  chokepoint: every non-GET `/v1` request is rejected before `fetch` unless it
  carries the module-private Validate capability.
- Export a purpose-specific
  `validateMcpOauthCredential(vaultId, credentialId, mode)` wrapper. It accepts
  only `mode === "api"`, constructs the encoded path itself, and invokes exactly
  `POST /v1/vaults/{vaultId}/credentials/{credentialId}/mcp_oauth_validate`
  with a module-private symbol/capability. The generic capability predicate
  matches the method and complete pathname, not merely a suffix.
- The React `apiState` remains React-owned; `api.js` does not reach into it or
  mirror it. The current mode is passed explicitly to the wrapper. Demo returns
  its canned result in the UI without calling the wrapper; mock disables the
  action.
- Tests call representative session-create, agent-create, POST/DELETE archive,
  and wrong-method validate paths through the request test seam and assert they
  throw before a network call. Only the exact Validate wrapper in API mode may
  issue a live `/v1` write.

### Interaction and results

- Show Validate only for non-archived `mcp_oauth` credentials. Use the existing
  `ConfirmDialog`: “Validate contacts the MCP server with this credential and
  may refresh the token at the provider.”
- Disable while the request is in flight. Do not add a client countdown timer:
  the server owns refresh admission and its 10-second floor begins at refresh
  admission, not when the browser receives a completed response.
- Classify four operator-facing outcomes:
  - `valid`: green “Credential works,” with probe status when present.
  - `invalid`: red “Re-authorize with the provider and rotate the credential,”
    with refresh and HTTP status when present.
  - `unknown` plus `refresh.status === "skipped"`: neutral “Refresh was skipped;
    the probe was inconclusive. The credential may have changed or been checked
    recently.” The wire response does not expose the coordinator's skip reason,
    so the UI must not claim this was definitely the cooldown.
  - other `unknown`: amber “Could not conclude (transient or unreachable); try
    again later.”
- Keep the result in the workspace detail view. There is no admin-health refetch
  because the workspace and admin views intentionally do not merge. An operator
  can manually refresh the admin health view when needed.
- Put the raw capped probe response behind a Details disclosure, rendered only
  as text. Surface the existing MCP-disabled 400 message on the result panel.

## Testing and acceptance

The console has no component-test harness: React is vendored UMD, JSX is
transpiled by Babel-standalone in the browser, and Vitest collects plain JS
helpers. Do not pretend pure tests prove JSX wiring.

### Automated browser-logic tests

Put deterministic logic in a plain `vaults-data.js` module:

- response-to-row allowlist mapping and URL-host formatting
- relative-time formatting, including invalid/missing timestamps
- exhaustive health-state classification, including refresh-capable/null status
- Validate outcome classification, including generic skipped handling
- stale-result epoch/vault-id predicate
- panel-local warning assembly

API tests cover list/detail URLs (`include_archived=true`), exact live-write
capability enforcement, and zero network calls in demo and mock modes. A seeded
raw object containing token-like fixtures must produce a mapped row containing
none of them.

Extend the existing console source-security test across the new files: no
persistent browser storage, console logging, `dangerouslySetInnerHTML`, or
server-derived `href`/`src` construction.

### Backend tests

- paginated envelope and deterministic continuation
- archived vault and credential rows included
- token-free serialization, including a sentinel secret absent from the body
- null refresh status preserved
- 404 for unknown workspace
- 401 without an admin key and with a workspace key
- cross-workspace isolation
- endpoint works with MCP execution disabled and causes zero egress

### Manual browser smoke (required before merge)

Boot the appliance and exercise the real no-build console:

1. Workspace-key login → Vaults list → archived vault → credential detail.
2. Switch quickly between two vault details and confirm stale results never
   replace the current selection.
3. Validate valid, invalid, skipped/unknown, and MCP-disabled fixtures.
4. Admin-key login → Credential health for an existing workspace without
   minting a workspace key; paginate and refresh.
5. Revoke/reject the admin key mid-view and confirm reauthentication is clear.
6. Demo and forced-offline/mock Vaults routes issue no network writes; mock
   Validate is disabled.

Record the smoke command/setup and result in the implementation PR. A component
harness remains a follow-up, but lack of one is not a reason to omit an honest
end-to-end acceptance check.

## Security checklist

- No secret reaches the browser: `/v1` uses the existing write-only serializer;
  `/admin` names only token-free columns; Validate bodies are capped and scrubbed
  server-side and rendered as text.
- Keys never cross tiers and never appear in URLs, hashes, storage, or logs.
- Admin health browsing does not create a new workspace credential.
- The only live `/v1` write capability is exact POST Validate, enforced before
  fetch by a module-private capability.
- Async workspace/detail results are scoped so data from an old key or selection
  cannot render under a new one.

## Deferred

- Credential lifecycle forms: create/rotate (write-only secret paste,
  immutability-aware), archive/delete with confirmation and their own write
  capability review.
- Component/browser test harness (Playwright or equivalent).
- Background health polling and fleet-wide rollup.
- Temporary/scoped/expiring workspace keys as a general key-management feature;
  this plan no longer depends on them.
- Vault-list credential counts. Add only if a backend count can be obtained
  without an N+1 request pattern and operators demonstrate a need.

## Current source anchors

- app.jsx: auth state :129, `loadLiveData` :140, login/browse flows :180-217,
  `go()` :219, `readOnly` :248, route selection :300-320.
- api.js: credential tiering :12-60, private `request` :62, admin API :94-130,
  cursor pager :158, `loadConsoleData` :190, pagination warnings :235.
- ui.jsx: `NAV` :68-72, `Sidebar` :74, ModeBar contracts :129-146.
- auth.jsx: `AdminPanel` :82, existing explicit mint/modal browse :120-126,
  :194-195.
- admin/routes.ts :11-55; admin/service.ts `listKeys` existence guard :70-75.
- vaults/types.ts: wire credential omits auth version :61-71; nullable runtime
  status :92-103.
- vaults/store.ts: active-only runtime read :244-249; credential-list archived
  default :469-487; deterministic cursor statements :877-914;
  `runtimeMetadata()` :1007.
- vaults/service.ts: active credential cap :29; wire mapper :793-804.
- vaults/mcp-oauth-validate.ts: the wire result exposes `skipped` but not the
  coordinator reason :138-147, :196-221.
- app.ts: admin prefix middleware :281-299, route mounts :333-343,
  deployment admin construction :661-669, `RouteClass` :891-899.

Re-confirm anchors before implementation; they are navigation aids, not a
substitute for reading the current code.

## Review log

Rev 2 folded a four-reviewer panel: archived mapper, central write gate, loading
blast radius, test-harness reality, admin envelope, floor mapping, demo behavior,
workspace-id reachability, 401 degradation, and source-anchor corrections.

Rev 3 folds an independent practicality review (2026-07-10): remove the eager
per-vault fan-out and arbitrary 50-vault ceiling; explicitly fetch archived
credentials; replace the impossible auth-version browser join with separate
workspace/admin views; remove automatic permanent-key minting; paginate the
admin health surface; add the null/not-attempted health state; make skipped
Validate wording truthful; define an exact method+pathname module-private write
capability without coupling `api.js` to React state; distinguish demo from mock;
scope stale async results and warning ownership; remove the redundant client
cooldown; and require a real manual browser smoke for the no-build JSX wiring.
