# Development and deployment setup

This document covers deployment knobs and operator details after the
[Getting Started](getting-started.md) flow is working. It is deliberately
boring: the Make targets are thin wrappers around the commands already used in
the repo.

## Deployment modes

Use these labels consistently in docs, issues, and PRs:

| Mode | Status | Shape | What it is for |
| --- | --- | --- | --- |
| Local development | Current | Host-run OMA process, local Docker daemon, Docker-local sandbox containers. | Contributor development and smoke tests. |
| Single-node demo | Current | One OMA process with temporary deployment stores and Docker-local sandboxes. | Local workshop parity and trusted demos. State is ephemeral. |
| Single-node durable | Current alpha | One OMA process with shared file-backed transactional storage, local object storage, and Docker-local or microsandbox-local sandboxes. | Self-hosted single-operator deployments that need restart persistence. |
| Multi-worker production | Future | API/control-plane service, durable metadata store, object storage, runtime worker pool, and remote or node-local sandbox providers. | Real scaling and multi-owner runtime execution. |

Do not describe the current server as multi-worker production. The alpha shape
is a single durable appliance: one process, one local storage root, one local
sandbox provider, and no cross-process runtime coordination.

## Appliance quickstart

For first-time setup, follow [Getting Started](getting-started.md). This page
documents deployment knobs and operator details after the canonical source
checkout path is working.

One command boots a durable, authenticated server
([plan 0115](plans/0115-appliance-entrypoint.md)). From a prepared checkout:

```bash
export ANTHROPIC_API_KEY="..."
oma up
```

`oma up` selects Docker-local explicitly and runs in the foreground. Use
`oma up --sandbox microsandbox` for the opt-in provider. Detached lifecycle
commands are planned but not implemented yet.

For Docker-local, the supported `oma up` path enables the digest-pinned egress
sidecar capability automatically. This is capability, not permission:
environments still default to `limited` with an empty allowlist, create no
sidecar, and have no network route. The console can create immutable Offline,
npm + PyPI, GitHub + package registries, or validated Custom policies.
Microsandbox-local remains offline-only in this alpha.

Operators can explicitly disable Docker egress capability:

```bash
OMA_ENABLE_EGRESS=false oma up
```

Advanced sidecar overrides must provide `OMA_ENABLE_EGRESS=true` and
`OMA_EGRESS_SIDECAR_IMAGE` together; OMA never fills in a partial override.
Production defaults use the repository-pinned immutable digest, not a mutable
tag. `oma doctor` checks whether the effective sidecar image is already local
without pulling it.

Alternatively, run the appliance with Docker Compose:

```bash
docker compose up -d
docker compose logs oma | grep x-api-key
```

The first boot initializes storage under `OMA_HOME` (default `~/.oma`, `/data`
in the container) and prints the initial workspace API key **once** — it is
stored only as a hash. If it was not saved, `oma keys mint` creates a new key
for the default local workspace while the server is running. Auth defaults to
`api-key`; port defaults to `4180`. The startup output labels the console and
API URLs, and `/` redirects browsers to `/console/`. Point any Anthropic SDK
client at `http://127.0.0.1:4180` with that `x-api-key`.

The same process serves the **operator console** at
`http://127.0.0.1:4180/console` (plan 0120). Log in there with a workspace
key to browse agents, sessions, events, and files — or with the admin key
(below) to create workspaces and mint/revoke keys from the browser. The
console is fully self-contained (vendored assets, no CDN), so it works on
air-gapped hosts. Keys entered in the browser live in page memory only:
a reload asks again, and nothing is written to browser storage.

