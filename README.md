# Open Managed Agents

**Claude Managed Agents, self-hosted.**

Swap the `base_url` in your Anthropic SDK and your agents run here instead:
same API, same event stream, same sandboxed execution — but the sessions,
files, and sandboxes live on your machines, under your policies.

> **Where OMA stands today:** wire-compatible on the synchronous single-agent
> core — agents, sessions, sandboxes, tools, skills, MCP, vaults, SSE — with
> sandbox security and egress controls that go beyond CMA's documented
> self-hosted baseline. The orchestration/persistence layer (multi-agent
> runtime, memory stores,
> scheduled deployments, webhooks, outcomes) is deliberately deferred. See
> **[PARITY.md](PARITY.md)** for the full domain-by-domain scorecard and the
> active parity worklist, and **[ALPHA.md](ALPHA.md)** for the first-user
> alpha readiness plan.

## Quickstart

From a checkout (Node ≥ 22.19, Docker running):

```bash
npm install
npm link
export ANTHROPIC_API_KEY="..."
oma up
```

`oma up` starts the durable appliance in the foreground with Docker-local
sandboxing, stores data under `~/.oma`, and prints the console URL and first
workspace API key once. Visiting the bare server URL redirects to the console.
Press Ctrl-C to stop it. In another terminal, run the disposable
end-to-end check with:

```bash
oma smoke
```

The smoke starts an isolated temporary OMA server, creates an
agent/environment/session, requires a real `bash` sandbox call, verifies the
public tool/result/message events, and cleans up. Useful overrides:

```bash
OMA_ALPHA_MODEL=claude-sonnet-5 oma smoke
OMA_ALPHA_MODEL_PROVIDER=openai OMA_ALPHA_MODEL=gpt-4.1-mini oma smoke
oma smoke --sandbox microsandbox
oma smoke --local-compatible
OMA_ALPHA_BASE_URL=http://127.0.0.1:4180 OMA_ALPHA_API_KEY=oma_... oma smoke
```

The repo-local `npm run alpha:smoke` alias remains available. Existing-server
smoke mode assumes that server already has an explicit sandbox provider and
therefore skips local sandbox prerequisite checks.

`oma smoke --local-compatible` is the no-paid-API multi-provider proof: it
starts a deterministic loopback OpenAI-compatible endpoint, writes a private
temporary Pi `models.json`, verifies the exact custom provider/model through
both model requests and a real Docker `bash` round trip, then removes all
temporary state. To run every credentialed lane available in your environment:

```bash
npm run alpha:smoke:providers
# Or select strict lanes; a requested lane fails if its credential is absent:
OMA_ALPHA_PROVIDER_LANES=local-compatible,openai npm run alpha:smoke:providers
```

### Choose another Pi model provider

OMA reuses the provider catalog and request adapters from its pinned Pi
release. Providers are operator-enabled, and agents persist an exact
`{provider,id}` pair. For a built-in provider such as OpenAI:

```bash
export OMA_MODEL_PROVIDERS="anthropic,openai"
oma auth set openai             # hidden prompt; use --stdin for automation
oma providers status
oma models list --provider openai --available
oma up                          # restart after any `oma auth` mutation
```

The console's Create Agent dialog reads the same authenticated catalog and
shows whether the selected model has configured credentials. Missing
credentials do not prevent defining an agent, but session creation fails
closed until the operator configures them and restarts `oma up`.

Operator-defined OpenAI-, Anthropic-, and Google-compatible endpoints use Pi's
existing `models.json` format at `~/.oma/pi/models.json` (or
`OMA_PI_MODELS_FILE`). Validate configuration before starting:

```bash
oma models validate
```

