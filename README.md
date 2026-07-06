# Open Managed Agents

**Claude Managed Agents, self-hosted.**

Swap the `base_url` in your Anthropic SDK and your agents run here instead:
same API, same event stream, same sandboxed execution — but the sessions,
files, and sandboxes live on your machines, under your policies.

## Quickstart

From a checkout (Node ≥ 22.19):

```bash
npm install
node bin/open-managed-agents.mjs
```

or with Docker:

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
    name="dev", config={"type": "cloud", "networking": {"type": "unrestricted"}}
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
- **An admin API and a bundled operator console**, served by the appliance at
  `/console`: browse agents, sessions, events, spans, and files with a
  workspace key; create workspaces and mint/revoke API keys with the admin
  key ([plan 0119](docs/plans/0119-admin-api.md),
  [plan 0120](docs/plans/0120-dashboard.md)). Fully self-contained — no CDN
  at first paint; browser keys live in page memory only.

What's still missing — the
[appliance product roadmap](docs/plans/0114-appliance-product-roadmap.md) is
the authoritative sequencing:

- health/metrics observability and session usage metering (`usage` is `null`);
- skills and MCP execution (both wire-accepted today but runtime-inert; now
  unblocked by the egress + secrets boundary);
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
