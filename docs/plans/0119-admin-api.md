# 0119 — Admin API (Arc B, slice 1): workspace + API-key management over HTTP

Date: 2026-07-06
Roadmap: [0114](0114-appliance-product-roadmap.md) Arc B ("Admin API + real
dashboard"). Depends on 0113 (workspace auth + store) and 0115 (appliance
entrypoint), both merged.

**This is a handoff plan.** Every touch point is `file:line` against `main` at
the time of writing (commit `93f8616`); re-confirm line numbers before editing.

---

## 1. Why this slice exists

Today an operator provisions workspaces and API keys **only** via a CLI
(`scripts/oma-workspaces.ts`) with direct SQLite access — you must be on the
box with the DB path. The dashboard (`ui/managed-agents-console`) is a
read-only stub with no admin HTTP API to call. To reach exit-criterion 1 of the
roadmap ("a newcomer … reaches the dashboard, mints a workspace key … without
reading the repo"), the operator surface must exist over authenticated HTTP.

This slice exposes the **exact CLI surface** (`scripts/oma-workspaces.ts:83`
`dispatch`) over `/admin` routes, behind a **distinct admin credential** — the
appliance's first authorization tier above a workspace key. Arc B slice 2 (the
console gaining admin mode) consumes this API; it is a **non-goal here** (§9).

**Definition of done:** with `OMA_ADMIN_KEY` set, an operator can
create/list workspaces and mint/list/revoke keys over HTTP using the admin
credential; a minted key immediately authenticates against `/v1/*`; a workspace
key **cannot** reach `/admin`; with `OMA_ADMIN_KEY` unset, `/admin` is disabled.
Proven by tests. No change to any `/v1` behavior.

---

## 2. Current-state map (verified 2026-07-06)

### 2.1 The logic to expose (present, CLI-only)

`SqliteWorkspaceStore` (`workspaces/store.ts`) already has the whole surface —
the admin API is a thin HTTP wrapper, **no new store logic**:

| Store method | `store.ts` | Returns |
|---|---|---|
| `createWorkspace(name)` | `:119` | `WorkspaceRow { workspace_id, name, created_at }` |
| `listWorkspaces()` | `:133` | `WorkspaceRow[]` |
| `getWorkspace(id)` | `:129` | `WorkspaceRow \| undefined` |
| `mintKey(id, label)` | `:141` | `MintedWorkspaceApiKey { plaintextKey, keySha256, workspaceId, label }` — plaintext exists only here |
| `listKeys(id)` | `:168` | `WorkspaceApiKeyRow[] { key_sha256, workspace_id, label, created_at, revoked_at }` (no plaintext) |
| `getKey(sha)` | `:137` | `WorkspaceApiKeyRow \| undefined` |
| `revokeKey(sha)` | `:164` | `boolean` |

The CLI's `dispatch` (`scripts/oma-workspaces.ts:83`) is the behavioral
reference — mirror its validation and messages (e.g. mint-key defaults label to
`"default"`; revoke is idempotent-ish: already-revoked returns a benign note;
`mintKey` throws "Workspace not found" for a missing workspace).

### 2.2 Where auth happens today

- `createControlPlaneApp` (`app.ts:144`) installs, in order: request-id
  (`:154`) → **workspace auth** (`:166`, only `if (services.auth)`) → beta gate
  (`:182`) → body limit (`:191`) → routes (`:199`).
- Workspace auth (`:166`) runs **only for `isManagedAgentsRoute` paths**
  (`app.ts:513`: `/v1/agents|environments|files|secrets|sessions`). A path
  outside that set — **including `/admin`** — skips auth entirely and, with no
  matching route, falls through to `app.notFound` (404).
- **Consequence:** `/admin` needs its **own** auth middleware. It must NOT be
  added to `isManagedAgentsRoute` (that gate maps to *workspace* keys and the
  beta header; admin is a different credential and takes no beta header).
- `DeploymentAuthMode` (`app.ts:110`) is `api-key | disabled`; `api-key`
  requires durable storage (`app.ts:260`) and a configured master key requires
  `api-key` (`app.ts` secrets guard). Admin management is meaningless without
  durable storage (nothing persists), so it inherits the same requirement.

### 2.3 Wiring seam

