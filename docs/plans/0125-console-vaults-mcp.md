# Plan 0125 — Console Vaults/MCP Panel (browse, health, validate)

Date: 2026-07-10 (rev 2 — panel review folded: Codex P2, Codex-adv 3,
Sonnet 11, Opus 10 findings; see §Review log)
Builds on: plan 0120 (console served from appliance, #157), plan 0122 §7A/§7B
(M2/M3 vaults + mcp_oauth, #171/#172).

## Context and the central decision

M3 shipped the full `mcp_oauth` surface, but an operator has no way to SEE
it. Worse: the data an operator most needs — `refresh_status`,
`next_refresh_at`, `refresh_attempts`, `auth_hint_at` — is DELIBERATELY
absent from `/v1/vaults` responses, because hosted does not expose it and
`/v1` is wire-exact (probe 52). The console is OMA's own product surface
with no parity constraint: this is where OMA gets to be better than hosted,
not just equal.

**Decision: operational health data is exposed on the ADMIN tier**, not
`/v1`. `GET /admin/workspaces/:id/mcp-credentials` returns token-free
runtime metadata. Rationale: refresh health is fleet-operational (the
appliance operator's concern), `/v1` stays wire-pure, and the console
already holds the admin key in its two-tier model (plan 0120: admin key →
`/admin`, workspace key → `/v1`, keys never cross — api.js
`buildRequestHeaders` :41). The new route inherits the admin prefix
middleware (app.ts:281-299) and RouteClass accounting (app.ts:893)
automatically — no new gate, no client tiering change (review: Opus
CONFIRMED SOLID).

**Scope: slices A–C only.** Create/rotate/archive credential forms are
DELIBERATELY DEFERRED (named slice D, sketched at the bottom).

**Write posture, stated precisely (review: Sonnet 6 — the first draft's
"console's first live write" was wrong).** The AdminPanel already performs
live `/admin` writes (createWorkspace / mintKey / revokeKey, auth.jsx:82ff),
ungated by `readOnly`. The `readOnly` guard (app.jsx:248) covers `/v1`
resource mutations, all demo-only today. Validate is therefore the first
live **`/v1` write under the workspace key** — and it gets STRUCTURAL
enforcement, not convention (review: Codex-adv high): see slice C.

## Slice A — read-only vault browsing (zero backend work)

- Sidebar: "Vaults" entry added to the `NAV` array (ui.jsx:68-72),
  **first-class route following the Files pattern** — real route +
  `routeHash` deep-linking (app.jsx:77-96). NOT the Environments pattern:
  Environments is a dim placeholder, not a route (review: Codex-adv med).
- **Loading contract (review: Opus BLOCKER 2 / Codex-adv med / Sonnet 2 —
  three reviewers): vaults are NOT added to `loadConsoleData`.** That
  function is one `Promise.all` on the critical boot path (api.js:190);
  one failing vault fetch would drop the whole console to mock mode
  (app.jsx:172) and the fan-out would gate first paint. Instead:
  - `loadVaultsData()` in api.js, called lazily on entering the Vaults
    route (and by the panel's Refresh button). Panel-scoped
    loading/error states; a total failure shows `ErrorState` in the
    panel only — sessions/agents/files are untouched by construction.
  - Fetch vault pages first (`fetchCursorPages("/v1/vaults?include_archived=true")`,
    existing helper :158, `PAGE_LIMIT=100`), then credential pages per
    vault with **concurrency 4**, capped at the **first 50 vaults**
    (excess → a warnings entry naming the count dropped).
  - Per-vault credential failure does NOT reject the whole load: that
    vault's row renders with a "credentials unavailable" marker and a
    warnings entry; other vaults render normally.
  - Truncation/partial data surfaces through the EXISTING `warnings`
    strings mechanism (api.js `paginationWarnings` :235 → ModeBar,
    ui.jsx:145). `PartialNotice` is a design-preview component wired to
    the tweaks panel, not the real mechanism (review: Opus 9) — do not
    use it for live partial data.
  - Fact correction (review: Sonnet 11 / Opus 8): there is no 20-item
    wire page cap; `MAX_CREDENTIALS_PER_VAULT = 20` (service.ts:29) is a
    creation-side cap, and the console pages with `limit=100` — so one
    credential page per vault in practice.
- Views, following the existing list/detail pattern:
  - Vaults list: id, display_name, credential count, created, archived
    badge.
  - Vault detail: credential table — id, display_name, auth type,
    `mcp_server_url`, `expires_at` (relative), archived badge; for
    mcp_oauth the readable `refresh` subset (token_endpoint host, scope,
    auth method).
  - No secret exists in any consumed response (M2 write-only
    enforcement) — the UI never holds a secret. Test via the pure
    mapping layer (see §Testing reality), not DOM.
- Demo mode: vault fixtures in data.js; `loadVaultsData` is never called
  in demo mode (route renders fixtures directly, matching the existing
  demo contract).

## Slice B — health column (one new admin endpoint + UI)

Backend:
- Store: `listWorkspaceCredentialRuntimeMetadata(workspaceId)` — a NEW
  prepared statement over all vault_credentials in the workspace
  including archived rows (the existing per-credential statement
  hardcodes `archived_at IS NULL`, store.ts:244-249), selecting the
  runtime columns PLUS `archived_at`. The `runtimeMetadata()` mapper and
  its type are **extended** with `archived: boolean` (review: Codex P2 /
  Opus 5 / Sonnet 5 — the current mapper has no archived field; "reuse"
  in the first draft was wrong). Still token-free by construction: the
  SELECT never touches the sealed blob.
- Admin service + route: `GET /admin/workspaces/:id/mcp-credentials` →
  **bare array** (admin-tier convention: listWorkspaces/listKeys return
  bare arrays, admin/routes.ts:21,:40, documented in api.js:94 — the
  first draft's `{data}` envelope imported the /v1 shape; review:
  Sonnet 3 / Opus 5). Fields: vaultId, credentialId, authType,
  hasRefresh, authVersion, expiresAt?, refreshStatus, refreshAttempts,
  nextRefreshAt, authHintAt, archived.
- **Existence guard** (review: Opus 6): the service method checks
  `getWorkspace` first and 404s on unknown workspace — the `listKeys`
  pattern (service.ts:71-73); a naive SELECT would return 200 `[]`.
- Gate: NOT gated on OMA_ENABLE_MCP (DB read, no egress; matches M2's
  ungated vault CRUD posture). static_bearer rows included (authType
  lets the UI show "n/a").

Console — the workspace-id problem and the merged-state paths (review:
Opus BLOCKERS 1 and 3 — the first draft was unbuildable: the console
never retains a workspace id, and the only path to holding both keys was
minting a fresh key from the create-workspace modal):
- `browseAsWorkspace(plaintextKey)` becomes
  `browseAsWorkspace(plaintextKey, workspaceId)`; the minted-key modal
  (auth.jsx:195) passes `minted.workspace_id`; the id is stored in app
  auth state and used for the health fetch and slice C's post-validate
  refetch.
- AdminPanel workspace rows gain a **"Mint key & browse"** action
  (reusing the existing mint flow + modal), so an operator reaches any
  EXISTING workspace's vault health without creating a workspace. This
  supplies the workspace id by construction. Minted browse keys are
  ordinary keys — name them `console-browse` so operators can recognize
  and revoke them in the existing key list; auto-expiry is out of scope
  (noted in Deferred).
- **Health availability rule (decision-complete):** the health column
  is available iff the session entered the workspace via an admin
  browse path (workspace id known AND admin key held). A
  pasted-workspace-key session (workspaceLogin) has no workspace id and
  shows the wire-visible columns with one hint line: "Refresh health
  requires browsing from the operator panel." No /admin call is
  attempted in that state.
- **Admin-401 mid-session** (review: Opus 4): if the health fetch 401s,
  `clearKeyForPath` has already nulled the admin key (api.js:54-60) —
  the panel must then set `auth.admin = false`, render the health column
  in its unavailable state with a "re-enter the admin key" hint wired to
  the existing `reauth()` path, and stop issuing /admin calls. Pinned by
  a test.
- Rendering: status pill 🟢 ok / 🟡 transient (with attempts) /
  🔴 invalid / ⚪ n/a (static_bearer or no refresh); `expires_at` and
  `next_refresh_at` as relative countdowns; "401 hint pending" badge
  when `authHintAt` set; archived rows dimmed.
- Refresh cadence: manual Refresh button + reload on route entry. NO
  background polling in this arc.

## Slice C — Validate button (first live /v1 write)

- **Structural write gate (review: Codex-adv high — convention is not a
  boundary):** api.js's single `request()` chokepoint (:62) gains a
  live-write allowlist: any non-GET to `/v1/*` whose path does not match
  the allowlist (exactly one entry: `/mcp_oauth_validate` suffix) throws
  client-side before fetch. The allowlist ALSO requires
  `apiState.mode === 'api'` — in demo mode no live action ever fires
  (review: Sonnet 7): the demo Validate click returns a canned fixture
  response (demo contract: "local interactions mutate bundled demo data
  only", ui.jsx:135-139). Tests attempt representative blocked writes
  (session create, agent create, a DELETE) through `request()` and
  assert they throw without a network call.
- Placement: per-credential action in vault detail, only for
  `auth.type === "mcp_oauth"` and not archived (API 400s both); enabled
  especially when status is `invalid` — validate is the only way to
  clear it (the ticker skips invalid rows).
- **Confirm dialog** (review: Opus 7 — every other live write uses
  `ConfirmDialog`, detail.jsx:485-496): "Validate contacts the MCP
  server with this credential and may refresh the token at the
  provider." Then POST `/v1/vaults/{v}/credentials/{c}/mcp_oauth_validate`
  with the workspace key; spinner while running.
- Result mapping — FOUR operator-facing outcomes (review: Sonnet 4 —
  the floor is not a server problem):
  - `valid` → green "Credential works." (probe status shown)
  - `invalid` → red "Re-authorize with the provider and rotate the
    credential." (`refresh.status` + refresh http status shown)
  - `unknown` + `refresh.status === "skipped"` → grey "Validated too
    recently — the refresh attempt was skipped (server cooldown). The
    result reflects the probe only; retry shortly."
  - other `unknown` → amber "Could not conclude (transient or
    unreachable) — try again later."
  After a completed validate the button disables for 10s client-side,
  matching the server's validate floor, so the skipped state is hard to
  produce accidentally.
- Raw response behind a collapsible "details" disclosure rendered as
  text children only — `mcp_probe.http_response.body` is
  server-controlled text (scrubbed server-side, M3), and the console
  adds no markup path on top (see §Testing reality for how this is
  pinned without a DOM harness).
- Post-validate: re-fetch the health rows (admin path available) so a
  cleared `invalid` flips green without reload; workspace-only sessions
  just show the result panel.
- MCP disabled on the deployment: surface the wire-shaped 400 text
  verbatim ("MCP is disabled on this deployment") on the result panel;
  the button stays visible so operators learn the gate exists.

## Testing reality (review: Sonnet 1 — HIGH; the first draft promised DOM
tests the repo cannot run)

The console has NO component-test harness: React is vendored UMD loaded
in-browser, JSX is transpiled by Babel-standalone (`index.html:21-29`),
and vitest collects only `ui/**/*.test.js` (vitest.config.ts:5) — pure
functions from plain .js modules (precedent: api.test.js). Building a
jsdom harness is explicitly OUT OF SCOPE for this arc (named in
Deferred). Consequently ALL console logic that matters is written as
pure functions in plain .js modules and tested there:

- `vaults-data.js` (new, plain JS like api.js): response→row mapping,
  health merge keyed by `(vaultId, credentialId, authVersion)` (an
  archived-then-recreated credential has a new credentialId; version
  disambiguates rotation), countdown formatting, validate outcome
  classifier (the four-outcome mapping above), the live-write allowlist
  predicate, warnings assembly for the loading contract.
- Tests: outcome classifier over all mapping rows incl. floor-skip;
  allowlist predicate blocks non-validate /v1 writes and everything in
  demo mode; health merge drops/flags archived; mapped rows for a
  seeded credential never contain the token fixture string; admin-401
  degradation state transition.
- XSS posture without DOM tests: React text children escape by default;
  the new JSX must contain NO `dangerouslySetInnerHTML` and NO
  `href`/`src` built from server-controlled strings — pinned by a
  source-scan test over the new files (crude, honest, structural) plus
  review. The server-side scrub (M3) remains the primary defense.
- Backend tests are unaffected by the harness gap: admin endpoint
  token-free serialization, archived rows included, 404 on unknown
  workspace, 401 with workspace key (tier crossing), bare-array shape.
- Integration: validate allowlist does not unlock other writes
  (attempted session-create via request() throws); demo mode issues
  zero network calls on the vaults route.

## Security notes (review checklist)

- No secret ever reaches the browser: slice A relies on M2 write-only
  enforcement; slice B's endpoint is structurally token-free; slice C's
  response is body-capped + scrubbed server-side and text-rendered
  client-side.
- Key tiering unchanged; the new admin route inherits prefix auth +
  RouteClass automatically (verified against app.ts:281-299, :893).
- No secrets or keys in URLs or `location.hash`.
- Live-write surface after this arc: exactly one /v1 endpoint, enforced
  at the request chokepoint, plus the pre-existing /admin provisioning
  writes.

## Deferred (named, not in this arc)

- **Slice D — credential lifecycle forms**: create/rotate (write-only
  secret paste, immutability-aware), archive/delete with confirm. Adds
  entries to the live-write allowlist; needs its own write-posture
  review.
- Component-test harness (jsdom or Playwright) for the console.
- Auto-expiry/scoping of `console-browse` minted keys.
- Background health auto-poll; fleet-wide health rollup on the admin
  landing page.

## Current source anchors (re-confirm before editing; lines verified
against arc-console-vaults @ 94cb3b5 base)

- app.jsx: auth phases :129, `loadLiveData` :140, `browseAsWorkspace`
  :206-216, `go()` :219, `readOnly` :248, Sidebar mount :323, routeHash
  :77-96.
- api.js: `PAGE_LIMIT=100` :8, `buildRequestHeaders` :41,
  `clearKeyForPath` :54, `request` :62, bare-array note :94,
  `fetchCursorPages` :158, `loadConsoleData` :190, `paginationWarnings`
  :235.
- ui.jsx: `NAV` array :68-72, `Sidebar` :74, demo contract copy
  :135-139, ModeBar warnings :145.
- auth.jsx: `AdminPanel` :82, minted-key modal onBrowse :195.
- detail.jsx: `ConfirmDialog` usage :485-496.
- admin/routes.ts :11-:53 (workspaces+keys only); admin service
  existence guard pattern service.ts:71-73.
- vaults/store.ts: `readCredentialRuntimeMetadataStmt` (archived-only
  filter) :244-249, `readCredentialRuntimeMetadata` :621,
  `runtimeMetadata()` :1007 (no archived field yet).
- vaults/service.ts: `MAX_CREDENTIALS_PER_VAULT=20` :29 (creation cap,
  not a page size).
- app.ts: admin prefix middleware :281-299, vaults mount :334, admin
  mount :342, RouteClass :891-893.
- vaults/routes.ts: validate route + verbatim MCP-disabled string :92-94.
- Wire API (do not extend): /v1/vaults CRUD + mcp_oauth_validate are
  hosted-exact per probe 52 and plan 0124's mapping table.

## Review log

Rev 2 folds the 4-reviewer panel (2026-07-10): Codex P2 (archived not in
mapper), Codex-adv (central live-write gate — HIGH; loading contract;
Environments-anchor), Sonnet (no DOM harness — HIGH; envelope
convention; floor mapping; demo-mode validate; "first live write"
framing; page-limit fact), Opus (workspace-id unbuildability — BLOCKER;
loadConsoleData blast radius — BLOCKER; unreachable merged state —
BLOCKER; admin-401 degradation; envelope; 404 guard; confirm dialog;
PartialNotice mechanism; anchor drift). Confirmed-solid notes retained
inline where load-bearing.
