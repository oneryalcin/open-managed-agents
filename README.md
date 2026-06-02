# Open Managed Agents

**Open Managed Agents** is an open-source, self-hostable implementation of the
Claude Managed Agents API surface.

The goal is wire compatibility with Anthropic's hosted Managed Agents: clients
that speak the Claude Managed Agents REST + SSE protocol should be able to point
at this server with a base-URL change, while you keep execution, data, and
sandboxes on infrastructure you control.

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

This project is still early. It is now a working MVP control plane with proven
Docker-local sandbox execution, but it is not yet a full Anthropic Managed
Agents-compatible beta.

Working today:

- persisted agent, environment, and session APIs;
- append-only session event log;
- event listing and SSE streaming with reconnect support;
- explicit Pi runtime wiring for agent execution;
- public custom-tool pause/resume round trips;
- `user.interrupt` aborts active Pi turns without disposing reusable sessions;
- file upload resources and Docker-local session file mounts;
- guarded local passthrough provider for development tests;
- Docker-local sandbox provider as the first real isolation provider;
- fail-closed provider selection;
- trusted deployment config for enabling Docker-local;
- live proof that a served session can execute `bash` inside Docker and record
  the expected `agent.tool_use` / `agent.tool_result` events.

Still missing before claiming broad Anthropic Managed Agents parity:

- archive-running-session parity;
- permission/evaluated tool confirmations;
- durable recovery for pending custom-tool waits;
- request-level idempotency;
- agent update/versioning;
- span/model request events;
- managed remote sandbox providers such as Modal;
- production auth, RBAC, tenancy, and billing boundaries;
- CI and a real license.

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
| Persistence | SQLite now, Postgres later |
| First isolation provider | Docker-local |
| First managed remote target | Modal Sandboxes |

## Development

```bash
npm install
npm run typecheck
npm test
```

The detailed roadmap, architecture notes, and compatibility decisions live in
the docs:

- [First Docker-local run](docs/tutorials/docker-local-first-run.md)
- [Examples](docs/examples.md)
- [Roadmap](docs/roadmap.md)
- [Architecture](docs/architecture.md)
- [ADRs](docs/adrs/)
- [Scope](docs/scope.md)
- [References](docs/references.md)

## License

TBD.
