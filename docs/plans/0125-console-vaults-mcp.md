# Plan 0125 — Console Vaults/MCP Panel (browse, health, validate)

Date: 2026-07-10
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
`/v1`. `GET /admin/workspaces/:id/mcp-credentials` returns the token-free
runtime metadata that already exists internally
(`readCredentialRuntimeMetadata`, store.ts). Rationale: refresh health is
fleet-operational (the appliance operator's concern), `/v1` stays
wire-pure, and the console already holds the admin key in its two-tier
model (plan 0120: admin key → `/admin`, workspace key → `/v1`, keys never
cross — api.js `buildRequestHeaders`, routes fixed by path prefix).

**Scope: slices A–C only.** Create/rotate/archive credential forms are
DELIBERATELY DEFERRED (named future slice D, sketched at the bottom):
highest effort (write-only secret paste, structural-immutability-aware
forms), lowest urgency (the API workflow works via SDK/curl), and the
console's write posture deserves its own review after validate proves the
pattern.

**Validate is the console's first live write.** Today the console is
strictly read-only against a live server (`readOnly = apiState.mode !==
'demo'`, app.jsx:249 — even Create session is demo-only). Validate is the
right first write: non-destructive (an initialize probe + at most one
coordinator-governed refresh), idempotent in effect, rate-floored
server-side (10s validate floor, M3), and it is the ONLY way to clear
`refresh_status = "invalid"` (the ticker deliberately skips invalid rows) —
a health view that shows a red pill with no action is half a feature.

## Slice A — read-only vault browsing (zero backend work)

- Sidebar: "Vaults" nav item in the Managed Agents section (ui.jsx:74
  `Sidebar`; nav list around ui.jsx:86), routed like environments/files.
- Data: extend `loadConsoleData` (api.js:193) with
  `fetchCursorPages("/v1/vaults?include_archived=true")` and, per vault,
  `fetchCursorPages("/v1/vaults/{id}/credentials?include_archived=true")`
  (both exist since M2/M3; page limit 20 per wire contract — reuse the
  cursor pagination + `PartialNotice` truncation pattern, api.js:158).
- Views, following the existing list/detail pattern (app.jsx
  `SessionsList` → detail.jsx):
  - Vaults list: id, display_name, credential count, created, archived
    badge.
  - Vault detail: credential table — id, display_name, auth type
    (`static_bearer` / `mcp_oauth`), `mcp_server_url`, `expires_at`
    (relative), archived badge. For mcp_oauth: token_endpoint host,
    scope, auth method from the readable `refresh` subset.
  - NO SECRETS EXIST IN THE RESPONSES (write-only enforcement is
    API-level, M2) — the UI never has a secret to mishandle. Assert this
    in a UI test anyway: rendered DOM for a seeded credential never
    contains the token fixture.
- Empty/loading/error/partial states: reuse states.jsx
  (`SkeletonTable`/`ErrorState`/`EmptyState`/`PartialNotice`).
- Demo mode: add vault fixtures to data.js so `?mode=demo` shows the
  panel (existing pattern for all resources).

## Slice B — health column (one new admin endpoint + UI)

Backend:
- Store: `listWorkspaceCredentialRuntimeMetadata(workspaceId)` — the
  existing `runtimeMetadata()` row mapper (store.ts) over all
  vault_credentials in the workspace (active + archived flag), token-free
  by construction (SELECT of structural/scheduling columns only; never
  touches the sealed blob).
- Admin service + route: `GET /admin/workspaces/:id/mcp-credentials` →
  `{ data: [...] }` with vaultId, credentialId, authType, hasRefresh,
  authVersion, expiresAt?, refreshStatus, refreshAttempts, nextRefreshAt,
  authHintAt, archived. Admin routes live in admin/routes.ts (workspaces
  + keys today, :11-:44); this grows the admin API's scope from
  provisioning to operational monitoring — deliberate, per the central
  decision.
- Gate: NOT gated on OMA_ENABLE_MCP (it reads the DB, no egress; vault
  CRUD is similarly ungated per M2 posture). Returns rows for
  static_bearer too (authType lets the UI show "n/a").

Console:
- When the admin key is present (`auth.admin`), vault detail merges the
  health fields by (vaultId, credentialId):
  - Status pill: 🟢 `ok` / 🟡 `transient` (with attempts count) /
    🔴 `invalid` / ⚪ static_bearer or no-refresh (n/a).
  - `expires_at` countdown ("in 43 min" / "expired 2 h ago").
  - `next_refresh_at` countdown ("next check in 38 min" / "— waiting for
    validate" when invalid).
  - "401 hint pending" badge when `authHintAt` is set.
- Workspace-key-only login: health column renders as "—" with a single
  hint line "Refresh health requires the operator (admin) login" — the
  wire-visible columns still work. No admin call is attempted without
  the admin flag (api.js key-tier routing enforces it anyway).
- Refresh cadence: manual "Refresh" button on the panel + reload when
  the tab is (re)opened. NO background polling loop in v1 — appliance
  posture; a 30s poll on an open tab is a possible later tweak, not in
  scope.

## Slice C — Validate button (first live write)

- Placement: per-credential action in the vault detail row + detail
  panel, only for `auth.type === "mcp_oauth"` and not archived (the API
  400s both; don't offer dead buttons — but DO keep it enabled for
  `invalid` status: that is its main job).
- Call: `POST /v1/vaults/{v}/credentials/{c}/mcp_oauth_validate` with the
  workspace key (wire endpoint, M3). Button shows a spinner while the
  probe runs (typical: seconds; worst case: server-side operation
  timeout).
- Result panel, mapped from the response (M3's 14-row table collapses to
  three operator-facing outcomes):
  - `valid` → green: "Credential works." Show probe status code.
  - `invalid` → red: "Re-authorize with the provider and rotate the
    credential." Show `refresh.status` (`no_refresh_token` vs `failed`)
    and refresh http status when present.
  - `unknown` → amber: "Could not conclude (transient/unreachable) — try
    again later." Show whatever probe/refresh metadata exists.
  - Full raw response behind a collapsible "details" disclosure, rendered
    as ESCAPED preformatted text (`textContent`, never innerHTML):
    `mcp_probe.http_response.body` is server-controlled text — scrubbed
    server-side (M3), but the console must not add an XSS surface on top.
    CSP (console-security tests) backs this, and a UI test pins that a
    body containing `<img onerror>` renders inert.
- After a validate completes, re-fetch the health row (slice B endpoint,
  when admin) so a cleared `invalid` flips the pill green without a page
  reload. Workspace-only sessions just show the validate result.
- The `readOnly` write-guard (app.jsx:249) stays authoritative for every
  OTHER mutation; validate gets an explicit carve-out constant
  (`LIVE_ACTIONS = ["mcp_oauth_validate"]`-style, not a general
  readOnly=false flip) so review can see exactly what became writable.
- MCP disabled on the deployment: the API returns the wire-shaped 400
  ("MCP is disabled on this deployment") — surface that text verbatim on
  the button, don't hide the button (operators should learn the gate
  exists).

## Security notes (review checklist)

- No secret ever reaches the browser: slice A relies on M2 write-only
  enforcement; slice B's endpoint is structurally token-free; slice C's
  response is body-capped + scrubbed server-side and escaped client-side.
- Key tiering unchanged: /v1 calls carry only the workspace key, /admin
  only the admin key (api.js:41-59); the new admin endpoint slots into
  the existing prefix routing with no client changes.
- No secrets or keys in URLs; validate result is never written to
  location.hash.
- Transport: admin key + api-key mode already require loopback or TLS
  (admin-transport gate, #157) — nothing new to add, but the plan relies
  on it, so the review should confirm no new route bypasses RouteClass
  accounting (app.ts:891 route classes).

## Test plan

- Store/service/route: metadata list is token-free (serialized JSON of
  the response never contains seeded token fixtures), covers archived +
  static rows, 404 on unknown workspace, admin-key-required (401 with
  workspace key — tier crossing rejected).
- Console unit (existing vitest UI harness, ui/.../src/__tests__/):
  - Vault list + detail render from fixtures; secrets absent from DOM.
  - Health merge: pills per status; hint badge; workspace-only fallback
    line; no /admin call without admin flag.
  - Validate: button gating (type/archived), three outcome renders,
    hostile body renders inert (XSS pin), post-validate health refetch.
- Integration (console-security/static pattern): admin endpoint route
  class is "admin"; validate carve-out does not unlock other writes
  (Create session still demo-only).
- Demo mode renders vault fixtures without network.

## Deferred (named, not in this arc)

- **Slice D — credential lifecycle forms**: create vault, create
  credential (write-only secret paste, cleared after submit), rotate
  (immutability-aware: structural fields read-only, per-field API errors
  surfaced), archive/delete with confirm. Needs its own write-posture
  review; the validate carve-out pattern above is the template.
- Background auto-poll of health; per-deployment (cross-workspace) health
  rollup on the admin landing page.

## Current source anchors (re-confirm before editing)

- ui/managed-agents-console/src/app.jsx: routing via `route.name` +
  `go()` (:219), Sidebar mount (:323), `readOnly` guard (:249), auth
  phases (:130), `loadLiveData` (:141).
- ui/managed-agents-console/src/api.js: key tiering
  `buildRequestHeaders` (:41), cursor pagination (:158),
  `loadConsoleData` (:193).
- ui/managed-agents-console/src/ui.jsx: `Sidebar` (:74) with Managed
  Agents nav list (:86) and Operator section (:93).
- src/control-plane/admin/routes.ts: workspaces/keys only (:11-:44).
- src/control-plane/vaults/store.ts: `runtimeMetadata()` row mapper and
  `readCredentialRuntimeMetadata` exist; no workspace-wide list yet.
- src/control-plane/app.ts: RouteClass accounting (:891), admin mount
  (:342), vaults mount with mcp deps (:334).
- Wire API (do not extend): /v1/vaults CRUD + mcp_oauth_validate are
  hosted-exact per probe 52 and plan 0124's mapping table.
