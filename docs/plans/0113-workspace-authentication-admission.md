# 0113 Workspace Authentication and Admission Control

Date: 2026-07-02

Issue: #129

## Purpose

Decide the authentication boundary that gives OMA real workspace identity, and
the admission-control surface that keys off it. This is the keystone gate from
the [0112 rollout policy](0112-pi-runtime-rollout-policy.md): multi-worker and
managed-SaaS rollout are blocked on workspace authentication and on admission
limits tied to authenticated workspace identity. This document is the ADR;
implementation follows in separate slices.

## Current State

- Every route resolves `DEFAULT_WORKSPACE_ID` (`wrk_default`) from
  `src/control-plane/workspace.ts`. There is no caller identity anywhere.
- The middleware chain in `createControlPlaneApp` is: request-id -> beta-header
  gate -> body limit -> routes. Nothing authenticates.
- All stores and coordinators are already workspace-scoped (`workspace_id`
  columns and parameters throughout). The data model is ready for real
  identities; only the API boundary is missing.
- `API_ERROR_TYPES` already includes `authentication_error` (401) and
  `permission_error` (403), and `ApiErrorBody` matches the hosted error
  envelope field-for-field. No error-machinery changes are needed.
- `sessionEvents.recoverAbandonedRuntimeTurns("wrk_default")` in
  `createDeploymentControlPlaneApp` hardcodes the single workspace.

## Wire-Compat Evidence

Probed against the hosted API on 2026-07-02; full transcript in
[`scratch/0113-hosted-auth-wire-probe.md`](../../scratch/0113-hosted-auth-wire-probe.md).

The load-bearing findings:

1. Exact 401 envelope, identical for missing and invalid keys:

   ```json
   {
     "type": "error",
     "error": { "type": "authentication_error", "message": "Authentication failed" },
     "request_id": "req_..."
   }
   ```

2. Empirical hosted middleware order:

   ```text
   route+method match -> authentication -> beta gate -> version check
   ```

   - Unknown paths return 404 even without credentials.
   - Unsupported methods on known paths (`PATCH/PUT/DELETE /v1/agents`)
     return 405 `"Method Not Allowed"` even without credentials (probe rows
     12-15): the hosted API resolves route **and method** before auth.
   - Matched route+method returns 401 before the beta or version headers are
     examined.
   - Valid key with missing/wrong beta returns 404 `"not found"` (OMA's
     current beta-gate message already matches).
   - The `anthropic-version` required check (400) is a separate parity gap OMA
     does not implement; out of scope here, tracked with the #64 header-parity
     work.

## Decisions

### D1. Scheme: `x-api-key` opaque bearer token

Clients authenticate exactly as against the hosted API: an `x-api-key` header
whose value is opaque. On failure OMA returns the byte-identical hosted
envelope: 401, `authentication_error`, message `"Authentication failed"`, with
`request_id` in body and header. Missing and invalid keys are
indistinguishable in the response.

No `Authorization: Bearer` support in v1. The hosted API accepts OAuth bearer
tokens on that header, but OMA has no OAuth surface; adding a second
credential channel now would be speculative.

### D2. Key format

`oma_` + 43 base64url characters (32 random bytes from `crypto.randomBytes`).

- The distinct prefix makes keys identifiable in secret scanners and logs and
  cannot be confused with Anthropic `sk-ant-` keys.
- The value is opaque to clients; wire compatibility does not constrain the
  format because clients simply echo whatever key they were given.

### D3. Storage: hashes only, own store

New `SqliteWorkspaceStore` (same per-domain store shape as
`SqliteAgentStore`), tables:

- `workspaces(workspace_id, name, created_at)`;
- `workspace_api_keys(key_sha256 PRIMARY KEY, workspace_id, label,
  created_at, revoked_at)`, with `workspace_id` a foreign key into
  `workspaces` so a key can never reference a workspace row that does not
  exist.

Store initialization **idempotently seeds the `wrk_default` row** into
`workspaces`. Without this, the FK makes minting a key for existing
single-tenant data fail (no parent row); without the FK, the `workspaces`
table is decorative. Seeding at init keeps both honest and costs one
`INSERT OR IGNORE`.

Rules:

- The plaintext key is shown exactly once at creation and never stored. At
  rest only `sha256(key)` exists.
- Lookup is by deterministic SHA-256 hash. Password-grade KDFs (bcrypt,
  argon2) are wrong here: these are 256-bit random secrets, not
  human-memorable passwords, so brute force against the hash is infeasible
  and the deterministic hash gives O(1) lookup without a per-request scan.
- Revocation is a tombstone (`revoked_at`), not a delete, so audit history
  survives.

