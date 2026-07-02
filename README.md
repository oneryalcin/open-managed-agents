# Open Managed Agents

**Open Managed Agents** is an open-source, self-hostable implementation of the
Claude Managed Agents API surface.

The goal is wire compatibility with Anthropic's hosted Managed Agents: clients
that speak the Claude Managed Agents REST + SSE protocol should be able to point
at this server with a base-URL change, while you keep execution, data, and
sandboxes on infrastructure you control.

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

The first boot initializes durable storage (default `~/.oma`, `/data` in the
container) and prints your initial workspace API key once. Point any Anthropic
SDK client at `http://127.0.0.1:4180` with that `x-api-key`. Details, overrides,
and key provisioning: [Development and deployment setup](docs/dev-deployment.md).

## Why This Exists

Managed Agents are useful because they give agents a durable place to work:
sessions, event history, streaming updates, custom tools, and sandboxed
filesystem/shell execution. The hosted version is convenient, but some teams
need the same API shape with their own runtime, data boundary, sandbox policy,
or deployment environment.

Open Managed Agents aims to be that control plane:

- Claude Managed Agents-compatible REST and SSE endpoints;
- persisted agents, environments, sessions, and events;
- resumable event streams;
- server-side custom tools that keep secrets outside the sandbox;
- pluggable sandbox providers for model-directed shell and file work.

## Current Status

A working single-node appliance: durable, authenticated, multi-tenant on one
node, with proven sandboxed execution. Not yet a full Anthropic Managed
Agents-compatible beta.

Working today:

- one-command appliance boot with first-boot API-key minting
  ([plan 0115](docs/plans/0115-appliance-entrypoint.md));
- persisted agent, environment, session, and file APIs on durable single-node
  SQLite storage with crash-safe restart recovery;
- append-only session event log; event listing and SSE streaming with
  reconnect support;
- Pi runtime execution with public custom-tool pause/resume round trips,
  `user.tool_confirmation` allow/deny gating, and `user.interrupt`;
- request idempotency for `events.send` and `POST /v1/sessions`;
- `span.model_request_start` / `span.model_request_end` observability events
  with required `model_usage`;
- workspace authentication (`x-api-key`, hashed at rest, fail-closed
  `OMA_AUTH_MODE`) with per-workspace admission limits and a provisioning CLI
  ([plan 0113](docs/plans/0113-workspace-authentication-admission.md));
- file upload resources, Docker-local session file mounts, and session output
  file collection/indexing;
- sandbox providers behind a fail-closed selection boundary: Docker-local and
  microsandbox-local, plus a guarded local passthrough for development tests;
- browser-based Managed Agents Console for read-only inspection.

Still missing before claiming broad parity or production readiness (the
[appliance product roadmap](docs/plans/0114-appliance-product-roadmap.md) is
the authoritative sequencing):

- admin HTTP API and a read-write console (Arc B);
- operational observability: health endpoint, metrics, SLOs (Arc C);
- session usage metering (`usage` is still `null`) (Arc D);
- sandbox network egress, skills and MCP execution (wire-accepted today but
  runtime-inert), and boundary secret injection
  ([buy-vs-build survey](docs/references/egress-secrets-buy-vs-build.md));
- agent update/versioning, broader event-topology parity, file-upload
  idempotency, managed remote sandbox providers;
- RBAC within a workspace, billing boundaries, npm publish, CI, and a real
  license.

## Architecture

Open Managed Agents keeps the **harness** separate from **compute**.

The harness is the trusted control plane: API requests, session state, event
history, model/runtime orchestration, custom-tool correlation, approvals, and
recovery state.

Compute is the sandbox execution plane: shell commands, filesystem changes,
packages, generated artifacts, and future provider-specific resources such as
volumes, ports, snapshots, and managed remote sandboxes.

That split lets applications keep secrets, auth, billing, audit logs, and human
review outside the untrusted coding sandbox.

## Compatibility

The north star is Claude Managed Agents wire compatibility:

- same endpoint family;
- Anthropic-shaped error envelopes;
- persisted session event stream;
- SSE replay and reconnect behavior;
- public custom-tool use/result events.

Details and intentional deviations are tracked in
[ADR 0004](docs/adrs/0004-managed-agents-rest-sse-surface-as-north-star.md).

## Stack

| Layer | Current choice |
| --- | --- |
| Control plane | TypeScript + Hono |
| Runtime engine | Pi Agent SDK |
| Persistence | SQLite for local/single-node; Postgres is the managed-SaaS target |
| First isolation provider | Docker-local |
| First managed remote target | Modal Sandboxes |

## Development

```bash
npm install
npm run typecheck
npm test
```

Common tasks are also available through thin Make targets:

```bash
make typecheck
make test
make ui
make server
make parallel-docker-smoke
```

`make ui` serves the browser-based Managed Agents Console against a local OMA
server for read-only inspection of sessions, events, spans, and output files.
`make server` runs the local CWC example server with Docker-local enabled.
`make parallel-docker-smoke` starts several Docker-local sandboxes concurrently
without calling a model, so it is the cheap check for the current local worker
shape. See [Development and deployment setup](docs/dev-deployment.md).

The detailed roadmap, architecture notes, and compatibility decisions live in
the docs:

- [Development and deployment setup](docs/dev-deployment.md)
- [Managed Agents Console](ui/managed-agents-console/README.md)
- [First Docker-local run](docs/tutorials/docker-local-first-run.md)
- [Examples](docs/examples.md)
- [CWC-style Streamlit Managed Agents example](examples/ship-your-first-managed-agent/README.md)
- [Roadmap](docs/roadmap.md)
- [Architecture](docs/architecture.md)
- [ADRs](docs/adrs/)
- [Scope](docs/scope.md)
- [References](docs/references.md)

## License

TBD.