- `ControlPlaneServices` (`app.ts:86`) is the injection point (already carries
  `agents/environments/files/secrets/sessions/sessionEvents/auth/admission`).
- `createDeploymentControlPlane` (`app.ts:252`) builds services from `stores`;
  it has `stores.workspaces` (`SqliteWorkspaceStore`) in scope and parses env.
- No `timingSafeEqual` anywhere in `src/` yet — introduce it here for the admin
  key comparison.

---

## 3. Design decision — the admin credential model (the first RBAC decision)

**CHOSEN: a single bootstrap admin token from `OMA_ADMIN_KEY` (or
`OMA_ADMIN_KEY_FILE`), verified by constant-time comparison of fixed-length
SHA-256 digests.** Two authorization tiers, no sub-workspace roles:

| Tier | Credential | Can do |
|---|---|---|
| **Admin** (operator) | `OMA_ADMIN_KEY` via `x-admin-key` header | Create/list workspaces; mint/list/revoke keys for **any** workspace. Cannot call `/v1/*` as a workspace (it is not a workspace key). |
| **Workspace** (client) | `x-api-key` → `workspaceId` | Its own `/v1/*` resources only (unchanged). Cannot reach `/admin`. |

Why this model:

- **Appliance = single operator.** The env-token bootstrap credential mirrors
  how the appliance already handles privileged config (`OMA_MASTER_KEY`,
  `OMA_AUTH_MODE`) and dodges the *bootstrap-the-first-admin-key* regress that a
  DB-backed admin-key table would create (how do you mint the first one?).
- **Extends the secrets-API authz decision deliberately.** 0117e kept secrets
  inside the existing workspace tier and explicitly did not introduce an
  operator tier. This slice is the first operator tier, so it stays narrow:
  one root appliance credential above workspace keys, no sub-roles. If OMA
  later grows RBAC, admin routes and the secrets API adopt it together — not
  piecemeal here.
- **Ruthless simplicity.** No role tables, no session tokens, no login flow —
  a deploy-time secret checked in constant time. The dashboard (slice 2) holds
  the admin key the way any operator tool holds a root credential.

Rejected alternatives:
- *DB-backed admin keys with their own CRUD* — bootstrapping regress; premature
  for a single-operator appliance. Named-future if multi-admin is ever needed.
- *Reuse a workspace key with an `is_admin` flag* — conflates the two tiers;
  a leaked workspace key must never be privilege-escalatable to admin.

**Fail-closed rules (all enforced at construction / request time):**
1. Neither `OMA_ADMIN_KEY` nor `OMA_ADMIN_KEY_FILE` set → `/admin` is **not
   registered** (any `/admin/*` → 404, indistinguishable from an unknown route;
   no "admin exists but locked" signal).
2. Admin key set but storage is not durable **or**
   `OMA_AUTH_MODE` is not `api-key` → **refuse to boot**. Durable storage is
   required because admin changes must persist; `api-key` auth is required
   because this API mints workspace keys for `/v1/*`. Letting admin mint keys
   while `/v1` is still anonymous `wrk_default` would create a false product
   surface: keys exist, but they do not gate the API.
3. Admin key format: exactly 32 random bytes, base64-encoded. `admin/auth.ts`
   exposes `generateAdminKey()` for this. A 32-character passphrase is not
   accepted; the root appliance credential must be structurally unguessable.
4. Constant-time compare: hash the configured admin key once at construction
   and hash the presented value on every request; compare the two fixed-length
   SHA-256 digests with `crypto.timingSafeEqual`. Do **not** compare raw
   variable-length strings, where a length check or thrown `timingSafeEqual`
   precondition becomes the timing side channel.

---

## 4. Routes (OMA-minimal; not hosted-wire — hosted has no public admin API)

Mounted at `/admin`, gated by the admin middleware (§5). Error envelope reuses
`ApiError`/`toApiErrorBody` (`errors.ts`). All bodies JSON. Every enabled
`/admin` response carries `Cache-Control: no-store`, because mint responses can
contain one-time plaintext API keys.