Revocation semantics: revocation gates **admission of new requests only**.
Auth is admission-time middleware; an already-admitted long-lived SSE stream
(`GET .../events/stream`) keeps its subscription until the client disconnects
or the session closes, even if its key is revoked mid-stream. Re-checking
credentials per delivered event would put a hash lookup in the hot event path
for a marginal win. Accepted v1 posture: operators who must sever a revoked
tenant immediately restart the process (documented rollback shape). A future
hardening option is a revocation hook that closes the broadcaster
subscriptions of the affected workspace; do not build it speculatively.

### D4. Middleware placement and workspace plumbing

A new auth middleware in `createControlPlaneApp`, enabled by an optional
`auth` config on `ControlPlaneServices` construction:

- Order: request-id -> **auth** -> beta gate -> body limit -> routes,
  matching the probed hosted order.
- Scoped to the known Managed Agents route prefixes (the existing
  `isManagedAgentsRoute` set), so unknown paths still fall through to the 404
  handler without touching auth — hosted parity per probe row 10.
- On success it sets `workspaceId` in the Hono context. Route modules read
  the workspace from context instead of importing `DEFAULT_WORKSPACE_ID`;
  when auth is disabled the middleware (or its absence) supplies
  `DEFAULT_WORKSPACE_ID`, preserving today's behavior byte-for-byte.

This is deliberately a context variable, not a per-route parameter refactor:
the route signature churn stays near zero and the diff is reviewable.

Implementation rule for the context read: today every route module declares
its own private `Variables: { requestId: string }` env type. Add one shared
control-plane route env (or a `workspaceIdFrom(c)` helper) that types
`workspaceId` and falls back to `DEFAULT_WORKSPACE_ID` when unset, and use
it in every route module. No ad hoc `c.get("workspaceId") as string` casts —
those are exactly where a missed route silently keeps serving `wrk_default`
to an authenticated tenant.

Accepted divergence, method scope: the hosted API resolves route **and
method** before auth (unsupported method -> 405 pre-auth, probe rows 12-15).
OMA's prefix-scoped auth will return 401 for an unauthenticated
`PATCH /v1/agents` where hosted returns 405. OMA already diverges here today
(it returns 404 for unsupported methods); maintaining a per-prefix method
allowlist just for auth scoping is a drift hazard not worth the parity
delta. True 405 method parity is a separate gap, tracked with the #64
header-parity work.

### D5. Modes and fail-closed semantics

Deployment env: `OMA_AUTH_MODE` with exactly two values.

- `api-key`: every Managed Agents request must carry a valid, unrevoked key.
  **No keys provisioned means every request is 401** — enabling auth on an
  empty key table fails closed, never open.
- `disabled`: today's behavior, single implicit `wrk_default`.
- Unset: treated as `disabled` for compatibility with the currently allowed
  0112 tiers (local dev, trusted single-node), but the deployment app logs a
  prominent startup warning naming the flag. Any tier beyond trusted
  single-node requires `OMA_AUTH_MODE=api-key`; this amends the 0112 gate
  table when implemented.
- Unknown values fail construction (same posture as sandbox provider
  selection: reject at startup, not first use).
- `api-key` mode **requires durable deployment storage**
  (`OMA_SQLITE_PATH` + `OMA_FILE_STORAGE_ROOT`). Without them the deployment
  app builds per-process in-memory stores, so no key can ever exist and every
  request would 401 forever — safe but dead. Reject this mode/storage
  combination at construction with an error naming both flags.

### D6. Existing data and the default workspace

All existing rows live under `wrk_default`. Migration path for a single-tenant
operator turning auth on: provision a key bound to `wrk_default` and existing
agents/sessions/events remain reachable. No data migration is required.
Multi-tenant workspaces are simply new `workspace_id` values; stores already
partition on them.

### D7. Runtime recovery must become workspace-aware

`recoverAbandonedRuntimeTurns` is called once with `"wrk_default"`. With real
workspaces, recovery after restart must cover every workspace that has
pending runtime turns. The store gains a `listWorkspaceIdsWithPendingRuntimeTurns()`
(or recovery drops its workspace parameter and scans by turn state). This is
part of the auth implementation slice, not an afterthought — otherwise a
restart silently abandons non-default-workspace turns, which is a
transcript-integrity bug of exactly the class 0111 audited.

### D8. Key provisioning: operator CLI, no admin API in v1

v1 provisioning is an operator-run script (`scripts/` or a Make target) that
creates a workspace and mints a key, printing the plaintext once. An admin
HTTP API is explicitly out of scope: it would itself need an authorization
story (admin keys, scopes) that the current product shape does not justify.
Same posture as 0112's "provider selection is an operator deployment
decision".

