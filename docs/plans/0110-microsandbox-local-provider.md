# 0110 Microsandbox-Local Provider Plan

Date: 2026-06-26

## Purpose

Implement the first `microsandbox-local` provider slice for issue #121.

This is the first self-hosted, no-Kubernetes microVM backend for OMA. It should
prove that today's Pi built-in tool surface can run on microsandbox with the
same operational shape as Docker-local, while keeping the larger lifecycle
contract from [0107](0107-sandbox-provider-contract-audit.md) explicit.

## Current Evidence

Primary inputs:

- [0106 sandbox provider landscape](0106-sandbox-provider-landscape.md);
- [0107 sandbox provider contract audit](0107-sandbox-provider-contract-audit.md);
- `scratch/0106-microsandbox-probe.md`;
- `scratch/0107-microsandbox-behavior-probe.md`;
- `scratch/0108-microsandbox-production-behavior-probe.md`;
- `scratch/0109-microsandbox-secret-decisive-probe.md`;
- [agentOS/Osaurus prior art](../references/agentos-osaurus-prior-art.md).

Evidence already passed for `microsandbox@0.5.6`:

- create, exec, filesystem copy, stop/start, detached reconnect, and removal;
- named volumes survive stop/start and are the right normal workspace primitive;
- streamed exec output and command kill work;
- snapshots work, but should be fork/export/restore capability, not default
  session parking;
- metrics and log/log-stream shapes are usable;
- explicit `NetworkPolicy.none()` and `NetworkPolicy.allowAll()` behave as
  expected in controlled probes;
- cleanup can remove sandboxes and volumes if we track ownership.

Evidence that did not pass:

- proxy-grade secret substitution. Plain HTTP received placeholders unchanged;
  HTTPS interception failed before the controlled echo server saw the request.

Evidence still needed before coding:

- CLI parity for the operations this PR will depend on. Earlier probes used the
  TypeScript SDK heavily, but today's `SandboxProvider.dispose()` is synchronous.
  The implementation needs an `msb` command boundary, at minimum for teardown,
  and preferably for the whole provider so tests can fake it like Docker-local.

## Scope

Build `microsandbox-local` behind the existing `SandboxProvider` interface:

- `bash`;
- `read`;
- `write`;
- `edit`;
- `find`;
- `ls`;
- `materializeFileResources`;
- `collectOutputFiles`;
- `dispose`;
- invocation stats;
- CLI-backed microsandbox command adapter;
- deployment config parsing and provider selection;
- owned-resource cleanup/reaping;
- tests and one gated live smoke.

Use a branch such as:

```text
dev/microsandbox-local-provider
```

## Non-Goals

- No secret proxy support.
- No fallback from proxy-grade secrets to plaintext environment variables.
- No `env-plaintext` secret delivery unless a later explicit contract asks for
  it and audits it as `entersGuest: true`.
- No hosted microsandbox service abstraction.
- No Kubernetes abstraction.
- No snapshot parking as the default lifecycle.
- No broad rewrite of the Pi runner or the existing Docker provider.
- No new provider-neutral lifecycle interface in this PR.
- No async fire-and-forget cleanup in `dispose()`.

## Product Behavior

`microsandbox-local` gives OMA a stronger local/server isolation tier than
Docker-local without requiring Kubernetes:

- microVM-backed execution for untrusted bash/file operations;
- explicit durable session workspace mounted as a microsandbox volume;
- default-deny network policy controlled by OMA, not inherited from provider
  defaults;
- streamed bash output and cancellation that kills the guest process;
- file-resource input materialization and output collection parity with
  Docker-local;
- cleanup that knows about both sandbox and volume resources.

The user-visible API should not change. This is a deployment-selected backend:

```text
OMA_SANDBOX_PROVIDER=microsandbox-local
OMA_ALLOW_MICROSANDBOX_LOCAL=true
```

## Contract Decisions

### Workspace

Use an explicit named microsandbox volume for the session workspace.

