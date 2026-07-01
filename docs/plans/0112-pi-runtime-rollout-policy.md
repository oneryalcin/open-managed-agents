# 0112 Pi Runtime Rollout Policy

Date: 2026-07-01

Issue: #16

## Purpose

Define when OMA may run the Pi-backed session runtime outside local development
and demos.

Validated runtime wiring is not the same as production rollout. The deployment
app can drive Pi today, but exposing that path to real users requires an
explicit deployment-mode decision and reversible operator configuration.

## Current Runtime Modes

### Dark Runtime

Use `createControlPlaneApp(...)` without a `runtime` service.

Behavior:

- REST/SSE transport and event persistence work.
- `user.message` events are stored, but no Pi `AgentSession` is started.
- This is the right shape for API/event-log development and wire tests that must
  not call models or launch sandboxes.

### Deployment Runtime

Use `createDeploymentControlPlaneApp(...)`.

Behavior:

- The deployment app wires `PiSessionRunner`, `translatePiEvent`, runtime turn
  ownership, output collection, and recovery.
- `OMA_SANDBOX_PROVIDER` controls the builtin-tool execution provider only. It
  is not a global runtime-enable flag.
- Missing `OMA_SANDBOX_PROVIDER` or explicit `OMA_SANDBOX_PROVIDER=none` means
  no builtin sandbox provider. Agents that expose Pi builtins fail closed at
  runtime/session construction instead of falling back to host execution.
- `docker-local` and `microsandbox-local` are disabled unless both the provider
  is selected and the matching deployment allow flag is true:
  `OMA_ALLOW_DOCKER_LOCAL=true` or `OMA_ALLOW_MICROSANDBOX_LOCAL=true`.
- `host-passthrough` is trusted-local only and requires the existing unsafe
  double gate. It is not a production rollout option.

## Rollout Policy

### Local Development

Allowed.

Use the Make targets and explicit env vars already documented in
`docs/dev-deployment.md`. Local development may use in-memory stores and
Docker-local or microsandbox-local when the operator explicitly enables the
provider.

### Single-Node Demo

Allowed for trusted demos.

Conditions:

- one OMA process;
- trusted operator and trusted users;
- explicit sandbox provider selection for builtin tools;
- no claim of restart durability when using in-memory stores;
- no multi-tenant or untrusted-user language in docs or release notes.

### Single-Node Durable

Allowed as the first self-hosted runtime rollout target.

Required gates before describing this as durable:

- shared file-backed deployment storage is configured, with object root pairing;
- runtime event, session-output, and session-delete coordinators are in use;
- idempotency for `events.send` and `sessions.create` is enabled through the
  shared request-idempotency ledger;
- pending custom-tool/tool-confirmation recovery behavior is documented and
  tested;
- a sandbox provider is explicitly selected and allowed by deployment config;
- provider cleanup/reaping is enabled with an operator-chosen TTL;
- the deployment has an operator-visible rollback plan: set
  `OMA_SANDBOX_PROVIDER=none` or remove the provider selection, restart the
  process, and reject builtin-tool sessions instead of executing them.

This mode is still single-process. It does not promise high availability,
multi-process worker coordination, or live compute continuation after process
death.

### Multi-Worker or Managed SaaS Production

Not allowed yet.

Do not enable Pi runtime workers across multiple API/runtime processes until:

- Postgres/async metadata-store design exists for the runtime ownership
  boundary;
- runtime event commits, output commits, session lifecycle, and pending-call
  recovery are enforced through durable cross-process transactions;
- workspace authentication exists;
- admission limits are tied to authenticated workspace identity;
- operational telemetry exists for runtime turns, pending waits, sandbox
  lifecycle, provider errors, and reaper activity;
- a threat model update covers tenant isolation, egress, secret handling, logs,
  and incident response.

SQLite scaling work can prove single-node capacity. It is not a managed-SaaS
production gate by itself.

## Required Gates by Issue Area

| Gate | Current status | Rollout impact |
| --- | --- | --- |
| Request idempotency | Done for `events.send` and `sessions.create`. | Required for any runtime mode exposed to client retries. |
| Pending-call recovery | Implemented for custom tools and tool confirmations; #113 audited coordinator seams. | Required before single-node durable rollout. |
| Sandbox isolation | Docker-local and microsandbox-local are deployment-gated; microsandbox-local live smoke passed on real `msb` 0.6.1. | Required for builtin-tool agents with untrusted prompts. |
| Timeout/TTL defaults | Runtime idle TTL defaults to 15 minutes; sandbox operation timeout defaults are provider-specific and configurable. | Acceptable for local/demo; durable rollout should record chosen values in deployment runbook. |
| Cleanup/reaping | Docker-local and microsandbox-local have owned-resource cleanup/reap paths. | Required for long-running single-node deployments. |
| Operational observability | Not sufficient for production. Logs exist, but no metrics/alerts/SLOs. | Blocks multi-worker/managed production. |
| Admission control | Not sufficient for production. No authenticated workspace quotas. | Blocks multi-tenant production and managed-SaaS rollout. |
| Threat model | Stub exists; not complete. | Blocks untrusted multi-tenant deployment. |

## Operator Configuration Policy

For local/demo builtin execution:

```bash
OMA_SANDBOX_PROVIDER=docker-local
OMA_ALLOW_DOCKER_LOCAL=true
```

or:

```bash
OMA_SANDBOX_PROVIDER=microsandbox-local
OMA_ALLOW_MICROSANDBOX_LOCAL=true
```

For no builtin execution provider:

```bash
OMA_SANDBOX_PROVIDER=none
```

Do not use `host-passthrough` outside trusted local testing.

Do not introduce per-agent, per-session, or prompt-controlled provider
selection without a new authenticated policy boundary. Provider selection is an
operator deployment decision in the current product shape.

## Stop and Rollback Conditions

An operator should disable builtin runtime execution and investigate if any of
these happen:

- sandbox provider creation or cleanup fails repeatedly;
- stale resource reaping finds resources older than the expected TTL;
- runtime ownership loss appears outside restart/failover windows;
- pending custom-tool or tool-confirmation waits accumulate without recovery;
- event append, idempotency, or session-output coordinator errors appear;
- sandbox egress or secret-isolation smoke checks fail after a provider upgrade.

Rollback action for the current single-process deployment shape:

1. stop accepting new runtime work at the ingress/operator layer;
2. set `OMA_SANDBOX_PROVIDER=none` or remove the provider selection;
3. restart the OMA process;
4. leave existing persisted event history intact;
5. decide whether active/pending turns should be terminalized or replayed based
   on the incident class.

## Conclusion

The Pi runtime is allowed for local development and trusted single-node demos
today. It may be described as single-node durable only when the deployment uses
the shared durable store and explicit sandbox provider gates.

It is not yet approved for multi-worker or managed-SaaS production. The next
production-grade work is operational: admission limits, telemetry, auth-bound
workspace identity, and the Postgres/async coordination boundary.
