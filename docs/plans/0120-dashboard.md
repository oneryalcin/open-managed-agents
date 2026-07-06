# 0120 — Make the dashboard real (Arc B, slice 2)

Date: 2026-07-06
Roadmap: [0114](0114-appliance-product-roadmap.md) Arc B slice 2. Depends on
0115 (appliance entrypoint) and 0119/#151 (admin API), both merged. Branches
fresh from `main` (no stacking — #151 is in).

**Handoff plan.** `file:line` against `main` at `c780068`; re-confirm before editing.

**Reviewed 2026-07-06** by Codex (review + adversarial), Opus, and Sonnet before
implementation. Findings folded in below; the disposition log is §9.

---

## 1. Why this slice exists

#151 built the admin **backend** (`/admin` workspace/key management). The
console (`ui/managed-agents-console`) is a working React shell that is (a) **not
served by the appliance** and (b) **not wired to the live API** — it reads
`/v1` via a dev-only proxy and has all mutations disabled. So OMA still "feels
like API + docs." This slice connects the two so an operator can, in a browser:
**boot appliance → open `/console` → enter admin key → create workspace → mint
key → browse that workspace via `/v1`.** That is roadmap exit-criterion 1.

**Definition of done:**
- The appliance process serves the console at `/console`; the **built Docker
  image serves it too** (verified by a container smoke check, not just local).
- The console is **self-contained**: React/ReactDOM/Babel are **vendored into
  `ui/`** and served locally — **no first-paint egress to any CDN**. An
  air-gapped install reaches a working dashboard. (This is the "one command
  boots it" tenet applied to the UI — see §9 H1.)
- An operator authenticates with `OMA_ADMIN_KEY` (session-scoped, **in-memory**,
  not persisted); create/list workspaces and mint/list/revoke keys work against
  live `/admin`; a minted key drives read-only `/v1` browsing **including file
  content download** under `OMA_AUTH_MODE=api-key`.
- **Fail-closed on the root credential**: the admin key is not accepted over a
  non-loopback bind without TLS unless the operator explicitly opts into insecure
  (§3.2). No UI redesign. The console is static and secret-free; all privileged
  actions require the admin key.

**Scope (fixed — from the direction decision):**
1. Serve the existing console from the appliance process.
2. Admin-key login; **in-memory session state, not persisted by default.**
3. Live admin calls: create/list workspaces, mint/list/revoke keys.
4. Basic `/v1` browsing with a minted workspace key.
5. Minimal, obvious mutations — do **not** redesign the UI.

---

## 2. Current-state map (verified 2026-07-06, re-confirmed by review)

- **Console = no-build, in-browser React** (`ui/managed-agents-console/index.html`):
  React 18 UMD + `@babel/standalone`, `type="text/babel"` JSX compiled
  client-side. **No bundler/build step.** Today these load from **unpkg + Google
  Fonts CDN** (`index.html:9,15-17`) — and the React builds are the *development*
  builds. This slice **vendors them locally** (§3.1); the no-build model stays.
- **`src/api.js`** (`api.js:10-27`): `fetchJson(path)` is **GET-only** (hardcoded
  `fetch(path, { headers })`, no method/body) and sends only `anthropic-beta` +
  `accept` — **no auth header**. It is a **classic script** (`index.html:20`,
  no `type="module"`), zero `export`s, surfaces one global
  `window.OmaConsoleApi = { loadConsoleData, hydrateSession }` (`api.js:369`).
- **`app.jsx:136-142`** calls `OmaConsoleApi.loadConsoleData()` **unconditionally
  on mount** (unless `?mode=demo`), with **no key gate** → served same-origin
  under the default `OMA_AUTH_MODE=api-key` (`main.ts:58`), opening `/console`
  today would **401 immediately**. The login view must gate initial load (§3.4).
- **`serve.mjs`** (dev only): static server with a **prefix-only** traversal guard
  (`serve.mjs:32`, `candidate.startsWith(root)` — a *bug*, see §3.1) + no-store +
  a content-type map, plus a `/v1` proxy. **The appliance replaces this** (serves
  `/v1` + `/admin` same-origin — no proxy). `serve.mjs` stays as dev convenience.
- **`src/main.ts`**: boots the Hono app via `@hono/node-server` `serve()`
  (`main.ts:89`); serves **no** static assets today. Note `@hono/node-server` is
  already a dependency (`main.ts:21`).
- **Dockerfile** (`Dockerfile:9-11`) copies only `src`, `bin`, `scripts` — `ui/`
  is absent, **and `.dockerignore` explicitly excludes `ui`** (§4). Both must
  change or the image can't serve `/console`.
- **Auth model** (0113/0119): `/v1` needs `x-api-key`; `/admin` needs
  `x-admin-key`. Same-origin with the console once the appliance serves it.
- **Test pattern exists**: `admin-api.test.ts:264-292` mints a key via `/admin`
  then browses `/v1` with it, calling `plane.app` directly (no real server). The
  static-serving tests and the mint→browse contract test reuse this exactly.

---

## 3. Design decisions

### 3.1 Serving the console from the appliance
Add static serving to the app assembly, **mounted at `/console`** (not `/`) so it
never shadows the API routes.

- **Hand-written handler — not `@hono/node-server`'s `serveStatic`.** serveStatic
  derives content-type from `hono/utils/mime`, which has **no `jsx` entry** (would
  serve `.jsx` as `application/octet-stream`) and **never sets `cache-control`** —
  so it cannot satisfy this slice's own tests (`.jsx` → `text/babel`, no-store).
  This is *not* a dependency-footprint tradeoff (`@hono/node-server` is already
  in). Write a small handler mirroring `serve.mjs`'s content-type map and no-store,
  with the **corrected** traversal guard below.
- **Redirect `GET /console` → `/console/`** (301/302), because the console's asset
  URLs are relative (`index.html:10,19-28`, e.g. `src/api.js`): a bare `/console`
  would resolve them as `/src/...` and break every load. `GET /console/` →
  `index.html`; `/console/src/*.jsx|.js|.css`, `/console/vendor/*` → the asset
  with the right content-type (`.jsx` → `text/babel`).
- **Boundary-correct traversal guard (fixes the `serve.mjs` bug).** Resolve the
  request path under the console root and reject anything escaping it — but a bare
  `candidate.startsWith(root)` also accepts a **sibling** like
  `…/managed-agents-console-private/…`. Use
  `candidate === root || candidate.startsWith(root + path.sep)`, after
  `path.resolve` (and, defense-in-depth, `realpath` to defeat symlink escape).
  404 on miss; `cache-control: no-store` on every asset.
- **Self-contained assets (vendored — in this slice, not deferred).** Vendor the
  **production** UMD builds of React, ReactDOM, and `@babel/standalone` into
  `ui/managed-agents-console/vendor/` and point `index.html` at them (drop the
  `unpkg` `<script src>`s and the dev builds). Result: **no CDN dependency at
  first paint** — an air-gapped/network-restricted appliance still reaches a
  working dashboard, and the "your data on your machines" product no longer leaks
  the operator's IP/referer to unpkg/Google on every load. This is a `curl`-three-
  files-and-swap-`src` change; the no-build model is preserved. Local files don't
  need SRI (integrity defends against tampering of a *remote* fetch); keep or drop
  the hashes at implement time.
  - **Fonts:** self-host the woff2 files **or** fall back to a system-font stack.
    Fonts are lower-severity than the JS runtime and — unlike the pinned scripts —
    the Google Fonts `css2` response is UA-dependent and **not SRI-pinnable** (the
    earlier "SRI-pinned fonts" claim was wrong). A system-font stack is the
    smallest self-contained option; pick at implement time.
- **CSP + framing headers on `/console` responses.** Serve
  `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval';
  style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:` plus
  `X-Frame-Options: DENY` (and `frame-ancestors 'none'`). `unsafe-eval` is
  unavoidable (in-browser Babel), but `connect-src 'self'` means an injected
  script **cannot POST the admin key to an external host**, and `frame-ancestors`
  blocks clickjacking an authenticated console into revoke/mint clicks. This is
  only *clean* because the assets are now local (vendored above).
- **Gate:** serve the console whenever the console dir exists (recommend always —
  it is secret-free static content). Do **not** couple console-serving to admin
  being enabled (a read-only `/v1` browser is useful without admin).

### 3.2 Browser auth model (the security crux)
Two credentials the browser may hold, both **session-scoped and in-memory**:

- **Admin key** — entered on a login screen, kept in **in-memory React state**
  (cleared on reload; never written to disk). **Not `localStorage`, not a cookie,
  and not `sessionStorage`** (which survives reload and can be persisted to disk
  for session-restore — persistence-at-rest of a root credential). Reload =
  re-login; that is the safe default (see §9 M2). Sent as `x-admin-key` on
  `/admin` calls only. `/admin` responses are already `no-store` (0119).
- **Workspace key** — for `/v1` browsing: either the just-minted key ("browse this
  workspace" after mint) or one the operator pastes. Same in-memory handling; sent
  as `x-api-key` on `/v1` calls.

**Fail-closed transport for the root credential (§9 H2, decided):**
- The appliance **refuses to accept `x-admin-key`** when the server bind is
  **non-loopback** and **no TLS terminator is present**, returning a clear error,
  **unless `OMA_ADMIN_ALLOW_INSECURE=1`** is set. This mirrors the codebase's
  fail-closed idiom (`OMA_AUTH_MODE`, sandbox-provider opt-in): plaintext transport
  of a root token is a conscious opt-in, never the silent default. Loopback stays
  frictionless (the documented default). Detecting "TLS present" behind a
  terminating proxy: treat an explicit `OMA_TLS_TERMINATED=1` (operator asserts a
  TLS front) as satisfying the check; document that `X-Forwarded-Proto` is not
  trusted by default. Exact detection mechanics decided at implement time; the
  **default-refuse posture is fixed.**

Rules:
- **Same-origin only.** The console is served by the appliance, so `/admin` and
  `/v1` are same-origin — no CORS, no proxy. **Header-not-cookie auth inherently
  defeats CSRF** (a custom header can't be set cross-origin without CORS, and
  there's no ambient cookie); keep it a header — do not "improve" it into a cookie.
- **Never log a key** (no `console.*` of the admin/workspace key or the minted
  plaintext). The minted plaintext is shown once in the UI with a copy control and
  a "shown once" warning, mirroring the CLI/API contract.
- **Persistence is out of scope for slice 2.** No "remember me"; default is
  in-memory only.

### 3.3 `api.js` extension
- **Make `api.js` an ES module** (`export` the functions; set `type="module"` on
  its `<script>` tag, `index.html:20`). Native ESM, still no bundler — this is what
  lets the header-injection logic be imported and unit-tested (§6).
- **Grow `fetchJson` into `request(path, { method, body })`** — today it is
  GET-only, but the admin mutations are `POST`/`DELETE` with JSON bodies
  (`admin/routes.ts:10,28,43`). Extract the **header-injection** into a pure,
  unit-testable function: `x-admin-key` for `/admin/*`, `x-api-key` for `/v1/*`,
  `anthropic-beta` for `/v1` (unchanged). 401 → surface a "re-authenticate" state
  and clear the offending key.
- **Admin methods** mirroring 0119 §4: `createWorkspace(name)`, `listWorkspaces()`,
  `mintKey(id, label?)`, `listKeys(id)`, `revokeKey(sha)`.
- **Authenticated file download.** The console renders plain
  `<a href="/v1/files/.../content">` links; a browser navigation **cannot attach
  `x-api-key`**, so under `api-key` mode downloads 401. Replace with a
  fetch→`Blob`→object-URL download (or equivalent header-preserving path) so the
  read-only `/v1` browsing DoD actually holds. Add a smoke for file download.
- Keep the existing read path; attach `x-api-key` when a workspace key is set
  (else the demo-data fallback / a "set a key" prompt).

### 3.4 UI (minimal)
- A **login view** (admin key input → validates via a cheap `GET /admin/workspaces`
  → admin mode). Reuse `forms.jsx`, `states.jsx`.
- **Bootstrap gate (`app.jsx:136`).** The mount effect currently calls
  `loadConsoleData()` unconditionally → 401 under `api-key` mode. Restructure so
  the initial load is **gated on having a credential**: show the login view first;
  only fetch once a key is set. This is a change to the existing mount/effect
  wiring (`app.jsx:116-193`: `demoMode`/`apiState`/`readOnly`), not just a new
  screen.
- An **admin panel**: list workspaces; create workspace; per workspace: list keys
  (digests/labels/revoked), mint key (show plaintext once + copy), revoke key
  (with a confirm).
- **"Browse as workspace"**: set the workspace key → the existing agents/sessions/
  environments/files views light up (already built — they just need the key).
- **No redesign, no new visual language** — extend the existing shell.

---

## 4. Wiring (where the code goes)

- `src/main.ts` (or a small `control-plane/console/serve.ts` helper): mount the
  static handler on the Hono app **before `notFound`** (`app.ts:258`), scoped to
  `/console`. Registration order is safe — Hono matches non-overlapping fixed
  prefixes independently, so `/console` won't shadow `/v1`/`/admin`. Resolve the
  console root app-root-relative (works both from a checkout and in the image).
- **The `x-admin-key` fail-closed transport check** (§3.2) lands in the admin
  auth middleware / `app.ts` where the admin key is verified.
- `ui/managed-agents-console/index.html`: point `<script>`s at `ui/.../vendor/*`
  (local, production builds); set `type="module"` on the `api.js` tag; drop CDN
  links; self-host or fall back fonts.
- `ui/managed-agents-console/vendor/`: the vendored React/ReactDOM/Babel UMD files.
- `ui/managed-agents-console/src/api.js`: ESM export + `request()` +
  header-injection + admin methods + blob download (§3.3).
- `ui/managed-agents-console/src/*.jsx`: login view + bootstrap gate + admin panel
  + "browse as workspace" (§3.4), reusing existing components.
- **`.dockerignore`: remove the `ui` exclusion**, and **Dockerfile: `COPY ui ./ui`**
  — *both*, or the build context omits the console and the image serves nothing.
  Add a **container smoke** asserting the built image answers `/console/`.

---

## 5. Security requirements (checklist)

- **Path traversal:** boundary-correct guard (`=== root || startsWith(root + sep)`,
  post-`resolve`/`realpath`); the one place serving arbitrary files. Test `../`,
  **encoded** forms (`..%2f`, `%2e%2e/`, double-encoding), **and prefix-sibling**
  escapes — not just literal `../`.
- **Self-contained / no first-paint egress:** all JS served locally; no CDN
  `<script src>` remains (grep the shipped `index.html`).
- **No secret at rest:** admin/workspace keys in-memory only — never
  `localStorage`, `sessionStorage`, or cookie. **Automated** assertion over the
  shipped JS (no `localStorage`/`sessionStorage`/cookie write of a key; no
  `console.*` of a key or minted plaintext) — this is the one security guarantee
  backend tests can't otherwise cover and the most likely to silently regress.
- **Fail-closed root-credential transport:** `x-admin-key` refused on non-loopback
  without TLS unless `OMA_ADMIN_ALLOW_INSECURE=1` (§3.2).
- **CSP + framing:** `connect-src 'self'` (+ the full policy) and
  `X-Frame-Options: DENY` / `frame-ancestors 'none'` on `/console`.
- **no-store** on console assets and `/admin` (latter already done).
- **Same-origin, header-not-cookie:** no cross-origin fetch; keep the custom
  header (CSRF-safe); document the TLS expectation alongside the fail-closed gate.

---

## 6. Tests

Backend-testable (vitest, our wheelhouse — via `plane.app` / `app.fetch`, no real
server, per `admin-api.test.ts`):
- **Static serving:** `GET /console` → redirect to `/console/`; `/console/` → 200
  `text/html`; `/console/src/api.js` → `text/javascript`; `.jsx` → `text/babel`;
  `/console/vendor/*` served; unknown → 404; `cache-control: no-store` present.
  (These pass **only** with the hand-written handler, not serveStatic — §3.1.)
- **Traversal:** `../`, encoded (`..%2f`, `%2e%2e/`, double-encoded), and
  **prefix-sibling** (`…console-private/…`) all → 404/blocked. Mutation-check the
  guard (both the boundary and the encoding paths).
- **No route shadowing:** `/v1/*` and `/admin/*` still route with `/console` mounted.
- **Fail-closed transport:** with a simulated non-loopback bind and no TLS,
  `x-admin-key` is refused; with `OMA_ADMIN_ALLOW_INSECURE=1` it is accepted;
  loopback is always accepted.
- **Mint → browse contract:** reuse `admin-api.test.ts:264-292` — mint via `/admin`,
  then `/v1` with the minted key (the contract the UI depends on).
- **Container smoke:** the built image answers `GET /console/` (guards the
  `.dockerignore`/`COPY ui` gap).

Browser JS — test the pure layer, not the DOM:
- `api.js` header injection (extracted, ESM-imported): `/admin/*` → `x-admin-key`,
  `/v1/*` → `x-api-key` + beta; 401 clears the key.
- The **automated no-secret-at-rest / no-key-logging** assertion (§5).

Do **not** stand up a headless browser for slice 2. Document the manual smoke:
boot appliance, open `/console`, login, create workspace, mint key, browse, and
**download a file**.

---

## 7. Settled / open

**Settled:** serve at `/console` via a hand-written handler; assets vendored
locally (self-contained); in-memory session-scoped keys; fail-closed admin-key
transport with `OMA_ADMIN_ALLOW_INSECURE` escape hatch; CSP + framing headers;
authenticated blob download; `.dockerignore` + `COPY ui` + container smoke;
minimal mutations; no UI redesign; appliance replaces the dev proxy.

**Open (decide at implement time — mechanics only, not posture):**
1. **TLS-present detection** behind a terminating proxy (the `OMA_TLS_TERMINATED`
   assertion vs. sniffing) — the default-refuse posture is fixed; only the
   detection mechanism is open.
2. **Fonts:** self-host woff2 vs. a system-font stack (system stack is smallest).
3. Whether to keep SRI hashes on the now-local vendor files (harmless either way).

**Resolved at implementation (2026-07-06):** (1) boot-time check — the gate
refuses construction in `createDeploymentControlPlane` (mirrors the existing
admin guards), with `OMA_TLS_TERMINATED=1` as the operator's explicit
assertion; `X-Forwarded-Proto` not trusted. (2) System-font stack — the CSS
vars already carried full fallbacks, so dropping the Google Fonts link needed
zero CSS changes. (3) SRI dropped on local files. Bonus finding: the browser
smoke proved Babel-standalone needs `script-src 'unsafe-inline'` in addition
to `'unsafe-eval'` (it executes transformed text/babel blocks inline);
`connect-src 'self'` — the directive that actually guards the key — holds.

---

## 8. Non-goals / follow-ups

- **Persistent "remember me" login** (opt-in `localStorage`) — later.
- **`/v1` mutations from the UI** (create agent/session, interrupt, send message)
  — the console keeps those disabled; this slice is admin CRUD + read-only `/v1`.
- **A build pipeline / bundler** — the no-build model stays (vendoring keeps it).
- **RBAC beyond the two tiers** — unchanged from 0119.
- **Fix `serve.mjs`'s prefix-only traversal guard** (`serve.mjs:32`) — the dev
  server has the same latent bug the appliance handler now fixes; file a follow-up
  issue so the dev path doesn't drift back into the pattern.
- **Observability** (Arc C) is the agreed next slice after this.

---

## 9. Review disposition log (2026-07-06)

Pre-implementation review by Codex (review + adversarial), Opus, Sonnet + author.
Convergence was strong; nearly everything **accepted** — most changes *correct* or
*shrink* the slice rather than grow it. The one policy call (H2) was decided by the
user: **fail-closed + escape hatch.**

- **H1 — Vendor React/ReactDOM/Babel (author, Opus).** Shipping the operator's
  primary surface on unpkg/Google breaks "one command / self-contained" for the
  exact air-gapped/regulated users who self-host (blank screen — fails *broken*,
  not closed), leaks IP/referer, and puts a CDN in the trust path of a page holding
  a root credential. **Accepted — promoted into the DoD** (§1, §3.1). Fonts +
  production builds folded in (Opus L1/L2).
- **H2 — TLS fail-open on the admin key (Opus).** Plain-HTTP non-loopback bind
  sends the root token cleartext; "document TLS" is fail-open. **Accepted —
  fail-closed refuse + `OMA_ADMIN_ALLOW_INSECURE` escape hatch** (user decision;
  §3.2).
- **Path-guard bug (Codex-adv HIGH, Opus M3, Sonnet).** `startsWith(root)` accepts
  prefix-siblings. **Accepted — boundary-correct guard + encoded/sibling tests**
  (§3.1, §5, §6). Follow-up filed for `serve.mjs` (§8).
- **serveStatic can't meet the test contract (Sonnet).** No `jsx` mime, no
  cache-control. **Accepted — mandate the hand-written handler** (§3.1); resolves
  §7-Q1.
- **Authenticated file download (Codex review P2).** `<a href>` can't carry
  `x-api-key`. **Accepted — fetch→blob** (§3.3).
- **`.dockerignore` excludes `ui` (Codex review P2, Opus L3).** `COPY ui` ships
  nothing. **Accepted — .dockerignore + Dockerfile + container smoke** (§4, §6).
- **`app.jsx:136` bootstrap 401 (Sonnet).** Unconditional load under `api-key`
  mode. **Accepted — login-first gate** (§3.4).
- **`api.js` ESM + `request()` method/body (Sonnet).** **Accepted** (§3.3).
- **CSP `connect-src 'self'` + framing (Opus M1).** **Accepted** (§3.1, §5).
- **In-memory not `sessionStorage` (Opus M2).** **Accepted** (§3.2).
- **Automate the no-secret-at-rest / no-key-logging grep (Opus M4).** **Accepted**
  (§5, §6).