```text
workspace path inside guest: /workspace
uploads path inside guest:   /mnt/session/uploads
outputs path inside guest:   /mnt/session/outputs
```

The provider must not rely on rootfs persistence. Even if rootfs overlay state
survives stop/start, OMA's contract is:

```text
session workspace = explicit durable volume
sandbox rootfs = disposable implementation detail
```

For this first slice, `dispose()` destroys the sandbox and the owned volume,
because today's `SandboxProvider` has only one terminal cleanup hook. The named
volume still matters because it proves the right workspace primitive and avoids
rootfs coupling. True `park/resume` wiring is a later lifecycle slice.

Volume names must include a uniqueness suffix, not only workspace/session IDs,
because retry and partial-failure paths can leave a same-session volume behind:

```text
oma-<workspace-id>-<session-id>-<purpose>-<time>-<random>
```

The provider records the chosen sandbox and volume names in memory and disposes
those exact resources. Reapers may use the OMA prefix, but creation should not
collide with an orphan.

### Network

Default policy is explicit deny.

The first provider should accept only:

```ts
networkPolicy: "none"
```

Do not inherit microsandbox defaults. Add `public-only` or allowlists only after
their product semantics are named in OMA config and tested separately.

### Secrets

There is no session secret-grant surface in the repo today. Do not add one just
to reject it.

For this PR, the concrete secret behavior is:

- `microsandbox-local` accepts no env allowlist;
- provider selection rejects unknown secret-like fields through the existing
  unknown-field parser behavior;
- deployment config rejects secret/env delivery knobs for microsandbox;
- no proxy-grade secret delivery is advertised.

When a future resource-grant/secret-grant surface exists, `microsandbox-local`
must reject proxy-grade grants before creating any sandbox or volume. The error
should mention issue #121 and the 0109 secret gate. That acceptance criterion
belongs to the slice that introduces the grant input, not to a fake v1 hook.

### Lifecycle

Do not bolt `park`, `resume`, `snapshot`, or `connect` onto
`SandboxProvider` as optional methods in this PR.

The first slice maps microsandbox to today's Pi operation contract. It may use
detached mode internally if that makes cleanup/reconnect safer, but OMA-visible
parking remains future work.

## Implementation Shape

### 1. Fresh CLI Confidence Probe

Before changing production code, re-run one small throwaway CLI probe against
the exact `msb`/microsandbox version to be used.

Check:

- CLI availability and version;
- create sandbox with explicit volume mounted at `/workspace`;
- run `pwd`, write/read a file, stream a command, kill a command;
- set explicit no-network policy;
- stop/remove sandbox and remove volume;
- remove a volume after its sandbox has already been removed;
- list enough resource metadata to reap owned stale sandboxes and orphaned
  volumes.

This should be a temporary command or one scratch file edited in place, then
deleted unless the evidence needs to be captured.

If the CLI cannot cover a required operation, pause and update this plan before
coding. An SDK fallback is acceptable only behind a small injectable adapter,
and teardown must still remain synchronous or the provider contract must change.

### 2. Add Config and Selection

Extend:

- `src/control-plane/deployment-runtime-config.ts`;
- `src/control-plane/sessions/pi/sandbox/selection.ts`.

New selection:

```ts
{
  type: "microsandbox-local";
  operationTimeoutMs?: number;
  reapStaleSandboxesOlderThanMs?: number;
}
```

New deployment env:

```text
OMA_SANDBOX_PROVIDER=microsandbox-local
OMA_ALLOW_MICROSANDBOX_LOCAL=true
OMA_MICROSANDBOX_REAP_STALE_SANDBOXES_OLDER_THAN_MS=<ms>
```

Reuse `OMA_SANDBOX_OPERATION_TIMEOUT_MS`.

Do not support `OMA_SANDBOX_ENV_ALLOWLIST` for `microsandbox-local` in v1. Env
allowlists are a plaintext secret footgun unless the contract says otherwise.

Reject Docker-only and host-passthrough-only env vars when microsandbox is
selected.

Concrete config wiring:

