# Managed Agents Console

The appliance's bundled operator UI. **The primary way to run it is not this
directory** — the OMA server serves it at `/console`:

```text
http://127.0.0.1:4180/console
```

No build step: React + ReactDOM + Babel-standalone are vendored under
`vendor/` (production UMD builds from the npm registry) and the JSX compiles
in the browser. Nothing loads from a CDN, so the console works on air-gapped
hosts.

## Logging in

The normal `oma onboard` path opens the loopback console through a short-lived,
single-use bootstrap nonce and establishes an opaque HttpOnly browser session;
no raw workspace key enters the URL or browser storage. A user can also enter a
workspace key manually when no console session exists. If the server runs with
`OMA_AUTH_MODE=disabled`, it browses `wrk_default` directly.

- **Workspace key** (`oma_…`) — workspace-scoped browsing and the console's
  narrowly allowlisted agent, environment, session, vault, credential, and
  skill workflows, including authenticated event streams and file downloads.
- **Admin key** (`OMA_ADMIN_KEY`) — everything above plus the Admin panel:
  create workspaces, mint/list/revoke API keys. Minted plaintext is shown
  once, with copy and a "browse as this workspace" shortcut. Setup:
  [dev-deployment.md](../../docs/dev-deployment.md#the-admin-api-and-console-admin-mode).

Raw keys are used only for the same-origin login exchange and are never stored
in `localStorage` or `sessionStorage`. The server returns an opaque HttpOnly
cookie whose authority is revalidated against key revocation. Reloading keeps
the console session until it expires, is revoked, or the user signs out.

Admin workspace/key CRUD is live. The workspace console also supports the
reviewed mutation set required for the single-agent flow: agent creation and
versioning/archive, environment creation/archive/delete, session creation,
prompt/interrupt/confirmation and idle archive/delete, vault/credential
creation, MCP validation, and custom-skill upload. Arbitrary `/v1` writes remain
blocked by narrow client-side capability wrappers and server authorization.

## Dev server (optional)

For UI work without a full appliance, a static server + `/v1` proxy:

```bash
npm run ui:dev            # http://127.0.0.1:4177/
```

It proxies `/v1/*` to `OMA_CONSOLE_API_BASE` (default the CWC example server
on `http://127.0.0.1:40178`). Local development convenience only — do not
expose it as a shared gateway; it forwards browser request headers to the
configured API. Admin mode needs same-origin `/admin` routes, so use the
appliance-served `/console` for that.

Demo review mode with bundled fake data is explicit: append `?mode=demo` to
either URL. A failed live API request never falls back to demo data; the console
clears live rows and renders a retryable error state.
