# Slices 5–7 Plan — `mcp_oauth_validate`, Wake-Loop Ticker, Live Smoke

Date: 2026-07-09
Parent plan: [0122 MCP connector](0122-mcp-connector.md), M3 §7B.
Implements: §7B.9 slices 5, 6, 7. Slices 0–4 merged in #170/#171 (main @ 0d96505).

## Summary

Close out M3. Slice 5 adds the operator-facing `mcp_oauth_validate`
endpoint on the reviewed coordinator `force` path. Slice 6 adds the
in-process ticker (OMA's first background worker) on the `createWakeLoop`
primitive, with shutdown ordering. Slice 7 proves the arc live: smoke 54
end-to-end with `token_in_events: false` and a full leak sweep.

Slices are sequential: 5 exercises the coordinator trigger semantics the
ticker also consumes; 7 gates the arc-closing PR.

## Slice 5 — `mcp_oauth_validate`

Route: `POST /:vaultId/credentials/:credentialId/mcp_oauth_validate` in
`src/control-plane/vaults/routes.ts` (sibling of the archive route,
routes.ts:73). Synchronous handler per §7B.3:

1. **Gate first**: `OMA_ENABLE_MCP` off → wire-shaped 400
   `invalid_request` ("MCP is disabled on this deployment") BEFORE any
   lookup or network call — locked by a zero-network-call test.
2. Active credential lookup: archived → 400 "Credential is archived."
   (probe 52, NOT 404); `static_bearer` → 400 (probe 52).
3. `mcp_probe`: **NOT via `McpConnection`** (review round 2 F1 —
   slice 4 gave `connect()` its own internal 401→refresh→redial and it
   exposes tools, never the HTTP response). New dedicated
   `probeMcpInitialize(url, authorization, fetch, { capBytes: 4096,
   timeoutMs })` in `mcp/`: ONE raw JSON-RPC `initialize` POST through
   the guarded fetch with a FROZEN token — no binding, no automatic
   recovery, no discovery. Returns
   `{ reached: true, statusCode, contentType, body, bodyTruncated }`
   (body streamed to the 4KB cap, never fully buffered) or
   `{ reached: false }`; transport/reader always cleaned up. The
   HANDLER exclusively owns the refresh decision and the single
   re-probe. Probe body passes through `scrubKnownSecrets` with ALL
   secret values live during the validate call — including BOTH the
   pre-refresh and post-refresh (rotated) tokens on the re-probe path
   (review round 3 F1).

   **Wire details (round 3 F1 — SSE is the trap: a VALID
   streamable-HTTP server may answer initialize with
   `text/event-stream` and hold the stream open; a read-to-EOF bounded
   reader hangs to timeout and misclassifies a valid credential as
   unknown — SDK evidence `streamableHttp.js:386`):**
   - Request: POST, `Content-Type: application/json`,
     `Accept: application/json, text/event-stream` (BOTH — a
     spec-compliant server may 406 a JSON-only Accept), body a JSON-RPC
     `initialize` request with fixed id `1`, `protocolVersion` =
     the SDK's `LATEST_PROTOCOL_VERSION`, minimal
     `clientInfo`/`capabilities` mirroring what the SDK client sends.
   - Response `content-type: application/json` → read body to cap.
   - Response `content-type: text/event-stream` → parse SSE events
     incrementally; STOP and cancel the reader at the first event
     carrying the JSON-RPC response for id `1` (that event's data is
     the captured `body`), or at the 4KB cap, whichever first. NEVER
     wait for stream end.
   - "Initialize succeeds" (the `valid` row) = 2xx AND a parseable
     JSON-RPC **result** (not error object) for the request id. 2xx
     with an unparseable body or a JSON-RPC error → the
     reached-non-auth `unknown` row.
4. On 401/403 with a refresh block: refresh THROUGH
   `RefreshCoordinator.refreshCredential` with `trigger: "validate"`
   (below) and `expectedAuthVersion` = the probed version, then
   re-probe once. **Coordinator result change**: outcomes gain
   `tokenEndpointResponse?: { statusCode, contentType }` — safe
   metadata only, NEVER a body (review round 2 F1:
   `RefreshCredentialResult` currently carries nothing to populate
   `refresh.http_response` from).
5. Map to `valid | invalid | unknown` — the FULL table (pre-impl review
   F5; only the auth chain may conclude `invalid`):

   | probe / refresh outcome | `status` | `mcp_probe.http_response` | `refresh.status` |
   |---|---|---|---|
   | initialize succeeds | `valid` | the captured response | `not_attempted` |
   | HTTP reached, non-401/403 (400/404/5xx/…) | `unknown` | the captured response | `not_attempted` |
   | transport failure (network/DNS/timeout/`redirect_blocked`/SSRF) | `unknown` | `null` | `not_attempted` |
   | 401/403, NO refresh block on the credential | `invalid` | first probe's response | `no_refresh_token` (probe-52 exact: `52-…-probe.json:302`) |
   | 401/403 → refresh outcome `invalid` | `invalid` | first probe's response | `failed` |
   | 401/403 → refresh `transient_error` | `unknown` | first probe's response | `failed` |
   | 401/403 → refresh failure persists `"stale"` because a concurrent writer rotated the credential → current-token re-probe succeeds | `valid` | re-probe response | `failed` |
   | 401/403 → refresh skipped `validate_floor` | `unknown` | first probe's response | `skipped` |
   | 401/403 → refresh skipped (`missing_client_secret` / `no_refresh_metadata` / `missing`) | `unknown` | first probe's response | `skipped` |
   | 401/403 → refresh ok (incl. `persisted: "stale"` — CAS loss means someone else refreshed; re-probe with the CURRENT store token) → re-probe succeeds | `valid` | re-probe response | `refreshed` |
   | 401/403 → refresh ok → re-probe 401/403 again | `invalid` | re-probe response | `refreshed` |
   | 401/403 → refresh ok → re-probe non-auth HTTP failure (5xx/4xx) | `unknown` | re-probe response | `refreshed` |
   | 401/403 → refresh ok → re-probe transport failure | `unknown` | `null` | `refreshed` |

   `refresh.status` vocabulary: probe 52 pins only `no_refresh_token`;
   the remaining values (`not_attempted`, `refreshed`, `failed`,
   `skipped`) are OMA's — revisit against hosted if a later probe
   captures a refresh-attempted validate (round 3 F2). Every row above
   gets a full-response-equality test.

   A stale failure is intentionally distinct from a successful refresh: the
   failed token-endpoint attempt belongs to the old auth version, while the
   current-store re-probe reports whether the winning material works now. The
   response therefore may be `status: "valid"` with `refresh.status: "failed"`.

   `refresh.status` populated per §7B.2 (`no_refresh_token` when
   absent). **`refresh.http_response` NEVER carries a token-bearing
   body** — status + content-type only (§7B.3, Opus F4: the 200 grant
   response IS the secret).

Response shape is the probe-52 literal in §7B.2 (`vault_credential_validation`).

**Validation snapshot seam (implementation audit F1).** `VaultService`
gains one internal exact-credential accessor for this route returning the
active OAuth validation snapshot: `authVersion`, `mcpServerUrl`, structural
refresh metadata, and the live `accessToken` / optional `refreshToken` /
optional `clientSecret`. The snapshot is never serialized. It is the single
source for `has_refresh_token`, the frozen probe authorization, and the scrub
set; structural refresh metadata alone must not imply that the secret exists.
After any refresh attempt the handler re-resolves this snapshot before a
re-probe, thereby acquiring the current CAS winner's token and scrub values.

**`refresh.http_response` mapping (implementation audit F2).** It is the
coordinator outcome's `tokenEndpointResponse`, wire-mapped to
`{ status_code, content_type }`, whenever the token endpoint returned an HTTP
response (success, invalid, or transient). It is `null` for transport failures,
all skipped outcomes, `not_attempted`, and `no_refresh_token`. It never contains
a body. Full-response tests pin this field alongside every table row.

**Concurrent disappearance (implementation audit F3).** `persisted: "stale"`
only proceeds to the current-token re-probe when the active validation snapshot
can be re-resolved. If an archive won the race, return the ordinary archived
400; if hard delete won, return the ordinary credential 404. Add both races to
the route tests; do not misreport either as a successful concurrent refresh.

**Coordinator change — `trigger: "validate"` (settled by pre-impl
review F1; do NOT pass `force: true`, which self-floors at
`oauth-refresh.ts:129`).** Add `trigger?: "validate"` to
`RefreshCredentialInput` with exactly three effects, all required:
(a) BYPASSES the forced-floor **check** (`oauth-refresh.ts:129-146`) —
an operator validate inside a hint's 60s window must still refresh;
(b) still RECORDS an admission keyed by the probed `authVersion`
(`:148`) so subsequent hint-triggered calls stay floored — noting that
on refresh success the `auth_version` bump orphans that key by design
(a hint against the NEW version is a new failure, not a repeat);
(c) BYPASSES the invalid-skip (`oauth-refresh.ts:184`,
`refreshStatus === "invalid" && force !== true`) — clearing `invalid`
is validate's purpose. Joins single-flight like every trigger. Success
already clears `invalid` + `auth_hint_at` and reschedules via
`persistOauthRefreshSuccess` (`store.ts:256-264`) — no new store work.

**(d) — and its OWN floor (review round 2 F2: "operator calls are
inherently rate-limited" was wrong — `admission.ts` covers
sessions/turns/uploads/streams, not this route, so sequential validate
spam would mean one token-endpoint POST per request).** A separate
`validateAdmissions` map, keyed `${workspaceId\0vaultId\0credentialId}` (NOT
`authVersion`: a successful refresh bumps that version and would otherwise
open a fresh admission slot to every sequential validate request),
floor `OAUTH_VALIDATE_REFRESH_FLOOR_MS = 10_000` — long enough that a
scripted caller cannot hammer a third-party IdP, short enough that an
operator retrying after fixing their IdP config is never blocked
meaningfully. Floored → `skipped`/`validate_floor` → validate `status:
"unknown"` (the probe still ran and is reported). The single-flight
join still precedes this floor. The probe POST itself (to the MCP
server) stays unthrottled — same egress class as a session-create dial,
already accepted posture.

**Dependency seam (pre-impl review F3, sharpened by round 2 F5).**
`vaultsRoutes(service)` (`routes.ts:6`) has no access to the guarded
fetch or coordinator, and `createDefaultMcpRuntime` is today created
only when `opts.runner?.mcp === undefined` (app.ts:537) — so a custom
runner override would silently disable operator validation and the
ticker. Restructure: ONE deployment-owned MCP control-plane runtime
`{ fetch, refreshCoordinator, ticker }`, created iff
`runtimeConfig.mcp !== undefined` (the egress gate), INDEPENDENT of
the runner-override seam. The default runner consumes it when no
override is supplied; validate and the ticker consume it ALWAYS (a
custom runner changes how sessions dial, not whether operators can
validate credentials or scheduled refresh runs). `vaultsRoutes` gains
`mcp?: { fetch: McpFetch; refresh: RefreshCoordinator; operationTimeoutMs: number }`
from it. The timeout is the deployment MCP operation timeout (the same resolved
value used for session MCP operations, default 60s) and is passed to each
initialize probe (implementation audit F4). MCP
off → runtime absent → validate returns the gate-off 400 — one code
path.

## Slice 6 — wake-loop ticker + shutdown

- **Primitive**: `createWakeLoop({ nextWakeAt, run, maxSleepMs,
  minSleepMs, onError })` in `src/control-plane/wake-loop.ts`, ~60
  lines, single `setTimeout`, no persistence; `close()` cancels the
  timer AND awaits any in-flight `run()` (§7B.3; this codebase's known
  teardown bug class). Sessions snapshot-sweep adoption is a named
  follow-up, NOT in M3.
- **Store seam**: `listDueRefreshes(now, limit)` on `VaultStore`
  (review round 2 F3: renamed from `claimDueRefreshes` — the parent
  plan scopes multi-node claiming as a non-goal (0122:1500), and
  calling a plain SELECT a "claim" implies lease semantics nobody
  designed; the Postgres-era claim becomes a NEW method when leases
  are real). Contract: plain SELECT of active `auth_type = 'mcp_oauth'`
  rows with `next_refresh_at <= now`, EXCLUDING `refresh_status =
  'invalid'` (invalid waits for validate; §7B invalid-skip — and
  invalid rows carry `next_refresh_at = NULL`, so they're doubly
  excluded), ORDER BY `next_refresh_at ASC`, LIMIT `limit` (default
  batch 50). Backlog larger than a batch drains across iterations: the
  overdue remainder keeps `nextWakeAt` in the past, so the loop re-runs
  at the 30s `minSleepMs` pace until caught up — no draining loop
  inside `run()`. In-process single-flight is the concurrency control
  (0113 D9 single-node contract). Separately, `nextDueRefreshAt(now)` —
  a standalone store query the loop invokes as its `nextWakeAt`
  callback each iteration (pre-impl review F7: NOT a value plumbed out
  of `run()`).
- **Scheduling seed (review round 2 F3 — without this the ticker never
  sees most rows)**: today `insertCredentialStmt` leaves
  `next_refresh_at` NULL (`store.ts:196-202`) and auth rotation resets
  it to NULL (`store.ts:211-216`), so a never-dialed credential and
  every operator-rotated credential are invisible to the wake loop and
  fall back to lazy-only. Fix at both write sites, for `mcp_oauth`
  rows with complete refresh metadata: compute `next_refresh_at` with
  the EXISTING exported policy (`nextRefreshAt`: TTL ≥ LEAD →
  `expires_at − LEAD`; TTL < LEAD → `now + max(TTL/2, FLOOR)`;
  `expires_at` absent → `now + OAUTH_REFRESH_LONG_LIVED_RECHECK_MS`).
  Rows WITHOUT a refresh token/metadata stay NULL (nothing to refresh —
  ticker correctly blind to them). Tests: create-without-dial gets
  scheduled; rotation reschedules; restart picks both up;
  refresh-less credential stays unscheduled.
- **Ticker run**: for each listed row call `refreshCredential({...})`
  WITHOUT `force` and WITHOUT `trigger` — the lazy trigger; joins any
  in-flight runtime refresh via single-flight. **`run()` AWAITS all
  listed refreshes before resolving** (pre-impl review F6), processed
  with a SMALL concurrency bound `OAUTH_TICKER_CONCURRENCY = 5`
  (round 3: sequential = 25 min for 50 timed-out endpoints; unbounded
  `Promise.all` = a 50-request burst). The loop re-queries `nextWakeAt`
  only after the persists have advanced `next_refresh_at`;
  fire-and-forget would re-select the still-due rows and hot-spin at
  the 30s floor. Failed refreshes self-reschedule via
  `transientBackoffMs` persists — the loop adds no backoff of its own.
- **Wake signal (round 3 F3 — without it a sleeping loop misses newly
  scheduled work: no due rows → loop sleeps 15 min → operator creates a
  2-min-TTL credential → its ~1-min-away due time passes 14 minutes
  before the loop looks again)**: `createWakeLoop` exposes `wake()` —
  cancel the pending timer, re-run the `nextWakeAt`/`run` cycle now;
  no-op while `run()` is already executing (the loop re-queries on
  completion anyway); safe after `close()` (no-op). Two producers, both
  wired by the app to `loop.wake()`:
  (a) `onSchedulingChanged` on the vault service — after mcp_oauth
  credential CREATE and AUTH ROTATION (the two seed sites);
  (b) `onScheduled` on the coordinator — after ANY successful refresh
  persist, because a lazy session-dial refresh of a short-TTL
  credential can schedule a due time EARLIER than whatever the loop is
  currently sleeping toward (validate success is covered by this same
  hook). Ticker-triggered refreshes calling `wake()` mid-`run()` hit
  the no-op branch — no recursion.
- **Sleep bounds**: `maxSleepMs` 15 min / `minSleepMs` 30s are NEW
  `createWakeLoop` parameters (pre-impl review F9 — the exported
  `nextRefreshAt`/`transientBackoffMs` schedule ROWS; these clamp the
  LOOP). Restart recovery is inherent: first iteration recomputes next
  wake from SQLite.
- **Gating (pre-impl review F4 — two different gates, do not copy the
  neighbor's)**: the ticker starts ONLY when `runtimeConfig.mcp !==
  undefined` (the `OMA_ENABLE_MCP` egress gate, the condition behind
  `enabled:` at app.ts:579) — NOT `opts.runner?.mcp === undefined`,
  which is the test-override seam gating `createDefaultMcpRuntime`
  creation (app.ts:537-538). A ticker gated on the latter would start
  with MCP off, violating §7B.3's zero-egress posture.
- **Ownership + shutdown — ONE contract (pre-impl review F2, round 2
  F4, settled by round 3 F4; the app.ts:435-485 `stores.close()` sites
  are boot-error guards inside construction and stay as-is)**:
  - `DeploymentControlPlane` (app.ts:385) gains `close(): Promise<void>`
    and it is THE teardown owner: `await loop.close()` (cancel timer,
    await in-flight `run()` — so an in-flight refresh completes its
    persist before the DB closes) THEN `stores.close()`. Idempotent —
    double-close is a no-op, not a throw.
  - `main.ts` (`startAppliance`) owns only the server: its returned
    `close` becomes `await closeServer(server); await plane.close()`
    (:127-131), and the startup-failure catch (:133-141) calls
    `plane.close()` instead of `stores.close()`.
  - Ownership rule, documented on the type: callers use `plane.close()`
    for teardown; `stores` stays exposed for data access but callers
    must not close it directly once a plane owns it (existing tests
    that close stores directly predate the loop and may keep doing so
    only where no ticker was started).
  - `createDeploymentControlPlaneApp` (app.ts:391), which returns
    `.app` and DISCARDS the plane, must NOT start the ticker — it
    passes an internal no-background-workers option, since a ticker it
    starts can never be closed.
  - Tests: close during in-flight refresh, double-close, bind failure
    calls `plane.close()`, app-only construction starts no timer.
- Metrics (if trivial): reuse the existing refresh outcome metric; no
  new instrumentation surface in M3.

## Slice 7 — live smoke 54 + leak sweep

`scratch/54-mcp-oauth-live-smoke.ts`, following smoke 51's pattern
(boot real deployment, real agent turn, assert on the events store):

- mcp_oauth credential against a local MCP fixture + local token
  endpoint. **The `allowInsecureTokenEndpoint` seam does not exist yet
  and must be BUILT in this slice** (review round 2 F6: §7B.3 names it
  but service.ts:529 rejects http unconditionally, guarded fetch blocks
  loopback, and deployment assembly has no fetch override): a test-only
  option threaded through service create-validation AND deployment
  assembly, patterned on the runner's `allowAddress` SSRF seam
  (runner.ts:107) — never reachable from production wiring. Short TTL
  so a refresh happens mid-session; assert the fixture sees the ROTATED
  token on the next tool call without reconnect.
- 401 path: fixture revokes the token → hint → forced refresh → retry
  → tool call succeeds; assert exactly one token-endpoint POST.
- Redirect: point a refresh at an endpoint that 302s → assert
  `redirect_blocked` (real undici already verified standalone
  2026-07-09; this pins it in the smoke).
- **Leak sweep** (the M3 DoD, hardened per review round 2 F6): use
  CANARY secrets containing characters that change under encoding
  (e.g. `+/=&?%` in the token); exhaust event pagination via
  `next_page` (not one page); capture BOTH stdout and stderr; include
  a hostile MCP fixture response echoing the CURRENT and a ROTATED
  token; search raw, `Bearer `-prefixed, JSON-embedded, JSON-escaped,
  percent-encoded, and base64/Basic-auth representations of every
  canary — `token_in_events: false` as smoke 51 established for
  static_bearer, now falsifiable.
- 4KB probe cap exercised with a multi-chunk response split
  mid-UTF-8-codepoint; assert truncation without buffering the hostile
  body (review round 2 F6).
- `mcp_oauth_validate` called live against the fixture in valid,
  invalid (dead grant), and unknown (5xx) states.

Exit: full suite green, smoke 54 output committed to
`scratch/artifacts/`, roadmap updated (MCP exit criterion OAuth half →
DONE), arc-closing PR with the usual 4-reviewer panel.

## Test plan (beyond the per-slice items above)

From the §7B.5 matrix rows not yet pinned:

- Validate on gate-off deployment: zero network calls (spy fetch).
- Validate racing the ticker → single-flight, fixture sees exactly one
  POST (§7B.5).
- 401-hint racing the ticker → single POST (§7B.5).
- Ticker skips invalid rows; successful validate-refresh clears invalid
  and the NEXT ticker pass picks the row up again.
- Mixed static_bearer/mcp_oauth rows: due-row query never selects
  static rows (mixed-row migration test, §7B.3 storage).
- Wake-loop unit tests: sleep clamping, close-while-running,
  close-cancels-timer, onError does not kill the loop.
- Restart recompute: new store instance → correct next wake, no replay.

From the pre-impl review (F8 — §7B.5 rows the first draft omitted):

- Ticker backoff-on-5xx: transient failure reschedules via the persisted
  backoff, loop does not hot-spin (§7B.5:1426).
- Short-TTL token → floored cadence, no token-endpoint hammering
  (§7B.5:1430).
- `OMA_ENABLE_MCP` off → loop never starts (§7B.5:1431) AND the F4 gate
  distinction: MCP off with default runtime present still means no ticker.
- Integration test: deployment `close()` shuts the loop BEFORE stores
  close; in-flight refresh completes its persist (§7B.5:1434).
- `refresh.http_response` carries no body on the valid path
  (§7B.5:1463).
- `mcp_probe` oversized body → 4KB truncation + `body_truncated: true`
  (§7B.5:1462).
- Hostile MCP server echoing the access token into its 401 body →
  scrubbed in `mcp_probe.http_response.body` (§7B.5:1467).
- Validate with `trigger: "validate"` inside a hint's floor window →
  refresh RUNS (floor bypassed); a hint-triggered call immediately after
  a failed validate-refresh at the same authVersion → floored.

From review round 2:

- Sequential validate spam: second validate inside 10s → refresh
  skipped `validate_floor`, exactly ONE token-endpoint POST, response
  `status: "unknown"`.
- Deliberate re-validate of an `invalid` credential → refresh RUNS
  (trigger bypasses the invalid-skip) and clears `invalid` on success.
- Full response-shape equality pinned for every mapping-table branch,
  including refresh-success-then-401 re-probe, transport failure, and
  the floored branch.
- `probeMcpInitialize`: frozen token (no binding), no internal retry,
  reader cleanup on timeout/abort, cap streaming.
- Custom-runner deployment: validate and ticker still function
  (round 2 F5).
- Validation snapshot, refresh-response nullability, and archive/delete races
  are pinned exactly (implementation audit F1-F3).

From review round 3:

- SSE probe: fixture answers initialize as `text/event-stream` with the
  response event then HOLDS the stream open → probe returns promptly
  with the captured result (no timeout), reader cancelled; and the
  valid credential classifies `valid`.
- 2xx with JSON-RPC error object → `unknown`, not `valid`.
- Re-probe scrubbing: hostile server echoes the ROTATED token after a
  validate refresh → scrubbed from `mcp_probe.http_response.body`.
- Wake signal: loop sleeping toward a far deadline; create a
  short-TTL credential → `wake()` fires and the refresh happens at its
  ~1-min due time, not at the 15-min cap. Same via a lazy session-dial
  refresh success on a short-TTL credential (coordinator `onScheduled`).
- `wake()` mid-`run()` is a no-op; `wake()` after `close()` is a no-op.
- Ticker batch concurrency: 50 due rows with slow endpoints → at most
  `OAUTH_TICKER_CONCURRENCY` in flight.

## Current source anchors (re-confirm before editing)

- `src/control-plane/vaults/oauth-refresh.ts`: `RefreshCredentialInput`
  has `force` + `expectedAuthVersion`; forced floor keyed by
  `${key}\0${authVersion}`, pruned at admission; single-flight join
  precedes the floor check. No trigger concept yet.
- `src/control-plane/vaults/store.ts`: no `claimDueRefreshes`;
  `persistOauthRefreshSuccess` clears `auth_hint_at` + `invalid` and
  reschedules; failure persists also clear `auth_hint_at` (572138e).
- `src/control-plane/sessions/pi/mcp/runtime.ts`:
  `createDefaultMcpRuntime` composes the one guarded fetch +
  coordinator; the ticker belongs beside it (created at app.ts:538,
  gated by the test-override seam at :537 — see F4 note above for why
  the ticker's gate is different).
- `src/control-plane/vaults/routes.ts`: no validate route; archive
  route at :73 is the shape template; `vaultsRoutes(service)` takes no
  MCP dependencies yet (F3 seam is new).
- `src/control-plane/app.ts`: return shape `{ app, stores, authMode }`
  at :727 — no close handle yet. The `stores.close()` calls at
  435/449/457/464/485 are boot-error guards, NOT the teardown path.
- `src/main.ts`: the real teardown — returned `close` at :127-131
  (`closeServer` → `stores.close()`) and the startup-failure catch at
  :133-141. Loop close inserts between server close and store close in
  BOTH.
- `src/control-plane/sessions/pi/mcp/client.ts:70`:
  `McpConnection.connect` auto-refreshes/redials on 401 and exposes no
  HTTP response — unusable as the validate probe (round 2 F1);
  `probeMcpInitialize` is new.
- `src/control-plane/vaults/store.ts:196-202` (insert leaves
  `next_refresh_at` NULL) and `:211-216` (rotation resets it NULL) —
  the two scheduling-seed write sites.
- `src/control-plane/admission.ts`: workspace admission limits do not
  cover the validate route — the validate refresh floor is the
  coordinator's own (round 2 F2).
