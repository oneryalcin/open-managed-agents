# 0107 Sandbox Provider Contract Audit

Date: 2026-06-11

This audit pins the provider contract OMA should design against before adding
another sandbox backend. It is not an implementation plan for a specific
provider.

## Why This Exists

The current `SandboxProvider` is intentionally Pi-operations-shaped:

- `bash`, `read`, `write`, `edit`, `find`, and `ls`;
- optional `materializeFileResources`;
- optional `collectOutputFiles`;
- `dispose`;
- invocation counters and tool definitions.

That was the right first cut for Docker-local tool delegation, but the provider
landscape probes exposed behavior the current interface does not name:

- Docker Sandboxes requires Docker account authentication before use.
- Docker Sandboxes preserved sandbox-local state across stop/resume in the
  smoke probe.
- microsandbox did not preserve `/tmp` across stop/start because `/tmp` is an
  explicit tmpfs mount; a follow-up verification showed rootfs overlay state
  under `/root` does survive. A named volume mounted at `/data` also survived.
- microsandbox exposes explicit stop/start, detached reconnect, volumes,
  snapshots, streaming exec handles, metrics, network policies, and secret
  APIs.

The portable OMA invariant should be:

```text
session workspace = explicit durable mount, volume, or disk
sandbox rootfs = disposable implementation detail
```

Do not let a provider's rootfs persistence become part of the implicit OMA
contract. Even when rootfs overlay state happens to survive, durability can vary
by path inside one sandbox because providers may mount tmpfs, volumes, disks, or
snapshots at different locations.

## Current Interface

Current source: `src/control-plane/sessions/pi/sandbox/provider.ts`.

```ts
export interface SandboxProvider {
  readonly cwd: string;
  readonly operations: SandboxOperations;
  readonly tools: ToolDefinition<any, any, any>[];
  readonly toolNames: ReadonlySet<SandboxedBuiltinToolName>;
  readonly invocations: SandboxInvocationStats;
  materializeFileResources?(
    mounts: readonly RuntimeSessionFileMount[],
  ): Promise<void> | void;
  collectOutputFiles?(): Promise<readonly SandboxOutputFile[]>;
  dispose(): void;
}
```

That interface answers "can Pi built-in tools run somewhere other than the
host?" It does not answer "can OMA park, resume, audit, clean, and operate a
session workspace portably?"

## Provider-Neutral Contract Vocabulary

These concepts should be named before a second production provider lands.

### Identity and Posture

```ts
type SandboxProviderKind =
  | "host-passthrough"
  | "docker-local"
  | "docker-sandboxes"
  | "microsandbox"
  | "kubernetes"
  | "hosted";

interface SandboxProviderPosture {
  kind: SandboxProviderKind;
  isolation: "none" | "process-policy" | "container" | "microvm" | "kubernetes";
  selfHosted: boolean;
  requiresAccount: boolean;
  supportsOfflineUse: boolean;
  licenseNotes?: string;
}
```

This keeps account/licensing/offline behavior in the decision, not buried in
install notes.

### Session Workspace

```ts
interface SandboxWorkspaceSpec {
  mountPath: string;
  persistence:
    | { kind: "tmpfs"; survivesPark: false }
    | { kind: "volume"; name: string; survivesPark: true }
    | { kind: "disk"; pathOrId: string; survivesPark: true }
    | { kind: "snapshot"; baseId: string; survivesPark: true };
}
```

OMA should require a durable workspace for sessions that can pause for custom
tools or tool confirmations. Providers may implement that as a Docker container
filesystem, a named volume, a disk image, a Kubernetes PVC, or a remote snapshot,
but the provider must declare the persistence primitive.

### Lifecycle

```ts
interface SandboxLifecycle {
  create(input: SandboxCreateInput): Promise<SandboxHandle>;
  connect(id: SandboxId): Promise<SandboxHandle>;
  park(id: SandboxId, reason: "requires_action" | "idle"): Promise<void>;
  resume(id: SandboxId): Promise<SandboxHandle>;
  interrupt(id: SandboxId, reason: string): Promise<void>;
  destroy(id: SandboxId): Promise<void>;
}
```

`park` and `resume` are OMA verbs. A provider can map them to stop/start,
suspend/resume, snapshot/recreate, or no-op, but the implementation must state
whether workspace state survives and whether running processes survive.

### Execution

```ts
interface SandboxExec {
  exec(input: SandboxExecInput): Promise<SandboxExecResult>;
  stream(input: SandboxExecInput): Promise<SandboxExecStream>;
  signal(execId: string, signal: "term" | "kill" | "interrupt"): Promise<void>;
}
```

The stream contract needs:

- ordered stdout/stderr chunks;
- a terminal exit event;
- cancellation that stops the guest process, not just the local client;
- timeout semantics;
- cleanup semantics for abandoned handles.