- add keys to `DEPLOYMENT_RUNTIME_ENV_KEYS`;
- add `allowMicrosandboxLocal` to resolver options;
- keep validation daemon-free: parsing/resolving config must not require
  microsandbox to be installed or running;
- update `rejectIgnoredResolverOptions` symmetrically for the new resolver
  option;
- change the current Docker-only rejection for
  `OMA_SANDBOX_OPERATION_TIMEOUT_MS` so it is valid for Docker-local and
  microsandbox-local, but still rejected for `none` and `host-passthrough`;
- reject `OMA_DOCKER_REAP_STALE_CONTAINERS_OLDER_THAN_MS` for microsandbox;
- reject `OMA_MICROSANDBOX_REAP_STALE_SANDBOXES_OLDER_THAN_MS` for providers
  other than microsandbox-local.

### 3. Add Provider Module

Add:

```text
src/control-plane/sessions/pi/sandbox/microsandbox.ts
```

Keep it parallel to `docker.ts`, but smaller.

Responsibilities:

- create sandbox and explicit workspace volume with stable OMA-owned names;
- expose `cwd = "/workspace"`;
- create Pi built-in tool definitions with `createSandboxToolDefinitions`;
- filter/ignore guest env explicitly;
- implement timeout and `AbortSignal` cancellation by killing the microsandbox
  exec handle;
- normalize provider cancellation/exit results so callers do not depend on raw
  microsandbox exit codes;
- materialize input file resources under the `/mnt/session/uploads` root,
  preserving each `RuntimeSessionFileMount.mountPath` relative to that root;
- collect output files under `/mnt/session/outputs` with the same count/size
  limits as Docker-local;
- track invocation stats with existing helpers;
- stop/remove sandbox and remove owned volume on dispose;
- keep logs/metrics out of the first implementation unless needed to debug the
  live smoke.

Use a command adapter with a test fake, like Docker-local's fake CLI strategy.
Prefer direct `msb` filesystem/exec commands if the CLI probe proves them. Use
guest shell only for operations that lack a safe CLI primitive, and keep path
handling centralized.

### 4. Path Rules

All Pi file operations must stay under `/workspace`.

Input and output roots are provider-owned paths:

- uploads: `/mnt/session/uploads`;
- outputs: `/mnt/session/outputs`.

`RuntimeSessionFileMount.mountPath` must be constrained beneath the uploads
root, matching the current Docker-local contract. It is not one fixed upload
file.

Use POSIX path normalization. Reject:

- relative escapes;
- absolute paths outside allowed roots;
- symlink-following behavior that would escape if the provider exposes raw host
  paths or guest paths outside the allowed roots;
- output files with unsafe relative names.

### 5. Cleanup and Reaping

Owned resource names should include an OMA prefix, workspace/session IDs, a
purpose, and a uniqueness suffix:

```text
oma-<workspace-id>-<session-id>-<purpose>-<time>-<random>
```

If microsandbox supports labels/metadata, use them. If not, use a stable prefix
and keep the parser conservative.

Cleanup must handle partial creation:

- volume created, sandbox create failed;
- sandbox created, file materialization failed;
- command killed or timed out;
- sandbox already stopped;
- sandbox already removed;
- sandbox removed, volume removal failed;
- orphaned same-session volume exists before creation.

`await using`/auto-dispose is not enough because probes showed it stops but does
not necessarily remove all owned resources. Use explicit remove paths.

Teardown must be synchronous because `SandboxProvider.dispose()` returns `void`.
Mirror Docker-local's `spawnSync(... rm ...)` pattern. Do not use async
fire-and-forget SDK cleanup for owned durable resources.

Reaping strategy:

- if microsandbox exposes reliable creation timestamps for sandboxes and
  volumes, support age-based stale reaping;
- if volumes do not expose timestamps, reap only orphaned OMA-prefixed volumes
  that are not attached to any live OMA sandbox, or leave volume reaping to an
  explicit manual cleanup command;
- never reap resources without the OMA prefix/metadata.

