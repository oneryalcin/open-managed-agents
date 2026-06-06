# Development and deployment setup

This document is the practical entry point for running OMA locally and for
thinking about how the current runtime shape should become a real deployment.
It is deliberately boring: the Make targets are thin wrappers around the
commands already used in the repo.

## Deployment modes

Use these labels consistently in docs, issues, and PRs:

| Mode | Status | Shape | What it is for |
| --- | --- | --- | --- |
| Local development | Current | Host-run OMA process, local Docker daemon, Docker-local sandbox containers. | Contributor development and smoke tests. |
| Single-node demo | Current | One OMA process with in-memory deployment stores and Docker-local sandboxes. | Local workshop parity and trusted demos. State is ephemeral. |
| Single-node durable | Intended next target | One OMA process with shared file-backed transactional storage, local object storage, and Docker-local sandboxes. | Self-hosted single-operator deployments that need restart persistence. |
| Multi-worker production | Future | API/control-plane service, durable metadata store, object storage, runtime worker pool, and remote or node-local sandbox providers. | Real scaling and multi-owner runtime execution. |

Do not describe the current server as "production" or "durable" until the
single-node durable storage work lands. The current owner/generation runtime
ledger is useful, but with the deployment app's current in-memory stores it is
not a cross-process coordination mechanism.

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
| `make ui` | Serve the read-only Managed Agents Console. |
| `make server` | Run the CWC example OMA server on `OMA_PROBE_PORT` (default `40178`). |
| `make docker-smoke` | Run the existing deterministic Docker-local deployment smoke. |
| `make parallel-docker-smoke` | Start multiple Docker-local sandboxes concurrently without calling a model. |
| `make cwc-smoke` | Run the Python SDK CWC happy-path smoke against the local server. |
| `make gated-smoke` | Run the Python SDK ask-gated builtin-tool smoke. |

`make server`, `make docker-smoke`, and `make parallel-docker-smoke` require a
working local Docker daemon. `make cwc-smoke` and `make gated-smoke` also need
the Python example environment and a reachable OMA server. The example `.env`
file lives at `examples/ship-your-first-managed-agent/.env.example`.

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

## Deployment target shape

The current MVP is suitable for local development and single-node demos.
Follow-up work is tracked in
[#103](https://github.com/oneryalcin/open-managed-agents/issues/103), with the
accepted plan in
[0103 - Deployment Hardening](plans/0103-deployment-hardening.md).

The next target is single-node durable:

1. **One control-plane process:** HTTP API, SSE, request validation, session
   state, event append/replay, custom-tool and confirmation orchestration.
2. **Shared file-backed transactional store:** agents, environments, sessions,
   event rows, file metadata, runtime ownership, and pending waits in one
   transaction-capable deployment boundary. This replaces the deployment app's
   current separate in-memory stores for durable mode.
3. **Local object storage:** uploaded files, internal snapshots, and session
   outputs.
4. **Docker-local sandbox provider:** one sandbox container per live session
   handle, with no Docker socket in the sandbox.

The future multi-worker target splits responsibilities further:

1. **Control plane:** HTTP API, SSE, request validation, session state, event
   append/replay, custom-tool and confirmation orchestration.
2. **Durable metadata store:** agents, environments, sessions, event rows, file
   metadata, runtime ownership, and pending waits. SQLite is fine for local
   single-node work; a multi-instance deployment needs a durable store with the
   same owner/generation fencing semantics.
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
