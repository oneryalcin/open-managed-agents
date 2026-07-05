# 0117e — Wire credentialed egress into the live session path

Date: 2026-07-05
Implements: [ADR 0016](../adrs/0016-egress-proxy-and-secret-injection.md) §2–§6.
Depends on: 0117a–d (vendored proxy, SSRF deny, egress policy, dual-homed
sidecar) and [0118](0118-sqlite-secrets-store.md) (SqliteSecretsStore), all
merged. Roadmap: capability track of the [0114 roadmap](0114-appliance-product-roadmap.md).

**This is a handoff plan.** It assumes no prior context beyond the merged code.
Every touch point is given as `file:line` against `main` at the time of writing
(commit after PR #141); re-confirm line numbers before editing.

---

## 1. Why this slice exists

0117a–d built the entire egress boundary and 0118 built the secrets store, but
**nothing connects them to a live session.** These have zero production callers
(only tests + the sidecar entrypoint):

- `resolveSessionEgressBundle` / `resolveSessionEgress` (`egress/policy.ts:330,395`)
- `createEgressSidecar` (`sandbox/docker-egress.ts`)
- `SqliteSecretsStore` — never constructed outside `secrets/` + its tests
- `loadMasterKey` — never called
- `DockerSandboxOptions.egress` (`sandbox/docker.ts:74`) — never populated in the
  real boot path

0117e is the connective tissue: at session start, parse the session's
environment `config.networking`, resolve the granted secrets through a
per-workspace `SecretsStore`, stand up the per-session proxy sidecar, and wire
the sandbox to it — so an operator-configured environment actually grants a
sandboxed agent credentialed egress it can use, without the agent ever seeing
the secret.

**Definition of done:** a real session created against an egress-granting
environment (with a seeded secret) produces an agent that can reach an
allowlisted host through the injected credential and cannot reach anything else
— proven by a gated end-to-end test. Default-deny is preserved: an environment
with no `networking` config still runs at `--network none`, no sidecar.

---

## 2. Current-state map (verified 2026-07-05)

### 2.1 The building blocks (present, dormant)

| Piece | Location | Shape |
|---|---|---|
| Secrets store | `secrets/store.ts:67` | `constructor(db: DatabaseSync, masterKey: Buffer)`; `reveal(workspaceId, name): string \| undefined` (`:200`), `put(workspaceId, name, value)` (`:` upsert), `list`, `delete`, `rotateMasterKey`, `close`. Workspace-scoped via first arg. Self-migrates (`CREATE TABLE IF NOT EXISTS`), key-epoch guard in ctor. |
| Master key | `secrets/master-key.ts:38` | `loadMasterKey(env): Buffer` — exactly one of `OMA_MASTER_KEY` / `OMA_MASTER_KEY_FILE`; strict base64 of 32 bytes. |
| Egress bundle seam | `egress/policy.ts:395` | `resolveSessionEgressBundle({ environmentConfig, revealSecret, listenPort, proxyAuthToken }) → { sandboxEnv, bundle } \| undefined`. Returns `undefined` when no `networking` (default-deny). Resolves each granted secret ONCE. Validates a URL-safe token. |
| Sidecar lifecycle | `sandbox/docker-egress.ts` | `createEgressSidecar({ dockerCommand, sessionId, bundle, sidecarImage, sidecarRepoMount?, operationTimeoutMs, labels?, readinessTimeoutMs? }) → EgressSidecar { networkName, proxyHost, proxyPort, proxyAuthToken, sharedDirHostPath, dispose() }`. `egressProxyUrl(sidecar)`. `reapEgressSidecars(...)` (crash cleanup, wired into the startup sweep). |
| Sandbox egress wiring | `sandbox/docker.ts:74` | `DockerSandboxOptions.egress?: { wiring: SandboxEgressWiring; dispose: () => void }`. `SandboxEgressWiring = { networkName, caCertDirHostPath, proxyUrl, sandboxEnv }` (`:544`). When present: swap `--network none` for the sidecar net, mount CA, inject trust+proxy+sentinel env; `dispose()` runs on every teardown path (`docker.ts:526`) and on sandbox-create failure (`docker.ts:199`). |

### 2.2 The session path (where to hook in)

- HTTP `POST /v1/sessions` (`sessions/routes.ts:21`) → `service.create*` →
  `createInternalReserved` (`sessions/service.ts:273`). Persists a `SessionRow`
  with `environment_id`. **Loads the environment at `service.ts:294`** — but only
  for an existence check; `environment.config` is not forwarded and only
  `environment.id` is stored (`service.ts:325`). No sandbox created here (unless
  file mounts).
- **The sandbox is created lazily** on first prompt: `events/service.ts:1259`
  → `runner.runUserMessage` → `runOnSession` → `getOrCreateHandle`
  (`runner.ts:524`). The load-bearing call:
  ```
  runner.ts:546   const sandboxProviderFactory = this.resolveSandboxProviderFactory();
  runner.ts:550   sandbox = await sandboxProviderFactory?.(workspaceId, sessionId);
  ```
  `prepareSession` (mounts path) is NOT universal — most sessions never call it,
  so **`getOrCreateHandle` is the only reliable hook.**
- **Dispose is solved.** `SandboxProvider.dispose()` is called from `evict`
  (`runner.ts:790`, the steady-state teardown for idle/close/error/TTL) and two
  early-abort sites (`runner.ts:574`, `:591`). Because the sidecar's `dispose`
  hangs off `SandboxProvider.dispose()` (`docker.ts:526`), all paths already
  tear the sidecar + its `--internal` network + temp secret root down. **Keep
  the sidecar owned by the provider; do not track it separately in the runner.**

### 2.3 The factory seam (the blocker)

```
SandboxProviderFactory = (workspaceId, sessionId) => Promise<SandboxProvider>   // provider.ts:80
```
Too narrow: no environment config, no secrets accessor. And it is **built once at
boot from static env config** — `createDockerSandboxProviderFactory(opts)`
(`docker.ts:133`) freezes `opts.egress` (always `undefined`) for the whole
factory lifetime. The sole production call site is the docker-local branch:
```
selection.ts:134   return createDockerSandboxProviderFactory({
                     envAllowlist, operationTimeoutMs, reapStaleContainersOlderThanMs });
```
It passes no `image` and no `egress`. This is the one place 0117e extends.

### 2.4 Config + storage wiring

- Stores are constructed with a shared `DatabaseSync` in `createDurableDeploymentStores`
  (`deployment-storage.ts:136` creates `db`; `:140-144` constructs each store).
  `DeploymentStores` (`:42`) + `close()` (`:172`).
- Runtime config: `parseDeploymentRuntimeConfigFromEnv` (`deployment-runtime-config.ts:51`);
  docker-local branch `:65`; env-key allowlist `DEPLOYMENT_RUNTIME_ENV_KEYS` `:9`;
  boolean gate pattern `allowDockerLocal` `:78` via `parseBoolean` `:180`.
- Assembly: `createDeploymentControlPlane` (`app.ts:235`) → `stores` (`:242`),
  `runner = createDeploymentPiSessionRunner(runtimeConfig, {...})` (`:251`). The
  runner is built **once**, shared across all workspaces/sessions, and holds
  **neither** `EnvironmentStore` nor `SecretsStore`.
- **No secrets CRUD** exists (no `/v1/secrets` route, no service). An operator
  has no way to `put` a secret today.
- **The appliance cannot introspect its own image** (Dockerfile records no tag;
  compose has no `image:`). The sidecar image must therefore be explicit config.

---

## 3. Design decision — extend the docker factory, leave the generic seam alone

Two candidate seams were considered:

**Option A (CHOSEN) — resolve egress inside the docker factory closure.**
Keep `SandboxProviderFactory` unchanged and the runner untouched. Give
`createDockerSandboxProviderFactory` two new inputs: the sidecar image/repo-mount
(deployment-static) and a **pre-bound `resolveEgressBundle(workspaceId,
sessionId)` callback** (built in `app.ts`, closing over the stores). The factory
closure — which already receives `(workspaceId, sessionId)` — calls the
callback, and if it returns a bundle, stands up the sidecar and passes
`egress` into `createDockerSandboxProvider`.

```
app.ts builds:  resolveEgressBundle(wid, sid) =>
                  session = sessionStore.retrieve(wid, sid)          // -> environment_id
                  env     = environmentStore.retrieve(wid, session.environment_id)
                  return resolveSessionEgressBundle({
                    environmentConfig: env.config,                   // JsonObject; .networking inside
                    revealSecret: (name) => secretsStore?.reveal(wid, name),
                    listenPort: SIDECAR_PORT,
                    proxyAuthToken: randomUrlSafeToken(),
                  })                                                 // undefined => no egress

docker factory closure (wid, sid) =>
                  resolved = await resolveEgressBundle?.(wid, sid)
                  let egress
                  if (resolved) {
                    sidecar = await createEgressSidecar({ bundle: resolved.bundle,
                                sidecarImage, sidecarRepoMount, dockerCommand, sessionId: sid, ... })
                    egress = { wiring: { networkName: sidecar.networkName,
                                caCertDirHostPath: sidecar.sharedDirHostPath,
                                proxyUrl: egressProxyUrl(sidecar),
                                sandboxEnv: resolved.sandboxEnv },
                               dispose: sidecar.dispose }
                  }
                  return createDockerSandboxProvider(wid, sid, { ...opts, egress })
```

Why A wins:
- **Egress stays docker-scoped.** microsandbox (no-secret posture, #130) and
  host-passthrough (unsafe dev) do not get egress; the generic
  `SandboxProviderFactory` type stays clean.
- **The runner needs zero changes** — it already calls `factory(wid, sid)`.
- **Dispose stays correct for free** — the sidecar rides `SandboxProvider.dispose()`
  exactly as 0117d built it; every early-abort path already handled.
- The only new coupling is `app.ts` → stores (it already builds store-derived
  closures like `fileMountResolver`).

**Option B (REJECTED) — widen `SandboxProviderFactory` to a third `egress?`
arg and resolve in the runner.** Rejected: it puts docker-specific egress
resolution in the generic runner, couples the runner to `docker-egress.ts` and
the stores, and touches the hottest code path (`getOrCreateHandle`) for a
docker-only concern. Option A confines the change to the docker seam.

---

## 4. Sub-slices (each its own PR, in order)

### 0117e-1 — Instantiate the SecretsStore

Construct `SqliteSecretsStore` in the durable stores, **only when a master key
is configured** (so no-key deployments and in-memory mode keep working).

- `deployment-storage.ts`: in `createDurableDeploymentStores`, after `db` is
  created (`:136`), `const masterKey = tryLoadMasterKey(env); const secrets =
  masterKey ? new SqliteSecretsStore(db, masterKey) : undefined;`. Add
  `secrets?: SqliteSecretsStore` to `DeploymentStores` (`:42`) and to `close()`
  (`:172`). Add `OMA_MASTER_KEY` / `OMA_MASTER_KEY_FILE` to `DeploymentStorageEnv`
  (`:37`).
  - `tryLoadMasterKey`: returns `undefined` when neither env var is set;
    **throws** (fail-fast) when a key is set but malformed (do not swallow a bad
    key). `loadMasterKey` already throws on malformed; wrap only the
    "neither set" case.
- In-memory mode (`deployment-storage.ts:84`): each store opens its own
  `:memory:` DB. Either construct a `:memory:` secrets store when a key is set,
  or leave `secrets` undefined for in-memory. Recommend: honor the key if set
  (so in-memory tests can exercise secrets), else `undefined`.
- **Tests:** boot with `OMA_MASTER_KEY` set → `stores.secrets` defined,
  round-trips a `put`/`reveal`; boot without → `undefined`; boot with a
  malformed key → throws at startup.

### 0117e-2 — Secret seeding path (operator writes secrets)

Consumption is untestable end-to-end without a way to put a secret.
**Decided:** a **minimal workspace-scoped secrets HTTP API** (operators need it
regardless), value write-only:

- `secrets/routes.ts` + `secrets/service.ts` mirroring `environments/`:
  - `POST /v1/secrets` `{ name, value }` → 201 `SecretMetadata` (never the value)
  - `GET /v1/secrets` → `SecretMetadata[]` (metadata only)
  - `DELETE /v1/secrets/{name}` → 204
  - Workspace scoping via the existing auth middleware (`workspaceIdFrom(c)`,
    `workspace.ts:19`). If `stores.secrets` is undefined (no master key), the
    route returns a clear 4xx ("secrets require OMA_MASTER_KEY").
- Register in `app.ts` alongside the other five route prefixes (`:186`,
  `isManagedAgentsRoute` `:429`), add `secrets` to `ControlPlaneServices`
  (`app.ts:76`).
- **Tests:** put→list→reveal-not-exposed→delete; no-key deployment returns the
  guard error; cross-workspace isolation (workspace A cannot see B's secret).
- *Scope note:* if wire-compatibility with a hosted secrets API shape matters,
  confirm the endpoint/field names against the reference before finalizing;
  otherwise keep it OMA-minimal.

### 0117e-3 — Egress resolver + docker factory wiring + config knobs

The core of 0117e (Option A from §3).

- **New config knobs** (env → runtime config → factory):
  | Knob | Read in | Flows to |
  |---|---|---|
  | `OMA_EGRESS_SIDECAR_IMAGE` | `deployment-runtime-config.ts:65` docker branch; add to `DEPLOYMENT_RUNTIME_ENV_KEYS` `:9` | `createEgressSidecar({ sidecarImage })`. **Required** to enable egress (appliance can't introspect its own image). |
  | `OMA_EGRESS_SIDECAR_REPO_MOUNT` (optional, dev) | same | `createEgressSidecar({ sidecarRepoMount })` — for `node:24-slim`+repo dev/test. |
  | `OMA_ENABLE_EGRESS` (explicit boolean) | `parseBoolean` pattern `:180` | whether the factory builds egress at all. Default off → default-deny preserved. Egress requires BOTH this flag AND `OMA_EGRESS_SIDECAR_IMAGE` — setting an image alone must not silently change network posture. |
- **Selection type** (`selection.ts:14`): add `sidecarImage?`, `sidecarRepoMount?`
  to the `docker-local` variant (or carry them in the resolver options).
- **`SandboxProviderSelectionResolverOptions`**: add an optional
  `egress?: { sidecarImage: string; sidecarRepoMount?: string;
  resolveEgressBundle: (wid, sid) => Promise<{ bundle: SessionEgressBundle;
  sandboxEnv: Record<string,string> } | undefined> }`. Built in `app.ts` (it has
  the stores) and threaded through `createDeploymentPiSessionRunner` →
  runner opts → `resolveSandboxProviderFactory` → the docker branch
  (`selection.ts:134`).
- **`createDockerSandboxProviderFactory`** (`docker.ts:133`): accept the sidecar
  image/repo-mount + `resolveEgressBundle`. In the returned closure, build
  `egress` (per §3) before delegating to `createDockerSandboxProvider`. Wrap the
  sidecar creation so any throw after `createEgressSidecar` succeeds disposes it
  (createEgressSidecar already self-cleans on its own failure).
- **`app.ts`**: build `resolveEgressBundle` closing over `stores.sessions`,
  `stores.environments`, `stores.secrets`; generate a per-session URL-safe
  proxy-auth token (`randomBytes(24).toString("hex")`); fixed `listenPort`
  (sidecar `DEFAULT_SIDECAR_PORT`). Inject into the runner options.
- **Fail-closed provider gate:** if an environment has a `networking` config but
  the active provider cannot honor it (not docker-local, or egress disabled, or
  credentials present but `stores.secrets` undefined), **reject session creation**
  with a clear error rather than silently running without the boundary. Put this
  guard at `sessions/service.ts:294` (where the environment is already loaded) —
  it needs to know the deployment's provider/egress capability (thread a small
  capability flag into the service). *This is the most important safety
  requirement in the slice.*
- **Tests (non-Docker):** the resolver returns `undefined` for an environment
  with no networking; builds a bundle with sentinels + resolved secret for a
  granted one; the fail-closed gate rejects networking-on-non-docker and
  credentials-without-secrets-store.

### 0117e-4 — End-to-end wired test (the ADR-owed proof)

A gated (`dockerIt`) integration test that exercises the whole path, reusing the
0117d confinement harness:

- Seed a secret (`stores.secrets.put(wid, "github", "REAL-TOKEN")`).
- Create an environment whose `config.networking` allows a controlled upstream
  and grants that secret to it, path/method-scoped.
- Create a session against it and drive a prompt (or call the runner directly)
  so the agent's `bash` `curl`s the allowlisted host **through the injected
  credential**; assert (a) the upstream saw the REAL token, not the sentinel
  (verify-before-inject in the *wired* path); (b) an off-path/off-method request
  is denied (path/method inject scope in the *wired session*); (c) a raw dial to
  a non-allowlisted host is dropped (confinement).
- This closes the "tests owed" items in `0117-egress-proxy-vendor.md` §"Tests
  owed" that were marked as landing with the wired path.

---

## 5. Data flow (end state)

```
POST /v1/sessions {environment_id}
  └─ service.createInternalReserved: load env, FAIL-CLOSED if networking present
     but provider can't honor it; persist SessionRow{environment_id}

first prompt ─ events/service ─ runner.runUserMessage ─ getOrCreateHandle
  └─ factory(workspaceId, sessionId)                    [docker-local]
       ├─ resolveEgressBundle(wid, sid)
       │    ├─ sessionStore -> environment_id -> environmentStore -> config.networking
       │    ├─ revealSecret = name => secretsStore.reveal(wid, name)
       │    └─ resolveSessionEgressBundle(...) -> { sandboxEnv, bundle }  (or undefined)
       ├─ createEgressSidecar(bundle, sidecarImage, ...) -> dual-homed proxy container
       └─ createDockerSandboxProvider(..., { egress: { wiring, dispose } })
            └─ sandbox joins the --internal net; CA + HTTPS_PROXY + sentinels wired

agent bash: curl https://allowed.host  ──proxy──> injects real secret at TLS boundary
agent bash: curl https://evil.host      ──> dropped (--internal)

session end / idle / error ─ evict ─ SandboxProvider.dispose() ─ sidecar.dispose()
```

---

## 6. Cross-cutting requirements & edge cases

- **Default-deny is sacred.** No `networking` config → `resolveEgressBundle`
  returns `undefined` → no sidecar → `--network none`. No behavior change for
  today's sessions. Assert this explicitly in a test.
- **Fail-closed everywhere** (§4 0117e-3): networking-on-non-docker, egress
  disabled, or credentials without a secrets store → reject at session-create.
  Never run a credential-granting environment without the boundary.
- **Secrets at rest.** The resolved bundle (real secrets) is written 0600 and
  unlinked at sidecar readiness (0117d). The `revealSecret` closure holds
  plaintext only transiently. Do not log bundles or reveal results.
- **Latency.** `createEgressSidecar` waits up to `readinessTimeoutMs` (default
  20s) inside `getOrCreateHandle`, so a slow/failed sidecar becomes a
  session-start failure (acceptable, fail-closed). Consider a dedicated
  `OMA_EGRESS_SIDECAR_READY_TIMEOUT_MS`; interacts with the mounts-path
  idempotency heartbeat.
- **Sidecar uid vs bind mounts.** The sidecar runs as the control-plane's own
  uid/gid (`currentUserSpec`, 0117d) so it can read the 0600 bundle. In the
  containerized appliance this requires the control-plane and sidecar to agree
  on uid — verify on native Linux (works on Docker Desktop). Document.
- **Containerized appliance needs docker.sock + the image knob.** For the
  compose appliance to use docker-local egress it must mount
  `/var/run/docker.sock` and set `OMA_EGRESS_SIDECAR_IMAGE` to its own tag.
  Update `docker-compose.yml` + operator docs (this is a deployment doc task,
  not code).
- **Token safety.** Generate hex/base64url tokens (URL-safe) — the seam already
  rejects non-URL-safe tokens (`policy.ts` validation, 0117d).

---

## 7. Settled decisions

- **Secrets seeding (0117e-2): minimal workspace-scoped HTTP secrets API**
  (POST/GET/DELETE `/v1/secrets`, value write-only). Operators need it
  regardless of the e2e test.
- **Enable-egress gate: an explicit `OMA_ENABLE_EGRESS` boolean.** Egress
  requires both the flag and `OMA_EGRESS_SIDECAR_IMAGE`; setting an image alone
  never changes network posture.

### Still open (decide at implementation time)

1. **In-memory mode + secrets:** construct a `:memory:` secrets store when a key
   is set, or always `undefined` for in-memory? Recommend: honor the key so
   in-memory tests can exercise secrets.
2. **PR granularity:** four PRs as above, or fold 0117e-1+0117e-3 (store + wiring)
   into one and keep seeding + e2e separate? Recommend four for reviewability.

## 8. Non-goals

Skills, MCP, repo mounts (later capability slices). A full operator secrets
management UI. Response redaction (ADR 0016 §6, deferred). Multi-provider egress
beyond docker-local (microsandbox keeps its no-secret posture, #130). Rotating a
live session's secrets mid-session (bundle is resolved once at launch, 0117d).