See [development/deployment setup](docs/dev-deployment.md#model-providers-and-custom-compatible-endpoints)
for a complete local-compatible example and the support tiers. OMA does not
expose provider base URLs or credentials through its workspace API or console.

To choose microsandbox for the durable server:

```bash
oma up --sandbox microsandbox
```

If the one-time first-boot key was not saved, mint another against the local
appliance database while the server is running:

```bash
oma keys mint
oma keys list
oma workspaces list
```

Use `--workspace`, `--label`, or `--db` when operating on a non-default local
workspace/database. Appliance-wide admin mode remains opt-in:

```bash
oma admin init     # writes ~/.oma/admin.key with mode 0600 and prints it once
oma admin status
# restart oma up after initialization
```

`oma up` automatically uses that local admin-key file when present. It is not
created on ordinary first boot because most single-workspace users do not need
cross-workspace admin HTTP routes. Rotation is deliberately deferred.

Detached lifecycle commands (`oma up --detach`, `oma
logs`, and `oma down`) are planned but not implemented; keep the foreground
terminal open for now.

Interactive, air-gap-safe OpenAPI documentation is served at `/docs/`, with
the same schema available to tools at `/openapi.json`. The documentation lists
only routes OMA currently ships; workspace and admin credentials entered in
the UI stay in page memory and are not persisted.

Alternatively, run the appliance with Docker Compose:

```bash
docker compose up -d
docker compose logs oma | grep x-api-key
```

First boot initializes durable storage (default `~/.oma`, `/data` in the
container) and prints your workspace API key **once**. Open the bundled
console at `http://127.0.0.1:4180/console` and log in with that key to browse
your workspace — or set `OMA_ADMIN_KEY` to manage workspaces and mint keys
from the browser ([setup](docs/dev-deployment.md#the-admin-api-and-console-admin-mode)).
Then point the ordinary Anthropic SDK at it — no OMA-specific client:

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://127.0.0.1:4180",
    api_key="oma_...",  # printed on first boot
    default_headers={"anthropic-beta": "managed-agents-2026-04-01"},
)

agent = client.beta.agents.create(name="helper", model="claude-sonnet-5")
env = client.beta.environments.create(
    name="dev",
    config={"networking": {"type": "limited", "allowed_hosts": []}},  # default-deny
)
session = client.beta.sessions.create(agent=agent.id, environment_id=env.id)

with client.beta.sessions.events.stream(session.id) as stream:
    client.beta.sessions.events.send(session.id, events=[
        {"type": "user.message", "content": [{"type": "text", "text": "hello"}]},
    ])
    for event in stream:
        print(event.type)
```

A complete working example (file mounts, custom tools, tool confirmations,
Streamlit UI) lives in
[examples/ship-your-first-managed-agent](examples/ship-your-first-managed-agent/README.md).
Config overrides and key provisioning:
[Development and deployment setup](docs/dev-deployment.md).

## Why This Exists

Managed Agents give agents a durable place to work: sessions, event history,
streaming updates, custom tools, and sandboxed filesystem/shell execution. The
hosted version is convenient, but some teams need the same API shape with
their own runtime, data boundary, sandbox policy, or deployment environment.
OMA is that control plane.

## How It Is Built

Three habits shape every slice of this codebase, and they are the reason to
trust it over a feature checklist:

- **Wire parity is measured, not assumed.** Behavior is cloned by probing the
  hosted API and recording the evidence — error envelopes, middleware
  ordering, event sequences — before implementation
  (`scratch/`, [docs/references/](docs/references.md)). When hosted says 405
  before auth, so do we.
- **Everything fails closed.** Unknown config values refuse to start; auth
  without durable storage refuses to start; sandbox providers must be
  explicitly enabled; builtin tools without a provider refuse to run. The
  default is always the safe posture, never the convenient one.
- **Narrow surface, high rigor.** Every slice ships with adversarial review,
  mutation-checked tests, and a plan document recording what was decided and
  why ([docs/plans/](docs/index.md)). We would rather do fewer things whose
  failure modes are known than more things whose failure modes are a surprise.

## Current Status

A working single-node appliance: durable, authenticated, multi-tenant on one
node, with real sandboxed execution. Not yet full parity with the hosted
Managed Agents beta surface.

What works today, at outcome level:

- **One command boots it** — durable SQLite storage, fail-closed auth, and a
  first-boot API key ([plan 0115](docs/plans/0115-appliance-entrypoint.md)).
- **The full agent loop runs**: agents, environments, sessions, file mounts,
  streaming events with reconnect/replay, custom-tool round trips, permission
  gating, interrupts — on the Pi runtime with crash-safe recovery of pending
  work.
- **Multi-tenant on one node**: hashed `x-api-key` workspaces, per-workspace
  admission limits, request idempotency on the retry-sensitive endpoints
  ([plan 0113](docs/plans/0113-workspace-authentication-admission.md)).
- **Real isolation for builtin tools**: Docker-local and microsandbox-local
  providers behind a fail-closed selection boundary.
- **Credentialed sandbox egress + secrets at rest**: default-deny network
  policy per environment, an envelope-encrypted secrets store, and boundary
  credential injection — sandboxed agents reach allowlisted hosts with
  secrets they can never read
  ([ADR 0016](docs/adrs/0016-egress-proxy-and-secret-injection.md)).
- **MCP servers with vault-backed auth**: sessions connect to MCP servers
  behind `OMA_ENABLE_MCP` — SSRF-guarded, `always_ask` by default. Credentials
  live in `/v1/vaults` (`static_bearer` and `mcp_oauth`); OAuth tokens refresh
  themselves (lazy on use, a proactive in-process ticker, and a 401-driven
  retry) and rotate warm connections without reconnecting. Access tokens,
  refresh tokens, and client secrets are injected control-plane-side and
  leak-swept out of tool results and events — the same "usable but never
  readable" boundary the sandbox egress applies, now on the auth leg
  ([plan 0122](docs/plans/0122-mcp-connector.md)).
- **An admin API and a bundled operator console**, served by the appliance at
  `/console`: browse agents, sessions, events, spans, files, and vaults with a
  workspace key, and validate an `mcp_oauth` credential in place; create
  workspaces, mint/revoke API keys, and inspect per-credential refresh health
  with the admin key ([plan 0119](docs/plans/0119-admin-api.md),
  [plan 0120](docs/plans/0120-dashboard.md),
  [plan 0125](docs/plans/0125-console-vaults-mcp.md)). Fully self-contained —
  no CDN at first paint; browser keys live in page memory only.
- **Custom skills execution**: upload/version private skill bundles, attach
  them to agents, snapshot concrete content at session creation, advertise the
  skill through Pi, and read or execute its root-owned files inside the Docker
  sandbox under `/workspace/skills`. Session snapshots remain reproducible
  after source deletion; the live exit smoke covers model discovery, `read`,
  `bash`, leak checks, tamper resistance, and cleanup
  ([plan 0126](docs/plans/0126-skills-execution.md)).

- **Observability.** `GET /health` (liveness + readiness, compose
  healthcheck), fail-closed Prometheus `/metrics`, and structured JSON logs
  with programmatically enforced secret redaction
  ([plan 0121](docs/plans/0121-observability.md)).

What's still missing — the
[appliance product roadmap](docs/plans/0114-appliance-product-roadmap.md) is
the authoritative sequencing:

- session usage metering (`usage` is `null`);
- agent versioning, broader event-topology parity, file-upload idempotency,
  remote sandbox providers, RBAC within a workspace, and CI.

## Architecture

OMA keeps the **harness** separate from **compute**.

The harness is the trusted control plane: API requests, session state, event
history, model/runtime orchestration, custom-tool correlation, approvals, and
recovery state.

Compute is the sandbox execution plane: shell commands, filesystem changes,
packages, and generated artifacts.

That split lets applications keep secrets, auth, billing, audit logs, and
human review outside the untrusted coding sandbox.

## Compatibility

The north star is Claude Managed Agents wire compatibility: same endpoint
family, Anthropic-shaped error envelopes, persisted session event stream, SSE
replay and reconnect behavior, public custom-tool use/result events. Details
and intentional deviations:
[ADR 0004](docs/adrs/0004-managed-agents-rest-sse-surface-as-north-star.md).

## Stack

| Layer | Current choice |
| --- | --- |
| Control plane | TypeScript + Hono |
| Runtime engine | Pi Agent SDK |
| Persistence | SQLite (single-node appliance); Postgres is the scale-out target behind existing store interfaces |
| Sandbox providers | Docker-local and microsandbox-local, fail-closed selection |

The default sandbox guest is an OMA-owned, multi-architecture image pinned by
immutable digest. It is intentionally small (about 6.5 MiB compressed per
platform) and currently contains Bash plus ripgrep; Python/Node-rich images are
a later alpha usability slice.

## Development

```bash
npm install
npm run typecheck
npm test
```

Common tasks are also available through thin Make targets (`make check`,
`make ui`, `make server`, `make parallel-docker-smoke`); see
[Development and deployment setup](docs/dev-deployment.md).

Deeper docs:

- [Docs index](docs/index.md) — every plan, ADR, and reference note
- [Appliance product roadmap](docs/plans/0114-appliance-product-roadmap.md)
- [First Docker-local run](docs/tutorials/docker-local-first-run.md)
- [Examples](docs/examples.md)
- [Architecture](docs/architecture.md) · [Scope](docs/scope.md) · [ADRs](docs/adrs/)

## License

[Elastic License 2.0](LICENSE): free to use, copy, modify, and distribute —
personally or inside your company — with one main limitation: you may not
offer OMA itself to third parties as a hosted or managed service.
