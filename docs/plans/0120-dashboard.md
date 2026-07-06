# 0120 — Make the dashboard real (Arc B, slice 2)

Date: 2026-07-06
Roadmap: [0114](0114-appliance-product-roadmap.md) Arc B slice 2. Depends on
0115 (appliance entrypoint) and 0119/#151 (admin API), both merged. Branches
fresh from `main` (no stacking — #151 is in).

**Handoff plan.** `file:line` against `main` at `c780068`; re-confirm before editing.

---

## 1. Why this slice exists

#151 built the admin **backend** (`/admin` workspace/key management). The
console (`ui/managed-agents-console`) is a working React shell that is (a) **not
served by the appliance** and (b) **not wired to the live API** — it reads
`/v1` via a dev-only proxy and has all mutations disabled. So OMA still "feels
like API + docs." This slice connects the two so an operator can, in a browser:
**boot appliance → open `/console` → enter admin key → create workspace → mint
key → browse that workspace via `/v1`.** That is roadmap exit-criterion 1.

**Definition of done:** the appliance process serves the console; an operator
authenticates with `OMA_ADMIN_KEY` (session-scoped, not persisted); create/list
workspaces and mint/list/revoke keys work against live `/admin`; a minted key
drives read-only `/v1` browsing. No UI redesign. Default-deny unchanged: the
console is static and secret-free; all privileged actions require the admin key.

**Scope (fixed — from the direction decision):**
1. Serve the existing console from the appliance process.
2. Admin-key login; **in-memory/sessionStorage first, not persisted by default.**
3. Live admin calls: create/list workspaces, mint/list/revoke keys.
4. Basic `/v1` browsing with a minted workspace key.
5. Minimal, obvious mutations — do **not** redesign the UI.

---

## 2. Current-state map (verified 2026-07-06)

- **Console = no-build, in-browser React** (`ui/managed-agents-console/index.html`):
  React 18 UMD + `@babel/standalone` from unpkg (SRI-pinned), `type="text/babel"`
  JSX compiled client-side. **No bundler/build step** — serving = serving the
  static files. Fonts + React + Babel load from CDN (googleapis/unpkg).
- **`src/api.js`** (the adapter): `fetchJson(path)` sends only
  `anthropic-beta` + `accept` — **no auth header** (leans on the dev proxy /
  auth-disabled dev server). Read-only: `loadConsoleData` (agents/sessions/
  environments/files via `/v1`), `hydrateSession`. Exposes
  `window.OmaConsoleApi = { loadConsoleData, hydrateSession }`. **No `/admin`
  methods, no key handling.**
- **`serve.mjs`** (dev only): serves static files with a path-traversal guard
  (`candidate.startsWith(root)`) + `cache-control: no-store` + a content-type
  map, AND proxies `/v1/*` to a local API. **The appliance replaces this** — it
  already serves `/v1` + `/admin` same-origin, so no proxy is needed. `serve.mjs`
  stays as the dev convenience; it is not shipped into the appliance path.
- **`src/main.ts`** (appliance entrypoint): boots the Hono app via
  `@hono/node-server` `serve({ fetch: app.fetch, ... })` (`main.ts:89`). It does
  **not** serve any static assets today. The console dir is `ui/managed-agents-console`.
- **Auth model** (0113): `/v1` needs `x-api-key` (workspace key) when
  `OMA_AUTH_MODE=api-key`; `/admin` needs `x-admin-key` (0119). Both same-origin
  with the console once the appliance serves it.

---

## 3. Design decisions

### 3.1 Serving the console from the appliance
Add static serving to the app assembly. **Mount at `/console`** (not `/`) so it
never shadows the API routes and the root stays free for a future landing/redirect.

- Serve `ui/managed-agents-console/**` as static files: `GET /console` must
  redirect to `/console/` (or the HTML must inject `<base href="/console/">`);
  do **not** just return `index.html` at `/console`, because the existing
  relative asset URLs (`src/api.js`, `src/app.jsx`, `src/console.css`) would
  resolve as `/src/...` instead of `/console/src/...`. `GET /console/` →
  `index.html`; `GET /console/src/*.jsx|.js|.css` → the asset with the right
  content-type (`.jsx` → `text/babel`, matching `serve.mjs`).
- **Reuse serve.mjs's exact safety posture:** normalize + decode the path, resolve
  under the console root, **reject anything escaping the root** (path traversal),
  404 on miss, `cache-control: no-store` on every asset (consistent with the
  admin no-store posture; the console is small and must not be staled).
- Prefer a small, audited static handler (mirror `serve.mjs:resolvePath`) over a
  broad dependency; if Hono's `serveStatic` (`@hono/node-server/serve-static`) is
  already available and its traversal handling is verified, use it. **Decide at
  implement time; the traversal guard is non-negotiable either way.**
- **Gate:** serve the console only when a console dir exists and (recommend)
  always — it is secret-free static content. Do **not** couple console-serving to
  admin being enabled (a read-only `/v1` browser is useful without admin).
- **CDN dependency (noted, deferred):** React/Babel/fonts load from unpkg/
  googleapis with SRI hashes (tamper-resistant, but requires egress at first
  paint — breaks air-gapped installs). Vendoring them into `ui/` is a **follow-up**
  (§8), not slice 2. Document the requirement.

### 3.2 Browser auth model (the security crux)
Two credentials the browser may hold, both **session-scoped**:

- **Admin key** — entered on a login screen, kept in **`sessionStorage`**
  (cleared when the tab closes) or in-memory React state; **never `localStorage`**,
  never a cookie, not persisted by default. Sent as `x-admin-key` on `/admin`
  calls only. `/admin` responses are already `no-store` (0119), so a minted key
  is never cached.
- **Workspace key** — for `/v1` browsing: either the just-minted key (offer
  "browse this workspace" after mint) or one the operator pastes. Kept the same
  session-scoped way; sent as `x-api-key` on `/v1` calls.

Rules:
- **Same-origin only.** The console is served by the appliance, so `/admin` and
  `/v1` are same-origin — no CORS, no proxy, no cross-origin key exposure. TLS is
  the operator's responsibility (document: run the appliance behind TLS).
- **Never log a key** (no `console.log` of the admin or workspace key or the
  minted plaintext). The minted plaintext is shown once in the UI with a copy
  control and a "shown once" warning, mirroring the CLI/API contract.
- **Optional persistence is opt-in only** (a "remember on this device" checkbox
  writing `localStorage`) — **out of scope for slice 2**; default is session-only.

### 3.3 `api.js` extension
- Add a **credential store** (module-level, set from the login flow): current
  admin key + current workspace key. Header injection in a shared `request()`:
  `x-admin-key` for `/admin/*`, `x-api-key` for `/v1/*`, `anthropic-beta` for
  `/v1` (unchanged). 401 → surface a "re-authenticate" state, clear the bad key.
- Add admin methods mirroring the API (0119 §4): `createWorkspace(name)`,
  `listWorkspaces()`, `mintKey(id, label?)`, `listKeys(id)`, `revokeKey(sha)`.
  Return the JSON shapes as-is.
- Keep the existing read path; make its `/v1` fetches attach `x-api-key` when a
  workspace key is set (else the demo-data fallback / a "set a key" prompt).

### 3.4 UI (minimal)
- A **login view** (admin key input → validates via a cheap `GET /admin/workspaces`
  → admin mode). Reuse the existing form/state components (`forms.jsx`,
  `states.jsx`).
- An **admin panel**: list workspaces; create workspace; per workspace: list keys
  (digests/labels/revoked), mint key (show plaintext once + copy), revoke key.
- **"Browse as workspace"**: set the workspace key → the existing agents/sessions/
  environments/files views light up (already built — they just need the key).
- Mutations are plain buttons with a confirm on revoke. **No redesign, no new
  visual language** — extend the existing shell.

---

## 4. Wiring (where the code goes)

- `src/main.ts` (or a small `control-plane/console/serve.ts` helper): mount the
  static handler on the Hono app before `notFound`, scoped to `/console`. It
  needs the console root path (resolve relative to repo/app root; in the Docker
  image the console dir ships at a known path — confirm the Dockerfile copies
  `ui/`).
- `ui/managed-agents-console/src/api.js`: credential store + header injection +
  admin methods (§3.3).
- `ui/managed-agents-console/src/*.jsx`: login view + admin panel + "browse as
  workspace" (§3.4), reusing existing components.
- **Dockerfile:** ensure `COPY ui ./ui` so the appliance image serves the console
  (currently copies `src` + `bin`; confirm/extend).

---

## 5. Security requirements (checklist)

- **Path traversal:** the static handler must reject any path escaping the console
  root (the one place serving arbitrary files); test with `../` and encoded forms.
- **No secret at rest by default:** admin/workspace keys live in session/memory,
  never `localStorage`/cookie unless the (out-of-scope) opt-in is added.
- **No key logging:** grep the console for `console.*` leaking a key; minted
  plaintext shown once, copyable, never persisted or re-fetchable.
- **no-store on console assets and `/admin`** (latter already done): a proxy/
  browser cache must not retain the console-with-a-key or a minted key.
- **Same-origin:** no cross-origin fetch; document the TLS expectation.
- **CDN integrity:** keep the SRI hashes on the CDN `<script>`s; note the
  air-gap/egress requirement (§8 follow-up to vendor).
- **CSP note:** in-browser Babel needs `unsafe-eval`/`unsafe-inline`; if a CSP is
  ever added to console responses it must not break the app — flag, don't add one
  blindly in slice 2.

---

## 6. Tests

Backend-testable (vitest, our wheelhouse):
- **Static serving:** `GET /console` → redirect to `/console/` (or returns
  HTML with an explicit base href); `/console/` → 200 `text/html`;
  `/console/src/api.js` →
  200 `text/javascript`; `.jsx` → `text/babel`; unknown → 404; **`../` traversal
  → 404/blocked** (mutation-check the guard); `cache-control: no-store` present.
- **Console-serving does not shadow the API:** `/v1/*` and `/admin/*` still route
  correctly with the console mounted.
- **Serving is gated on the dir existing** (or always-on) as decided.

Harder (browser JS) — test the pure layer, not the DOM:
- `api.js` credential store + header injection: `/admin/*` gets `x-admin-key`,
  `/v1/*` gets `x-api-key` + beta, 401 clears the key. (Extract the header logic
  so it is unit-testable without a browser.)
- An end-to-end-ish backend test already possible: mint a key via `/admin` (0119
  tests do this) then hit `/v1` with it — reuse to prove the "mint → browse"
  contract the UI depends on.

Do **not** stand up a headless browser for slice 2; test the serving + the api.js
logic, and treat the JSX/DOM as manually verified (document the manual smoke:
boot appliance, open `/console`, login, create+mint+browse).

---

## 7. Settled / open

**Settled:** serve at `/console`; session-scoped keys, not persisted; minimal
mutations; no UI redesign; appliance replaces the dev proxy (same-origin).

**Open (decide at implement time):**
1. **Hono `serveStatic` vs a small audited handler** — pick by verifying the
   traversal guard; default to the small handler (mirrors `serve.mjs`, no new dep).
2. **Root path resolution** in the Docker image (where `ui/` lands) — confirm the
   Dockerfile and use an app-root-relative resolve.

---

## 8. Non-goals / follow-ups

- **Vendor the CDN assets** (React/Babel/fonts) into `ui/` for air-gapped installs
  — follow-up ticket; slice 2 keeps the SRI-pinned CDN.
- **Persistent "remember me" login** (opt-in `localStorage`) — later.
- **`/v1` mutations from the UI** (create agent/session, interrupt, send message)
  — the console keeps those disabled; this slice is admin CRUD + read-only `/v1`.
- **A build pipeline / bundler** — the no-build model stays for now.
- **RBAC beyond the two tiers** — unchanged from 0119.
- **Observability** (Arc C) is the agreed next slice after this.
