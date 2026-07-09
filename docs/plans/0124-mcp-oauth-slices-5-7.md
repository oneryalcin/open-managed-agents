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
3. `mcp_probe`: initialize-dial `mcp_server_url` via `McpConnection` +
   the deployment's guarded fetch with the CURRENT access token. Capture
   `{status_code, content_type, body (4KB cap), body_truncated}`; body
   passes through `scrubKnownSecrets` with the credential's live secret
   values (access token, refresh token, client secret).
4. On 401/403 with a refresh block: refresh THROUGH
   `RefreshCoordinator.refreshCredential` with `trigger: "validate"`
   (below) and `expectedAuthVersion` = the probed version, then re-probe
   once.
5. Map to `valid | invalid | unknown` — the FULL table (pre-impl review
   F5; only the auth chain may conclude `invalid`):

   | probe / refresh outcome | `status` | `mcp_probe.http_response` |
   |---|---|---|
   | initialize succeeds | `valid` | the captured response |
   | HTTP reached, non-401/403 (400/404/5xx/…) | `unknown` | the captured response |
   | transport failure (network/DNS/timeout/`redirect_blocked`/SSRF) | `unknown` | `null` |
   | 401/403 → refresh outcome `invalid` | `invalid` | first probe's response |
   | 401/403 → refresh `transient_error` or floor/skip | `unknown` | first probe's response |
   | 401/403 → refresh ok → re-probe succeeds | `valid` | re-probe response |
   | 401/403 → refresh ok → re-probe 401/403 again | `invalid` | re-probe response |

   `refresh.status` populated per §7B.2 (`no_refresh_token` when
   absent). **`refresh.http_response` NEVER carries a token-bearing
   body** — status + content-type only (§7B.3, Opus F4: the 200 grant
   response IS the secret).

Response shape is the probe-52 literal in §7B.2 (`vault_credential_validation`).

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

**Dependency seam (pre-impl review F3).** `vaultsRoutes(service)`
(`routes.ts:6`) has no access to the guarded fetch or coordinator;
`createDefaultMcpRuntime`'s products currently flow only to the runner
(`app.ts:578-589`). Thread a new optional dependency into
`vaultsRoutes`: `mcp?: { fetch: McpFetch; refresh: RefreshCoordinator }`,
wired from the deployment's single runtime in `app.ts`. When the
deployment has MCP off (`runtimeConfig.mcp === undefined`) OR the seam
is absent (test override), validate returns the gate-off 400 — same
response, one code path.

## Slice 6 — wake-loop ticker + shutdown

- **Primitive**: `createWakeLoop({ nextWakeAt, run, maxSleepMs,
  minSleepMs, onError })` in `src/control-plane/wake-loop.ts`, ~60
  lines, single `setTimeout`, no persistence; `close()` cancels the
  timer AND awaits any in-flight `run()` (§7B.3; this codebase's known
  teardown bug class). Sessions snapshot-sweep adoption is a named
  follow-up, NOT in M3.
- **Store seam**: `claimDueRefreshes(now, limit)` on `VaultStore` — the
  credential row IS the job row. Plain SELECT (safe: in-process
  single-flight is the concurrency control; the Postgres-era
  `UPDATE … RETURNING` claim fits behind the same signature — 0113 D9)
  of active `auth_type = 'mcp_oauth'` rows with `next_refresh_at <=
  now`, EXCLUDING `refresh_status = 'invalid'` (invalid waits for
  validate; §7B invalid-skip — and invalid rows carry
  `next_refresh_at = NULL`, so they're doubly excluded). Separately,
  `nextDueRefreshAt(now)` — a standalone store query the loop invokes
  as its `nextWakeAt` callback each iteration (pre-impl review F7: NOT
  a value plumbed out of `run()`).
- **Ticker run**: for each claimed row call `refreshCredential({...})`
  WITHOUT `force` and WITHOUT `trigger` — the lazy trigger; joins any
  in-flight runtime refresh via single-flight. **`run()` AWAITS all
  claimed refreshes before resolving** (pre-impl review F6): the loop
  re-queries `nextWakeAt` only after the persists have advanced
  `next_refresh_at`; fire-and-forget would re-select the still-due rows
  and hot-spin at the 30s floor. Failed refreshes self-reschedule via
  `transientBackoffMs` persists — the loop adds no backoff of its own.
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
- **Ownership + shutdown (pre-impl review F2 — the app.ts:435-485
  `stores.close()` sites are boot-error guards that run BEFORE the loop
  exists; do not wire there)**: `createDeploymentControlPlane` must
  expose the loop's close in its return shape (today `{ app, stores,
  authMode }`, app.ts:727). The REAL teardown is `src/main.ts`: the
  returned `close` (`await closeServer(server); stores.close()`,
  main.ts:127-131) gains `await loop.close()` between the two, and the
  startup-failure catch (main.ts:133-141) closes the loop before
  `stores.close()` too. `close()` cancels the timer and awaits any
  in-flight `run()` — so an in-flight refresh completes its persist
  before the DB closes.
- Metrics (if trivial): reuse the existing refresh outcome metric; no
  new instrumentation surface in M3.

## Slice 7 — live smoke 54 + leak sweep

`scratch/54-mcp-oauth-live-smoke.ts`, following smoke 51's pattern
(boot real deployment, real agent turn, assert on the events store):

- mcp_oauth credential against a local MCP fixture + local token
  endpoint (via the `allowInsecureTokenEndpoint` seam); short TTL so a
  refresh happens mid-session; assert the fixture sees the ROTATED
  token on the next tool call without reconnect.
- 401 path: fixture revokes the token → hint → forced refresh → retry
  → tool call succeeds; assert exactly one token-endpoint POST.
- Redirect: point a refresh at an endpoint that 302s → assert
  `redirect_blocked` (real undici already verified standalone
  2026-07-09; this pins it in the smoke).
- **Leak sweep** (the M3 DoD): dump ALL events + session responses +
  logs from the run and grep for the access token, refresh token, and
  client secret in raw, `Bearer `-prefixed, and JSON-embedded forms —
  `token_in_events: false` as smoke 51 established for static_bearer.
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