| Method | Path | Body | Success | Notes |
|---|---|---|---|---|
| POST | `/admin/workspaces` | `{ name }` | 201 `Workspace` | `name` non-empty string |
| GET | `/admin/workspaces` | — | 200 `Workspace[]` | |
| GET | `/admin/workspaces/:id` | — | 200 `Workspace` | 404 if absent |
| POST | `/admin/workspaces/:id/keys` | `{ label? }` | 201 `MintedKey` | **plaintext returned ONCE**; label defaults `"default"`; 404 if workspace absent |
| GET | `/admin/workspaces/:id/keys` | — | 200 `KeyMetadata[]` | digests/labels/revocation only, never plaintext; 404 if workspace absent |
| DELETE | `/admin/keys/:sha256` | — | 200 `KeyMetadata` | 404 if key absent; already-revoked → 200 with `revoked_at` unchanged |

Serialized shapes (define in `admin/service.ts`; do not leak raw rows):
```
Workspace     { id, name, created_at }                       // from WorkspaceRow
MintedKey     { workspace_id, label, key_sha256, api_key }   // api_key = plaintext, ONCE
KeyMetadata   { key_sha256, workspace_id, label, created_at, revoked_at }
```
*Design note:* revoke by `:sha256` mirrors the CLI (`revoke-key <key_sha256>`).
Keeping it a top-level `/admin/keys/:sha256` (not nested under a workspace)
matches the CLI, where the digest alone identifies the key. The response echoes
`workspace_id` so the caller can confirm scope.

*Retry note:* `POST /admin/workspaces/:id/keys` is intentionally
non-idempotent in v1. Replaying a lost mint response would require storing or
reconstructing the plaintext key, violating the "returned once, stored nowhere"
property. If a client times out after a successful write, the recovery path is
operator-visible cleanup: list key digests for the workspace, revoke the stray
digest, and mint a fresh key. A future hardening option may add an
`Idempotency-Key` conflict guard, but it must not replay plaintext.

---

## 5. Admin auth middleware

A dedicated middleware, installed in `createControlPlaneApp` **only when**
`services.admin` is present, before the routes and independent of the workspace
auth / beta gate:

```
app.use("*", async (c, next) => {
  if (!isAdminRoute(c.req.path)) { await next(); return; }   // "/admin" or "/admin/..."
  const presented = c.req.header("x-admin-key");
  if (presented === undefined || !adminAuth.verify(presented)) {
    // reuse the hosted-parity 401 envelope shape
    return jsonError(toApiErrorBody(authenticationFailed(), c.get("requestId")), 401);
  }
  await next();
});
```

- `adminAuth.verify(presented)`: constant-time compare of `presented` against
  the configured key's digest. Both configured and presented values are hashed
  to fixed-length SHA-256 digests before `timingSafeEqual`; no raw
  variable-length key compare. Never logs either value.
- `isAdminRoute(path)`: `path === "/admin" || path.startsWith("/admin/")`.
- Placed so an unauthenticated `/admin/*` returns **401** (not 404) — but only
  when admin is *enabled*; when disabled the route is absent so it is 404 (§3
  rule 1). This asymmetry is intentional: a disabled deployment reveals nothing.
- Sets `Cache-Control: no-store` for every enabled `/admin` response, including
  401s.

---

## 6. Wiring

