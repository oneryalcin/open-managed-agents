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
   `RefreshCoordinator.refreshCredential` with `force: true` and
   `expectedAuthVersion` = the probed version, then re-probe once.
5. Map to `valid | invalid | unknown` per §7B.2 docs semantics; populate
   `refresh.status` (`no_refresh_token` when absent).
   **`refresh.http_response` NEVER carries a token-bearing body** —
   status + content-type only (§7B.3, Opus F4: the 200 grant response IS
   the secret).

Response shape is the probe-52 literal in §7B.2 (`vault_credential_validation`).

**Decision needed at implementation (flagged, not settled): validate vs
the forced-refresh floor.** The slice-4 fold scopes `forcedAdmissions`
by `authVersion` with a 60s floor. If a hostile 401 just burned the
floor slot, an operator validate inside 60s would get
`forced_refresh_floor` and report stale state. Recommended: add
`trigger: "validate"` to `RefreshCredentialInput` — joins single-flight,
bypasses the floor (operator-initiated, inherently rate-limited by being
a manual API call), still records an admission so hint-triggered calls
stay floored. Success already clears `invalid` + `auth_hint_at` and
reschedules via `persistOauthRefreshSuccess` — no new store work.

## Slice 6 — wake-loop ticker + shutdown

- **Primitive**: `createWakeLoop({ nextWakeAt, run, maxSleepMs,
  minSleepMs, onError })` in `src/control-plane/wake-loop.ts`, ~60
  lines, single `setTimeout`, no persistence; `close()` cancels the
  timer AND awaits any in-flight `run()` (§7B.3; this codebase's known
  teardown bug class). Sessions snapshot-sweep adoption is a named
  follow-up, NOT in M3.
- **Store seam**: `claimDueRefreshes(now, limit)` on `VaultStore` — the
  credential row IS the job row. SELECT active `auth_type = 'mcp_oauth'`
  rows with `next_refresh_at <= now`, EXCLUDING `refresh_status =
  'invalid'` (invalid waits for validate; §7B invalid-skip). Also
  `nextDueRefreshAt()` (or return it from the claim) for the loop's
  `nextWakeAt`. Postgres-era `UPDATE … RETURNING` claim fits behind the
  same signature; single-flight stays in-process (0113 D9).
- **Ticker run**: for each claimed row call
  `refreshCredential({...})` WITHOUT `force` — the lazy trigger; joins
  any in-flight runtime refresh via single-flight. Sleep bounds: cap 15
  min, floor 30s (§7B.3 branch-explicit policy already implemented in
  `nextRefreshAt`). Restart recovery is inherent: first loop iteration
  recomputes next wake from SQLite.
- **Ownership**: created in `createDeploymentControlPlane` next to
  `createDefaultMcpRuntime` (app.ts:536), gated on the same
  `runtimeConfig.mcp !== undefined` check that gates dialing — the
  ticker does NOT start when MCP is off (§7B.3 egress posture, four
  reviewers). Deployment close path closes the loop BEFORE
  `stores.close()` (app.ts:435–485 — every close call site).
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
  coordinator; the ticker belongs beside it.
- `src/control-plane/vaults/routes.ts`: no validate route; archive
  route at :73 is the shape template.
- `src/control-plane/app.ts`: `stores.close()` at 435/449/457/464/485;
  no background loops exist yet — the close-ordering contract is new.