### 6. Observability

Do not build logs/metrics normalization in this PR unless the live smoke or
failure diagnostics require it. Metrics/logs remain a follow-up from 0107, not a
speculative abstraction inside this provider slice.

## Test Plan

### Unit Tests

Add or extend:

- `src/control-plane/sessions/pi/sandbox/__tests__/selection.test.ts`;
- `src/control-plane/__tests__/deployment-runtime-config.test.ts`;
- new fake-CLI provider tests for `microsandbox.ts`.

Cover:

- provider selection parse/resolve;
- disabled-by-default deployment gate;
- provider-specific env rejection;
- daemon-free config validation;
- `OMA_SANDBOX_ENV_ALLOWLIST` rejected for v1;
- secret-like unknown fields rejected by parser behavior, without adding a
  fake secret-grant input;
- pure command-builder tests for create, exec, copy/read/list, network-deny,
  kill, remove, and volume removal commands;
- path normalization and escape rejection;
- command timeout and abort call the exec kill path;
- output collection quotas and unsafe name rejection;
- dispose cleanup order after partial failures;
- sync teardown uses the remove commands and does not await SDK promises;
- stale-resource reaper filters only OMA-owned resources;
- volume-name uniqueness prevents same-session orphan collisions.

### Live Smoke

Add one gated smoke, skipped unless an env flag is set:

```text
OMA_MICROSANDBOX_LIVE=1
```

It should prove:

- create sandbox and explicit volume;
- write/read/list/find/ls under `/workspace`;
- streamed bash output;
- cancellation kills guest command;
- file-resource materialization;
- output collection;
- explicit no-network policy blocks egress;
- dispose removes sandbox and volume;
- final owned-resource list is clean.

### Repo Checks

Run:

```bash
npm run typecheck
npm test
```

Run the gated live smoke only on a host with microsandbox support.

## Acceptance Criteria

- `microsandbox-local` is unavailable unless deployment config explicitly
  enables it.
- Existing config/request surfaces expose no proxy-grade secret delivery for
  `microsandbox-local`.
- No plaintext env fallback exists.
- `OMA_SANDBOX_ENV_ALLOWLIST` is rejected for `microsandbox-local`.
- Network policy is explicit deny by default.
- Pi built-in tools work through microsandbox with Docker-local parity.
- File resources and output files work with existing session semantics and
  quotas.
- Abort and timeout stop the guest process.
- `dispose()` synchronously removes owned sandbox and volume resources.
- Cleanup removes owned sandbox and volume resources after success, failure, and
  partial creation.
- Tests cover config, command building, provider behavior, cleanup, and secret
  non-surface behavior.
- The live smoke leaves no owned microsandbox resources behind.

## Reservations

- Microsandbox is beta and this will put it on a runtime hot path. Keep it
  deployment-gated.
- The current `SandboxProvider` cannot model true `park/resume`. Do not hide
  that by adding optional lifecycle methods.
- The current `SandboxProvider.dispose()` is synchronous. If `msb` CLI cannot
  perform reliable teardown, do not continue with an async SDK-only provider
  without changing the contract.
- `NetworkPolicy.none()` passed probes, but network policy should be rechecked
  in the live smoke for every SDK/runtime upgrade.
- Secret proxy support remains excluded until upstream guidance or a
  production-equivalent HTTPS echo harness proves substitution end to end.
- Volume reaping depends on what metadata microsandbox exposes. If timestamps
  are missing, avoid pretending age-based cleanup is safe.
- Logs/metrics are useful, but there is no OMA-level observability contract yet.
  Keep them out of v1 unless debugging proves they are needed.

## Follow-Up Slices

1. Provider-neutral lifecycle contract: create/connect/park/resume/destroy.
2. Public/network allowlist policy once OMA names the product semantics.
3. Boundary secret proxy or egress-proxy design that keeps secrets out of the
   guest.
4. Snapshot/export/restore as an explicit feature, not default parking.
5. Kubernetes provider once the local microVM tier is proven.
