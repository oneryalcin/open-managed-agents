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

The console asks for a key on load (unless the server runs with
`OMA_AUTH_MODE=disabled`, in which case it browses `wrk_default` directly):

- **Workspace key** (`oma_…`, e.g. the one printed on first boot) — read-only
  browsing of that workspace's agents, sessions, events, spans, and files,
  including authenticated file downloads.
- **Admin key** (`OMA_ADMIN_KEY`) — everything above plus the Admin panel:
  create workspaces, mint/list/revoke API keys. Minted plaintext is shown
  once, with copy and a "browse as this workspace" shortcut. Setup:
  [dev-deployment.md](../../docs/dev-deployment.md#the-admin-api-and-console-admin-mode).

Keys live in page memory only — never `localStorage`, `sessionStorage`, or a
cookie (enforced by `src/control-plane/__tests__/console-security.test.ts`).
A reload asks again.

Admin mutations (workspace/key CRUD) are live. `/v1` mutations — create
agent/session, send message, interrupt, archive — remain deliberately
disabled in this slice.

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

Demo review mode with bundled fake data: append `?mode=demo` to either URL.
If the API is unreachable, the console falls back to the same demo data with
a warning banner.
