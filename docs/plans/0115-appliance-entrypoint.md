# 0115 Appliance Entrypoint and First Boot

Date: 2026-07-02

Roadmap: Arc A slice 1 of [0114 Appliance Product Roadmap](0114-appliance-product-roadmap.md).

## Purpose

Turn "a repo insiders can start" into "a thing anyone can start": one command
boots a durable, authenticated OMA server, and the first boot mints the
initial workspace API key and prints it exactly once. Before this slice the
only entrypoint was an example script
(`npx tsx examples/ship-your-first-managed-agent/oma-server.ts`) requiring
env-var knowledge plus a separate provisioning CLI before any client could
authenticate.

## Decisions

### D1 — No build step: Node runs the TypeScript source directly

Probed before building (2026-07-02, Node 24.18): plain type stripping fails on
this codebase (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` — constructor parameter
properties are non-erasable), but `node --experimental-transform-types` boots
the full deployment app and serves the hosted-identical 401 envelope. The bin
shim (`bin/open-managed-agents.mjs`) re-execs node with that flag (plus
`--disable-warning=ExperimentalWarning`) after a `>= 22.19` version check, so
`tsx` stays a devDependency and the runtime dependency footprint is unchanged.

Accepted risk: the flag is experimental. If a future Node changes it, the shim
is the single place to adapt (or swap in `tsx`).

### D2 — Defaults are overrides, not requirements

`startAppliance` (in `src/main.ts`) resolves:

| Variable | Default | Notes |
| --- | --- | --- |
| `OMA_HOME` | `~/.oma` | Only used to derive the storage pair when **neither** `OMA_SQLITE_PATH` nor `OMA_FILE_STORAGE_ROOT` is set; explicit paths win, and setting exactly one of the pair still hits the existing "must be set together" error. |
| `OMA_AUTH_MODE` | `api-key` | The appliance is authenticated by default (product posture; the bare deployment app keeps its warn-and-disable default for embedders). Explicit `disabled` is respected. |
| `OMA_PORT` | `4180` | `0` = ephemeral (tests). |
| `OMA_HOST` | `127.0.0.1` | The container image sets `0.0.0.0`. |

Sandbox provider is untouched: default remains "none", so agents that expose
builtin tools fail closed until the operator configures a provider — same
policy as [0112](0112-pi-runtime-rollout-policy.md).

### D3 — First boot mints the initial key through the live stores

First boot is detected as `workspace_api_keys` having **zero rows ever
minted** (revoked tombstones count as minted, so revoking every key does not
resurrect a printed credential on next boot). When true and auth mode is
`api-key`, the appliance mints one key on `wrk_default` labelled `first-boot`
and prints the plaintext once, before the listen banner completes. Minting
uses the same in-process stores as the server — no second SQLite connection,
no provisioning-CLI dependency at boot.

`createDeploymentControlPlane(env, opts)` was added for this (and for
boot-twice tests): identical wiring to `createDeploymentControlPlaneApp`, but
it returns `{ app, stores, authMode }` so a lifecycle-owning caller can close
the stores and release `.oma.lock`. The old function delegates to it;
embedders are unaffected.

### D4 — Docker is the fallback, not the primary

`Dockerfile` (node:24-slim, `npm ci --omit=dev`, TS source copied, no build)
plus a minimal `docker-compose.yml` (one service, one named volume at
`/data` = `OMA_HOME`). First-boot key appears in container logs:
`docker compose logs oma | grep x-api-key`.

### D5 — Deferred out of this slice

- Publishing to npm (the `bin` works from a checkout / `npm link`; `npx
  open-managed-agents` from the registry is a release decision, not code).
- Serving the console UI from the same process (Arc B).
- Any admin HTTP API (Arc B).
- Health endpoint / metrics (Arc C).

## Verification

- 8 tests in `src/control-plane/__tests__/appliance-boot.test.ts`: key printed
  exactly once; 401 without key; 200 with it; no re-mint on second boot; key
  survives restart; `disabled` mode mints nothing and serves openly; env
  derivation precedence; port validation. Mutation-checked: always-mint and
  fail-open-default mutations each caught by the suite.
- Live end-to-end through the real shim: boot on 41800, 401/200 checks, agent
  create, SIGTERM clean shutdown (port freed, lock released), reboot with no
  re-mint and the agent persisted.
- Full suite green (41 files, 495 passed / 1 skipped) after the
  `createDeploymentControlPlane` refactor.