The CLI writes to the same SQLite file the live server holds open, and this
needs an explicit path: `createDurableDeploymentStores` acquires an exclusive
`<db>.oma.lock` process lock (`deployment-storage.ts`), so the CLI **cannot**
open storage through the normal deployment-store constructor while the
server runs. Instead the CLI opens a narrow, direct SQLite connection to the
same file — same WAL + `busy_timeout` pragmas, ensures only the workspace
tables' schema — and deliberately does not take the `.oma.lock`. That is
sound because the lock guards single-*server* ownership (runtime recovery,
turn coordination), not table writes; SQLite WAL is built for exactly this
short-lived concurrent writer. The bypass must be a dedicated
`openWorkspaceStoreForProvisioning(sqlitePath)`-style entry point, not a
flag on the deployment constructor, so nothing else can accidentally skip
the lock. The alternative — requiring the server stopped for provisioning —
was rejected: it turns every key mint/revoke into downtime for no integrity
gain.

Because key lookup is a per-request query, newly minted or revoked keys take
effect without a restart.

### D9. Admission limits (follow-up slice, this ADR pins the shape)

Once requests carry workspace identity, admission limits key off it:

- max concurrent sessions per workspace;
- max concurrent runtime turns per workspace;
- max concurrent sandboxes per workspace;
- max concurrent file uploads in flight per workspace — each `POST /v1/files`
  buffers up to 24 MiB fully in memory (`files/routes.ts`,
  `MAX_FILE_UPLOAD_REQUEST_BYTES`), and the route is exempt from the global
  1 MiB body limit, so unbounded parallel uploads from one authenticated
  workspace are a memory-exhaustion vector no other limit catches;
- max concurrent SSE streams per workspace — each subscription's live queue
  is bounded at 10,000 events, so the per-stream bound is real but the
  per-workspace aggregate is not.

Enforcement placement rule: the gate must sit **before the expensive work it
protects**, which is not always a service seam.

- Sessions, runtime turns, sandboxes: service seams (session create, runtime
  dispatch, sandbox provider factory) — the cost is created there.
- File uploads: the memory cost is incurred in the **route handler**, which
  parses multipart and buffers `file.arrayBuffer()` before calling
  `service.upload` (`files/routes.ts`). A service-level counter would fire
  after the 24 MiB is already resident. The upload gate is route-level
  middleware that reserves a slot before body parsing and releases it when
  the response settles.
- SSE streams: counted at stream open, released on disconnect/close — a
  route/stream lifecycle counter, since the cost is the stream's lifetime,
  not its creation call.

Counters are scoped by `workspace_id`. Rejections are visible, wire-shaped
errors: 429
`rate_limit_error` for per-workspace limit hits, 529 `overloaded_error` for
process-wide overload. Hosted Managed Agents documents 429 + `retry-after`
for its RPM limits; OMA should send `retry-after` too. Concrete limit values
are deployment configuration, not code constants.

## Non-Goals

- Multi-user RBAC, OAuth/OIDC, per-session user identity.
- Key rotation/management HTTP API.
- Billing, quotas by spend.
- `anthropic-version` required-header parity (tracked separately, #64 area).
- Org-level hierarchy above workspaces.

## Implementation Slices

1. **This ADR + wire probe** (docs only, no behavior change).
2. **Workspace store + auth middleware + context plumbing**: D2-D7, with
   tests asserting the exact probed envelope and ordering (unknown route 404
   without key; known route 401 before beta gate; disabled mode unchanged
   behavior). Includes the multi-workspace recovery fix.
3. **Provisioning CLI** (D8) + operator docs in `docs/dev-deployment.md`.
4. **Admission limits** (D9), evidence-gated: reuse the #107 harness shape to
   verify limits reject visibly under load rather than queuing silently.

## Test Plan Anchors

- Envelope parity: middleware 401 body deep-equals the recorded probe JSON
  (modulo `request_id` value).
- Ordering: unauthenticated unknown route -> 404; unauthenticated known route
  -> 401; authenticated known route without beta -> 404 `"not found"`.
- Fail-closed: `api-key` mode with zero provisioned keys rejects everything;
  revoked key rejects; unknown `OMA_AUTH_MODE` value fails startup; `api-key`
  mode without durable storage fails startup.
- No plaintext at rest: store tests assert the key column contains only
  64-hex-char digests.
- Cross-workspace denial — the main invariant auth exists to provide, and a
  route/context-plumbing risk the workspace-scoped stores cannot catch alone:
  with keys A and B provisioned for two workspaces, key A must not be able to
  retrieve, list, delete, send to, or stream key B's agents, environments,
  sessions, files, or events **even with guessed/known resource IDs**
  (responses are the same not-found shape as for nonexistent IDs — no
  existence leak across workspaces).
- Idempotency isolation: the same `Idempotency-Key` + path in two workspaces
  must not collide (the ledger PK already includes `workspace_id`; the test
  pins the route plumbing that feeds it).
- Recovery: pending turns in two workspaces both recover after restart.

## Stop and Rollback

Rollback for a deployment that enabled auth and needs it off: set
`OMA_AUTH_MODE=disabled`, restart. All data remains; requests resolve to
`wrk_default` again. Keys are inert while disabled and resume working when
re-enabled.