### Files and Outputs

```ts
interface SandboxFiles {
  copyIn(files: readonly SandboxInputFile[]): Promise<void>;
  copyOut(spec: SandboxOutputSpec): Promise<readonly SandboxOutputFile[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  list(path: string): Promise<readonly SandboxFileEntry[]>;
}
```

This is the provider-level version of today's `materializeFileResources` and
`collectOutputFiles`. It should be explicit that input resources and output
collection operate through the durable workspace unless a provider documents a
separate uploads/outputs mount.

### Network and Secrets

```ts
interface SandboxNetworkPolicy {
  defaultEgress: "deny" | "public-only" | "allow";
  allowedDomains?: readonly string[];
  deniedDomains?: readonly string[];
  allowPrivateNetwork?: boolean;
  allowHostNetwork?: boolean;
}

interface SandboxSecretGrant {
  name: string;
  delivery: "env-placeholder" | "header-proxy" | "query-proxy";
  allowedHosts: readonly string[];
  entersGuest: boolean;
}
```

OMA should not assume Docker-local's current `--network none` is universal.
microsandbox's documented/default posture is public-only egress, and Docker
Sandboxes has kit/network policy concepts. The OMA contract should choose an OMA
default and force providers to implement or reject it explicitly.

### Observability and Cleanup

```ts
interface SandboxObservability {
  metrics?(): Promise<SandboxMetrics>;
  logs?(cursor?: string): AsyncIterable<SandboxLogEntry>;
  auditEvents?(): AsyncIterable<SandboxAuditEvent>;
}

interface SandboxCleanup {
  destroy(id: SandboxId): Promise<void>;
  reapOwnedResources(owner: SandboxOwner): Promise<SandboxReapReport>;
  listOwnedResources(owner: SandboxOwner): Promise<readonly SandboxResourceRef[]>;
}
```

Cleanup must include sandboxes, volumes/disks, snapshots, ports, copied files,
and provider-side metadata. It must be callable after partial failures.

## Provider Matrix After Probes

| Provider | Best Fit | Main Constraint |
| --- | --- | --- |
| host-passthrough | local unsafe debugging | no isolation; best-effort path containment only |
| docker-local | current developer/single-node provider | Docker daemon privilege; no durable multi-node story |
| Docker Sandboxes | strong local developer microVM candidate | Docker account/licensing/offline dependency before use |
| microsandbox | strongest self-hosted no-Kubernetes candidate | beta runtime; workspace persistence must use explicit volume/disk |
| Kubernetes + RuntimeClass | production self-hosted control plane | operational weight; contract needs claim/exec/cleanup design |
| hosted providers | managed SaaS escape hatch | lock-in, price while parked, self-host migration story |

## Audit Conclusions

1. Keep the existing `SandboxProvider` for current Pi operation delegation.
2. Do not bolt stop/start/snapshot onto it as optional duck-typed methods.
3. Introduce a second, explicit provider contract only when implementing the
   next backend.
4. Make durable workspace persistence mandatory for pause/resume-capable
   providers.
5. Treat provider posture as part of the contract: account dependency,
   licensing, offline/headless behavior, isolation class, and cleanup ownership.
6. Default network policy should be an OMA decision, not inherited from the
   provider. Current Docker-local is deny-all; microsandbox default is
   public-only.
7. Secret proxy behavior needs its own acceptance tests before any provider is
   allowed to carry production credentials.

## Microsandbox Production-Behavior Probe Result

Follow-up probe `scratch/0108-microsandbox-production-behavior-probe.md`
verified the remaining production-shaped behavior for microsandbox 0.5.6:

- snapshot creation and `fromSnapshot(...)` restore work for stopped sandboxes;
- named volumes remain the simpler durable workspace primitive for normal
  parking;
- port publishing from guest to host works and host ports close after cleanup;
- metrics and logs/log streams expose usable data shapes;
- controlled private/LAN target behavior matches the network posture: default
  and `NetworkPolicy.none()` could not reach the host LAN target, while
  `NetworkPolicy.allowAll()` could;
- secret grants keep the real secret out of the guest and expose a placeholder,
  but placeholder substitution against a controlled local HTTPS echo target did
  not pass.

## Remaining Verification Target

Before production provider implementation, finish the remaining secret probe:

- secret placeholder substitution with a controlled HTTPS echo target;

The latest attempt showed the guest received only the placeholder and not the
real secret, but the controlled HTTPS echo server also received the placeholder.
TLS interception on a self-signed high-port local server failed before the echo
request reached the server. Treat microsandbox secrets as unverified for OMA
until a provider-recommended or production-equivalent HTTPS echo test proves
substitution end to end.