- `admin/service.ts`: `DefaultAdminService` wrapping `SqliteWorkspaceStore`
  (constructor takes the store), one method per route, returning the serialized
  shapes. Validation + not-found → `invalidRequest` / `notFound` (mirror the
  CLI's messages).
- `admin/routes.ts`: `adminRoutes(service)` → `Hono` sub-app (mirror
  `secrets/routes.ts`).
- `admin/auth.ts`: `createAdminAuth(key): { verify(presented): boolean }`.
  Store only `sha256(key)` in the verifier object; on request compare
  `sha256(presented)` with `timingSafeEqual`. `generateAdminKey()` produces the
  required 32 random bytes as canonical base64. `loadAdminKey(env)` accepts
  exactly one of `OMA_ADMIN_KEY`/`OMA_ADMIN_KEY_FILE`; strict base64-32-byte
  format; else undefined — model on `secrets/master-key.ts:38`.
- Admin mutation audit: `admin/routes.ts` emits one structured `console.info`
  JSON line per create-workspace, mint-key, and revoke-key mutation with
  `request_id`, `action`, `workspace_id`, and `key_sha256` where applicable.
  Never log plaintext API keys or admin keys. Surfacing/search UI is deferred;
  emitting the line is in this slice.
- `app.ts`:
  - `ControlPlaneServices.admin?: { service: AdminService; auth: AdminAuth }`
    (`:86`).
  - Install the middleware (§5) + `app.route("/admin", adminRoutes(...))` only
    when `services.admin` is set (`:199` neighborhood).
  - `createDeploymentControlPlane` (`:252`): `const adminKey =
    tryLoadAdminKey(env)`; if set and `stores.mode !== "durable"` **or**
    `authMode !== "api-key"` → close + throw (§3 rule 2); if set →
    `admin: { service: new DefaultAdminService(stores.workspaces), auth:
    createAdminAuth(adminKey) }`.
  - `DeploymentAuthEnv` (`:112`) gains `OMA_ADMIN_KEY`/`OMA_ADMIN_KEY_FILE`.

---

## 7. Tests (`admin-api.test.ts`, mirroring `secrets-api.test.ts`)

Behavior each test pins — every one maps to a real failure:

1. **Disabled by default** — no `OMA_ADMIN_KEY` → every `/admin/*` → 404
   (not 401, not a stack trace).
2. **Auth required** — admin enabled, no/`wrong` `x-admin-key` → 401 on all
   routes; correct key → 2xx.
3. **Workspace key cannot reach `/admin`** — a valid `x-api-key` (no
   `x-admin-key`) → 401. (The privilege boundary — the core RBAC property.)
4. **Admin key cannot reach `/v1`** — the admin token as `x-api-key` → 401
   (it is not a workspace key).
5. **create/list/get workspaces** round-trip.
6. **mint → the plaintext authenticates** — mint a key via `/admin`, then use
   it as `x-api-key` against `/v1/agents` with the normal
   `anthropic-beta: managed-agents-2026-04-01` header → 200. (Proves the API
   mints *real* keys, end to end, without weakening the beta gate.)
7. **mint response is the only plaintext** — `list-keys` never contains the
   plaintext (only digest); a second GET never re-reveals it.
8. **revoke** — revoke via `/admin`, the key then 401s against `/v1`;
   revoking an unknown sha → 404; double-revoke → 200 benign.
9. **fail-closed boot** — admin key set with in-memory storage → throws;
   admin key set while `OMA_AUTH_MODE` is unset/`disabled` → throws;
   malformed/non-canonical admin key → throws; both admin-key env vars set →
   throws.
10. **cross-workspace** — admin can mint/list keys for any workspace (that is
    the operator tier — assert two workspaces are both manageable).
11. **malformed payloads** — bad workspace names, bad labels, array bodies, and
    invalid JSON return 400.
12. **admin hardening** — enabled `/admin` responses include
    `Cache-Control: no-store`; mutation audit logs include ids/digests and never
    plaintext.

Plus a unit test for `admin/auth.ts`: `verify` true only for the exact key;
false for wrong value AND wrong length. Also assert that the verifier does not
retain the plaintext key in an enumerable field; the fixed-length digest compare
is still primarily code-review enforced, not timing-tested.

---

## 8. Settled decisions & open questions

**Settled:**
- Admin credential = generated env bootstrap token (`OMA_ADMIN_KEY[_FILE]`),
  exactly 32 random bytes as canonical base64, verified by constant-time
  fixed-digest comparison; two tiers, no sub-roles (§3).
- `/admin` disabled (404) when unset; requires durable storage **and**
  `OMA_AUTH_MODE=api-key`.
- OMA-minimal wire shape (no hosted parity to match).
- Header name: `x-admin-key`, chosen for symmetry with `x-api-key`.
- No ADR for slice 1: §3 is the decision record. Promote to an ADR only if OMA
  grows DB-backed admin keys, multi-admin, or role scopes.

**Deferred:**
1. **Delete/rename workspace, key rotation** — omitted (the CLI has neither).
   Add when the dashboard needs them; not in slice 1.

---

## 9. Non-goals

- **The dashboard / console admin mode** (Arc B slice 2) — this is the API it
  will call; UI is separate.
- Multi-admin, DB-backed admin keys, login/session flows, audit-log surfacing.
- Workspace deletion/rename, key rotation, per-key scopes.
- Any `/v1` behavior change. Any hosted-wire admin parity (there is none).
- Rate-limiting `/admin` (single-operator; revisit with multi-tenant admin).