Mint more keys or workspaces via the [admin API + console](#the-admin-api-and-console-admin-mode)
or the [provisioning CLI](#provisioning-workspaces-and-keys). Builtin-tool
execution stays off until a sandbox provider is configured (see
[Pi runtime rollout policy](#pi-runtime-rollout-policy)).

## Model providers and custom compatible endpoints

OMA uses the `AuthStorage`, `ModelRegistry`, built-in catalog, and request
adapters from its pinned Pi release. Anthropic, OpenAI, and OpenRouter are
visible by default; the operator can replace that allowlist with
`OMA_MODEL_PROVIDERS`. Workspace callers cannot register providers, change
base URLs, or write credentials.

Enable a built-in provider and store its API key without placing the secret in
shell history:

```bash
export OMA_DEFAULT_MODEL_PROVIDER="anthropic"
export OMA_DEFAULT_MODEL="claude-sonnet-5"

oma auth set openai
oma auth status openai
oma providers status
oma models list --provider openai --available
oma up
```

`oma auth set` uses a hidden prompt by default; automation may pipe exactly one
value to `oma auth set openai --stdin`. Auth mutations are deliberately
restart-required in alpha: restart `oma up` before new sessions can use the
changed credential state. `oma auth remove PROVIDER` is exact and idempotent,
including for a provider that is no longer enabled.

For an operator-defined local OpenAI-compatible endpoint, create
`~/.oma/pi/models.json` with private permissions:

```bash
mkdir -p ~/.oma/pi
chmod 700 ~/.oma ~/.oma/pi
```

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        {
          "id": "llama3.1:8b",
          "name": "Llama 3.1 8B (Local)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 32000,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Then:

```bash
chmod 700 ~/.oma ~/.oma/pi
chmod 600 ~/.oma/pi/models.json
export OMA_MODEL_PROVIDERS="anthropic,openai,openrouter,ollama"
oma models validate
oma models list --provider ollama --available
oma up
```

The literal `ollama` key is Pi's documented placeholder for a keyless local
endpoint; OMA may warn because literal credentials in `models.json` are
discouraged. Remote endpoints must use HTTPS and should use `oma auth set`, an
environment reference, or another Pi-recognized credential source instead of
literal secrets.

Support tiers:

- **OMA-verified:** provider/model paths exercised by OMA's live alpha smokes.
- **Pi-supported:** present in the pinned Pi catalog and usable when enabled
  and configured, but not independently certified by OMA.
- **Operator-defined:** compatible entries supplied through Pi `models.json`;
  advanced until the operator verifies the target endpoint.

### Provider verification

The ordinary smoke preserves CMA's Anthropic string-model input. Name a
provider to exercise OMA's explicit pair instead:

```bash
OMA_ALPHA_MODEL_PROVIDER=openai OMA_ALPHA_MODEL=gpt-4.1-mini oma smoke
```

The deterministic local lane needs no provider credential or paid model call:

```bash
oma smoke --local-compatible
```

The deterministic network lane additionally proves the supported Docker
allowlist path with real npm, uv/PyPI, and GitHub traffic, an unrelated-host
denial, and labeled-resource cleanup:

```bash
oma smoke --egress
```

It starts a loopback OpenAI Chat Completions fixture, generates a private
temporary `models.json` with Pi's `oma-local-keyless` placeholder, then proves
the exact `oma-local/oma-smoke-model` pair across the initial tool call and the
post-tool model response. The smoke also checks that workspace model discovery
reports the pair ready without exposing base URLs, headers, credential values,
or configuration paths.

For the opt-in live matrix, configure any desired provider credentials and run:

```bash
npm run alpha:smoke:providers
OMA_ALPHA_PROVIDER_LANES=local-compatible,anthropic,openai,google,openrouter \
  npm run alpha:smoke:providers
```

The second form is strict: every named live lane must have its Pi-recognized
environment credential. Defaults are deliberately low-cost models and may be
overridden with `OMA_ALPHA_ANTHROPIC_MODEL`, `OMA_ALPHA_OPENAI_MODEL`,
`OMA_ALPHA_GOOGLE_MODEL`, and `OMA_ALPHA_OPENROUTER_MODEL`. The GitHub Actions
**Provider smoke matrix** workflow is manual-only so paid calls never run from
an ordinary pull request.

The workspace-safe discovery endpoint is `GET /v1/model-catalog`. It requires
the ordinary workspace key and Managed Agents beta header, and returns only
model identity/capabilities/readiness—never base URLs, headers, credential
sources, paths, or secrets.

## Local development

From the repo root:

```bash
make install
make typecheck
make test
```

The useful targets are:

| Target | Purpose |
| --- | --- |
| `make check` | `typecheck` followed by the Vitest suite. |
| `make ui` | Serve the console via the dev static server + `/v1` proxy (dev convenience — the appliance itself serves it at `/console`). |
| `make server` | Run the CWC example OMA server on `OMA_PROBE_PORT` (default `40178`). |
| `make docker-smoke` | Run the existing deterministic Docker-local deployment smoke. |
| `make parallel-docker-smoke` | Start multiple Docker-local sandboxes concurrently without calling a model. |
| `make cwc-smoke` | Run the Python SDK CWC happy-path smoke against the local server. |
| `make gated-smoke` | Run the Python SDK ask-gated builtin-tool smoke. |

`make server`, `make docker-smoke`, and `make parallel-docker-smoke` require a
working local Docker daemon. `make cwc-smoke` and `make gated-smoke` also need
the Python example environment and a reachable OMA server. The example `.env`
file lives at `examples/ship-your-first-managed-agent/.env.example`.

The alpha console browser gate is also available directly:

```bash
npm run alpha:console-browser
```

Locally it reuses installed Google Chrome, or the executable named by
`OMA_BROWSER_EXECUTABLE`. CI installs the Chromium headless shell pinned to the
checked-in `playwright-core` version and sets
`OMA_PLAYWRIGHT_MANAGED_BROWSER=1`; the checkout does not rely on an ambient CI
browser and does not download a browser during `oma doctor` or ordinary setup.

## Docker's role

Docker is currently necessary for the `docker-local` sandbox provider. It is
not necessary to run the control-plane process itself during local development.
The safer local shape is:

1. run the OMA HTTP process on the host;
2. let OMA create one Docker sandbox container per live session;
3. keep the Docker socket out of the sandbox containers.

A Dockerized control-plane container is possible, but it creates a separate
security decision: if that container needs to launch sandbox containers, it
usually needs access to the host Docker socket. Treat that as a local-dev-only
convenience unless a future ADR explicitly accepts the risk.

### Docker socket policy

- Sandbox containers must never receive the Docker socket.
- The recommended Docker-local development shape is host-run OMA plus the local
  Docker daemon.
- A future Compose file may mount the Docker socket into the control-plane
  container only as an explicitly dev-only convenience.
- Compose-with-socket must not be documented as production-safe. Docker socket
  access is effectively host-level control.

### Host-passthrough policy

`host-passthrough` is not a sandbox. It executes agent-directed shell and file
operations on the host filesystem under an explicitly configured workspace
root. Keep it for trusted local tests only.

Rules:

- Do not use `host-passthrough` for untrusted prompts.
- Do not document `host-passthrough` as isolation.
- Do not make it selectable without the existing unsafe env gates.
- Any deployment document that discusses Docker socket risk should also mention
  `host-passthrough`, because both are host-control risks in different forms.

## Parallel sessions today

The Pi runner keeps runtime handles in a session-keyed map. Different sessions
can have distinct Docker-local sandbox containers and can run concurrently in
one process. A single session is different: while its handle is running, another
user message is sent as a Pi follow-up rather than as a second independent
turn.

`make parallel-docker-smoke` is the cheap proof path for the current local
worker shape. It creates `OMA_PARALLEL_SMOKE_SESSIONS` Docker-local sandbox
providers concurrently, writes session-specific files under
`/mnt/session/outputs`, collects those files, checks `/workspace` execution, and
verifies container cleanup.

This does not prove production concurrency. It does prove the local Docker
provider can hold several isolated session sandboxes at once without spending
model tokens.

## Workspace authentication

Design: [0113 - Workspace Authentication and Admission Control](plans/0113-workspace-authentication-admission.md).

`OMA_AUTH_MODE` selects the mode:

| Value | Behavior |
| --- | --- |
| `disabled` | No authentication. Every request resolves to `wrk_default`. |
| unset | Same as `disabled`, with a startup warning. Fine for local dev and trusted single-node; nothing beyond that. |
| `api-key` | Every Managed Agents request must send a valid, unrevoked key as the `x-api-key` header. Failures return the hosted API's 401 envelope. Zero provisioned keys means every request is 401 — the mode fails closed. |

`api-key` mode requires durable storage (`OMA_SQLITE_PATH` +
`OMA_FILE_STORAGE_ROOT`); the server refuses to start without it, because
in-memory stores could never hold a provisioned key.

### The admin API and console admin mode

Design: [0119 — Admin API](plans/0119-admin-api.md) and
[0120 — Dashboard](plans/0120-dashboard.md).

Admin mode is intentionally opt-in. For the local appliance, initialize it
with:

```bash
oma admin init
oma admin status
# restart oma up
```

This writes `~/.oma/admin.key` atomically with mode `0600`; `oma up`
automatically supplies it as `OMA_ADMIN_KEY_FILE`. The command refuses to
overwrite an existing key and prints the generated value once for console
login. Setting `OMA_ADMIN_KEY` or `OMA_ADMIN_KEY_FILE` directly remains
supported and takes precedence.

An admin key enables authenticated `/admin` HTTP routes — create/list
workspaces, mint/list/revoke keys — and with them the console's admin mode. The
key must be 32 random bytes, base64-encoded (same format as `OMA_MASTER_KEY`):

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Requires `OMA_AUTH_MODE=api-key` and durable storage; the server refuses any
other combination. The admin key and workspace keys are strictly separate
tiers: neither authenticates the other's routes. Minted plaintext is returned
exactly once (API response / console modal) and stored only as a SHA-256
digest. Every admin action is audit-logged (`type: "admin_audit"`), never
including the plaintext.

**Credential transport is gated at boot.** With `OMA_AUTH_MODE=api-key` on a
non-loopback bind (`OMA_HOST` not 127.x/localhost/::1), every `x-api-key` —
and the admin key, if set — would travel in cleartext, so the server refuses
to start unless one of:

| Variable | Meaning |
| --- | --- |
| `OMA_TLS_TERMINATED=1` | You terminate TLS in front of the appliance (reverse proxy, ingress). Your assertion; `X-Forwarded-Proto` is not trusted. |
| `OMA_ALLOW_INSECURE_TRANSPORT=1` | Plaintext transport is intentional — e.g. a container that binds `0.0.0.0` internally but whose port is published only on the host's loopback. The shipped `docker-compose.yml` sets this and maps `127.0.0.1:4180:4180` accordingly. |

Loopback binds (the non-Docker default) are never gated; `OMA_AUTH_MODE=disabled`
carries no credentials and is never gated.

### Provisioning workspaces and keys

The provisioning CLI is the no-HTTP alternative to the admin API (useful
before an admin key exists, or for scripting on the host). It opens a second,
pragma-configured connection to the live server's SQLite file — no restart
or downtime; minted and revoked keys take effect on the next request. It
refuses to touch any SQLite file the server has never initialized, so a
mistyped path fails loudly instead of minting keys into the wrong database;
start the server once with `OMA_SQLITE_PATH` + `OMA_FILE_STORAGE_ROOT`
before provisioning.

```bash
export OMA_SQLITE_PATH=/path/to/oma.db   # same file the server uses

npx tsx scripts/oma-workspaces.ts create-workspace "Acme Corp"
npx tsx scripts/oma-workspaces.ts mint-key wrk_...  ci-bot
npx tsx scripts/oma-workspaces.ts list-workspaces
npx tsx scripts/oma-workspaces.ts list-keys wrk_...
npx tsx scripts/oma-workspaces.ts revoke-key <key_sha256>
```

Key handling rules:

- The plaintext key (`oma_...`) is printed **once** at mint time and never
  stored; at rest only its SHA-256 digest exists. A lost key cannot be
  recovered — revoke it and mint a new one.
- Existing single-tenant data lives under `wrk_default`; mint a key for
  `wrk_default` to keep it reachable after enabling auth. No migration.
- Revocation gates **new requests only**. An SSE stream that was already
  admitted keeps running until the client disconnects; restart the server to
  sever a revoked tenant immediately.

Rollback: set `OMA_AUTH_MODE=disabled` and restart. All data remains, requests
resolve to `wrk_default` again, and keys become inert until re-enabled.

### Admission limits

Design: [0113 D9](plans/0113-workspace-authentication-admission.md). All
limits are unset by default (unlimited, today's behavior). Per-workspace
rejections are 429 `rate_limit_error` with a `retry-after` header;
process-wide rejections are 529 `overloaded_error`. Invalid values fail
startup.

| Env var | Bounds |
| --- | --- |
| `OMA_MAX_ACTIVE_SESSIONS_PER_WORKSPACE` | Unarchived sessions per workspace, checked at session create. |
| `OMA_MAX_PENDING_RUNTIME_TURNS_PER_WORKSPACE` | Pending runtime turns per workspace, checked before a `user.message` send persists anything. |
| `OMA_MAX_CONCURRENT_UPLOADS_PER_WORKSPACE` | In-flight file or skill uploads per workspace, reserved before multipart buffering (up to 24 MiB for files or 30 MiB for skills). |
| `OMA_MAX_CONCURRENT_UPLOADS` | Process-wide in-flight uploads (529). |
| `OMA_MAX_CONCURRENT_SSE_STREAMS_PER_WORKSPACE` | Open event streams per workspace, held for the stream's lifetime. |
| `OMA_MAX_CONCURRENT_SSE_STREAMS` | Process-wide open event streams (529). |

Skill content has a separate private-storage quota domain:

| Env var | Default | Bounds |
| --- | --- | --- |
| `OMA_SKILLS_WORKSPACE_MAX_BYTES` | 1 GiB | Positive integer bytes retained across custom skill versions in one workspace. |
| `OMA_SKILLS_MAX_VERSIONS` | 20 | Positive integer retained-version cap per custom skill. |

Notes:

- A 429 during an `Idempotency-Key` request does not consume the key: the
  reservation is released and the same-key retry re-executes once capacity
  frees.
- Counters are in-process, matching the single-node deployment tiers. A
  dedicated sandbox cap is deliberately absent in v1: sandboxes are one per
  live session handle, so the session cap bounds them.

## Observability

Design: [0121](plans/0121-observability.md) (Arc C). Three surfaces:
structured logs, `GET /health`, and `GET /metrics`.

### /health

Unauthenticated (probes can't send keys; the body carries no tenant data).
`200` when the process answers and every check passes, `503 degraded`
otherwise:

```json
{"status":"ok","version":"0.0.1","uptime_seconds":123,
 "checks":{"storage":{"status":"ok","free_bytes":123456789},"runtime":{"status":"ok"}}}
```

What readiness does **not** prove: the storage check shows the DB is
*readable*, not writable. `free_bytes` (statfs on the file-storage root)
never gates a 503 on *low space* — a disk threshold would flap the single
node and drive compose restart loops, so alert on it instead (table below).
A root that cannot be statfs'd at all (deleted, unmounted,
permission-broken) **does** fail the check: that's an absent store, not a
threshold.
In-memory deployments report `"mode": "in-memory"` rather than lying about
durability. The shipped `docker-compose.yml` healthcheck probes `/health`
with a node one-liner (the image has no curl/wget).

### /metrics

Prometheus text format, **fail-closed** by bind host (resolved at boot from
`OMA_HOST`, never per-request):

| Bind | no `OMA_METRICS_TOKEN` | `OMA_METRICS_TOKEN` set |
| --- | --- | --- |
| loopback (default) | open, unauthenticated | `Authorization: Bearer` required |
| non-loopback | **404 — fail closed** | `Authorization: Bearer` required |

`OMA_METRICS=0` disables the endpoint everywhere; unknown values refuse
boot. `OMA_METRICS_TOKEN_FILE` is the file variant (set exactly one). The
token is a read-only operational credential compared constant-time —
strictly weaker than the admin key; do **not** reuse the admin key as the
metrics token. The Docker container binds non-loopback internally, so
compose deployments need a token to scrape. Prometheus:

```yaml
scrape_configs:
  - job_name: oma
    authorization:
      credentials: <the OMA_METRICS_TOKEN value>
    static_configs:
      - targets: ["127.0.0.1:4180"]
```

Metric inventory (all labels are closed enums; no per-tenant labels —
metering is Arc D): `oma_http_requests_total{route_class,method,status}`,
`oma_http_request_duration_seconds{route_class}`, `oma_sessions_active`,
`oma_runtime_turns_pending`, `oma_runtime_turns_total{outcome}`,
`oma_runtime_turn_duration_seconds`,
`oma_admission_rejections_total{limit,status}`, `oma_sse_streams_active`,
`oma_sandboxes_total{event,provider}`,
`oma_sandbox_provider_errors_total{provider}`,
`oma_log_events_total{level}`, and `oma_process_*` gauges.

Suggested alerts (no bundled alerting; these are the signals to wire up):

| Signal | Expression sketch |
| --- | --- |
| Error-log rate | `rate(oma_log_events_total{level="error"}[5m]) > 0.1` |
| 5xx rate | `rate(oma_http_requests_total{status=~"5.."}[5m]) > 0` |
| Pending-turns growth | `deriv(oma_runtime_turns_pending[15m]) > 0` sustained |
| Admission rejections | `rate(oma_admission_rejections_total[5m]) > 0` |
| Event-loop delay | `oma_process_event_loop_delay_seconds > 0.1` |
| Disk headroom | `/health` `checks.storage.free_bytes` below your floor |

### Structured logs

Design: [0121 §3.3](plans/0121-observability.md). Every control-plane log
line is one JSON object on stdout (info/debug) or stderr (warn/error):

```json
{"ts":"2026-07-06T13:47:03.074Z","level":"info","event":"admin_audit","type":"admin_audit","request_id":"req_…","action":"create_workspace","workspace_id":"wrk_…"}
```

`event` is a snake_case grep handle. Every 5xx response logs a
`request_failed` event whose `requestId` matches the response's `request-id`
header. First-boot output (including the initially minted key) is product
UX on stdout and deliberately bypasses the logger.

Redaction is enforced by the logger itself, not by convention: content-
bearing field names are replaced with `[redacted]`, and every string value
is scrubbed for `oma_…` keys, 32-byte-base64 key shapes, and credential
header/env assignments before the line is written — see threat-model §5.

| Env var | Meaning |
| --- | --- |
| `OMA_LOG_LEVEL` | `debug`, `info` (default), `warn`, or `error`; anything else refuses startup. |
| `OMA_LOG_STACKS=1` | Include (scrubbed) stack traces in serialized errors; off by default. |

Two deltas from the pre-0121 ad-hoc logging, so upgrades aren't surprised:
runtime ownership-lost lines (`runtime_turn_ownership_lost`,
`runtime_lease_renewal_ownership_lost`) are now `debug`-level and hidden at
the default `info`; and errors no longer print stack traces unless
`OMA_LOG_STACKS=1`. `admin_audit` lines are emitted at a dedicated `audit`
level that **ignores** `OMA_LOG_LEVEL` — turning down diagnostic noise can
never silence the admin audit trail.

## MCP servers

Design: [0122](plans/0122-mcp-connector.md) M1. Agents can declare remote MCP
servers (`mcp_servers` + a matching `mcp_toolset` per server) and sessions
call their tools. The MCP client runs in the **control plane** — the sandbox
never dials MCP servers, and (from M2) never sees credentials.

**Enabling.** Off by default, like every outbound capability:

```
OMA_ENABLE_MCP=true              # the gate; orthogonal to the sandbox provider
OMA_MCP_OPERATION_TIMEOUT_MS=…   # optional; per connect/list/call, default 60000
```

With the gate off, agents declaring MCP servers still work — each server
emits one `session.error` (`mcp_connection_failed_error`, message "MCP is
disabled by deployment configuration", `retry_status: exhausted`) and the
session continues without those tools.

**Supported servers.** Remote streamable-HTTP transport only (upstream
parity). No stdio, WebSocket, or legacy HTTP+SSE — wrap local stdio servers
with an mcp-proxy-style shim if needed.

**What will refuse to connect.** Agent-supplied URLs are attacker-influenced
input, so control-plane dials are SSRF-guarded: hostnames resolving to
private/loopback/link-local/reserved ranges (including cloud metadata
addresses), IP-literal targets in those ranges, and any redirect are refused.
Validation also rejects URLs with embedded `user:pass@` credentials at agent
creation (an OMA deviation — hosted accepts these; probe 47). There is no operator override; if you need a private MCP server,
front it with a public, authenticated endpoint (M2).

**Permissions.** MCP toolsets default to `always_ask` (upstream parity): each
call pauses the session with `requires_action` until a
`user.tool_confirmation` referencing the `agent.mcp_tool_use` event id
arrives. Configure per-tool or per-toolset via `default_config`/`configs`
`permission_policy` on the `mcp_toolset`.

**Failure and retry.** Session creation never blocks on MCP connectivity
(the `mcp_connection_failed_error` wire shape follows the Anthropic SDK
types; probe 47 did not capture a live failure frame):
failures surface as `session.error` events with `retry_status`
(`retrying` → will retry on the next idle→running transition; `exhausted` →
retry budget spent, no more dials this session). Retry uses fresh-handle
mechanics — a session with a failed server doesn't keep a warm runtime handle
between turns; the next message rebuilds it and re-dials. The budget is 5
consecutive failures per (session, server) — an OMA policy, upstream
publishes none.

**Output cap.** Tool results are capped (400 KB default) with an explicit
`[truncated by oma: N bytes total]` marker — a deviation from hosted, which
spills >100K-token outputs to a sandbox file.

Metrics: `oma_mcp_tool_calls_total{outcome}` and
`oma_mcp_connections_total{event}` (see Observability above).

## Deployment target shape

The current alpha appliance is suitable for local development and
single-operator tinkering. Scale-out follow-up work is tracked in
[#103](https://github.com/oneryalcin/open-managed-agents/issues/103), with the
accepted plan in
[0103 - Deployment Hardening](plans/0103-deployment-hardening.md).

The current single-node durable shape is:

1. **One control-plane process:** HTTP API, SSE, request validation, session
   state, event append/replay, custom-tool and confirmation orchestration.
2. **Shared file-backed transactional store:** agents, environments, sessions,
   event rows, file metadata, runtime ownership, and pending waits in one
   transaction-capable deployment boundary.
3. **Local object storage:** uploaded files, internal snapshots, and session
   outputs.
4. **Local sandbox provider:** Docker-local or microsandbox-local, one sandbox
   per live session handle, with no Docker socket in the sandbox.

The future multi-worker target splits responsibilities further:

1. **Control plane:** HTTP API, SSE, request validation, session state, event
   append/replay, custom-tool and confirmation orchestration.
2. **Durable metadata store:** agents, environments, sessions, event rows, file
   metadata, runtime ownership, and pending waits. SQLite is fine for local
   single-node work; [ADR 0014](adrs/0014-storage-engine-strategy.md) chooses
   Postgres as the managed-SaaS metadata target for multi-instance deployments
   with the same owner/generation fencing semantics.
3. **Object storage:** uploaded files, internal snapshots, and session outputs.
4. **Runtime workers:** a pool that owns live turns and talks to the sandbox
   provider. Docker-local is the single-node provider. Remote providers such as
   Modal or Kubernetes pods should be separate worker backends, not an
   afterthought inside the API route.
5. **Admission controls:** per-workspace/session concurrency limits, sandbox
   quotas, model-provider rate-limit handling, and cleanup/reconciliation.

The current owner/generation ledger is the right starting point for later
workers, but multi-owner production needs liveness checks to move into the same
durable commit boundary as state changes. Do not start worker extraction before
the single-node durable store exists.

## Pi runtime rollout policy

The rollout policy for enabling the Pi-backed runtime is
[0112 - Pi Runtime Rollout Policy](plans/0112-pi-runtime-rollout-policy.md).

Important distinctions:

- `createControlPlaneApp(...)` without a runtime is the dark-runtime shape:
  events can be persisted and replayed without starting Pi, calling models, or
  launching sandboxes.
- `createDeploymentControlPlaneApp(...)` wires the Pi runtime. It is the local
  and single-node deployment entry point, not a multi-worker production worker
  pool.
- `OMA_SANDBOX_PROVIDER=none` disables builtin sandbox execution only. It is not
  a global runtime-disable flag; agents without active builtins can still run
  through Pi.
- Builtin execution requires an explicit provider and allow flag, for example
  `OMA_SANDBOX_PROVIDER=docker-local` plus `OMA_ALLOW_DOCKER_LOCAL=true`, or
  `OMA_SANDBOX_PROVIDER=microsandbox-local` plus
  `OMA_ALLOW_MICROSANDBOX_LOCAL=true`.
- `host-passthrough` remains trusted-local only and must not be described as a
  production sandbox.

Current status:

- Pi runtime is allowed for local development and trusted single-node demos.
- Single-node durable rollout requires the shared durable store, explicit
  sandbox provider gates, idempotency, pending-call recovery, cleanup/reaping,
  and a runbook-level rollback path.
- Authenticated workspace identity and single-node admission limits shipped
  with plan 0113 (#129) — see the "Workspace authentication" and "Admission
  limits" sections above.
- Multi-worker or managed-SaaS production rollout is not approved until
  telemetry, the remaining threat-model sections (egress, secrets, log
  redaction, teardown), shared-state admission counters, and the
  Postgres/async coordination boundary exist.
