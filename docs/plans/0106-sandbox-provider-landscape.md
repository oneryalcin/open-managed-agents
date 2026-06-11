# 0106 - Sandbox Provider Landscape and First Probes

## Context

OMA already has a provider-shaped local sandbox boundary:

- `SandboxProvider` exposes `bash`, `read`, `write`, `edit`, `find`, and `ls`
  operations;
- file resources can be materialized into a session sandbox;
- generated session outputs can be collected from a live sandbox;
- providers own cleanup through `dispose()`.

The current `docker-local` provider creates one Docker container per session
handle with a read-only root filesystem, tmpfs workspace/uploads/outputs,
network disabled by default, memory/PID/CPU limits, uid/gid `65534:65534`, and
label-based reaping.

That is good enough for local development and demos. It is not the final answer
for production-ready sandboxing.

## OMA-Specific Requirements

Provider evaluation must account for OMA behavior, not just generic code
execution:

1. **Long-lived session identity.** A session can span multiple user turns.
   Recreating a one-shot sandbox per command is the wrong abstraction.
2. **Indefinite parking on `requires_action`.** Custom tools and tool
   confirmations can pause a session while waiting for user input. An
   always-running, always-billed sandbox per paused session is not a good
   production shape.
3. **Session file resources.** Uploaded resources must appear at stable paths
   before runtime work begins.
4. **Generated outputs.** Files under `/mnt/session/outputs` must be collected
   with size, count, path, and ownership guards.
5. **Interrupt/archive/delete cleanup.** Providers must make it cheap and
   reliable to interrupt running work and dispose abandoned sandboxes.
6. **Self-hostability.** OMA should not design only around hosted providers.
   Local, self-hosted, and hosted backends should share one logical contract.
7. **Credential and egress control.** Agents need package registries, Git, and
   APIs, but secrets should not be dropped into the sandbox when a proxy can
   inject them at the boundary.

## Evaluation Framework

Use the Agent Sandbox Taxonomy (AST) as the vocabulary for the audit rather
than inventing a new scoring language:

- L1 compute isolation;
- L2 resource limits;
- L3 filesystem boundary;
- L4 network boundary;
- L5 credential and secret management;
- L6 action governance;
- L7 observability and audit.

AST is explicitly marked work-in-progress and its product scores should not be
copied as truth. Its layer model is still useful for OMA because it separates
compute isolation from egress, credentials, governance, and audit.

References:

- [Agent Sandbox Taxonomy](https://github.com/kajogo777/the-agent-sandbox-taxonomy)
- [AST explorer](https://ast.georgebuilds.dev)

## Current Baseline

### Docker-local

Current OMA `docker-local` scores well on:

- L2: memory, CPU, PID, operation timeout, output limits;
- L3: read-only root, tmpfs workspace/uploads/outputs, non-root user;
- L4: `--network none` by default;
- L7: basic invocation stats and container labels.

It is weaker on:

- L1: standard containers share the host kernel;
- L5: no first-class credential proxy;
- L6: only OMA tool-permission gates, not provider-level action governance;
- pause/resume: container state is live or gone; no deep hibernation.

Near-term hardening still matters: rootless Docker support, reaper policy,
admission limits, and clearer Docker-socket posture remain useful even if a new
provider is added.

References:

- [Docker rootless mode](https://docs.docker.com/engine/security/rootless/)
- [Deployment hardening plan](0103-deployment-hardening.md)

## Detailed Candidate Findings

### Anthropic Sandbox Runtime (`sandbox-runtime`)

Repository: [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)

Verified on 2026-06-11:

- active, Apache-2.0, about 4.4k stars;
- TypeScript package published as `@anthropic-ai/sandbox-runtime`;
- README describes it as a beta research preview developed for Claude Code;
- macOS uses Seatbelt via `sandbox-exec`;
- Linux uses `bubblewrap`;
- Windows is not supported in the README's platform table;
- network is deny-by-default and mediated by host-side HTTP/SOCKS proxies;
- filesystem writes are allow-only by default;
- filesystem reads are deny-then-allow and are permissive unless callers deny
  broad regions such as `/Users`, `/home`, or sensitive paths;
- Unix sockets are blocked by default, with platform-specific caveats;
- it exposes a library API around `SandboxManager.initialize(...)` and
  `SandboxManager.wrapWithSandbox(...)`;
- it has explicit dangerous weakening switches:
  `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, and
  `allowAppleEvents`.

Good OMA fit:

- credible lean local policy layer for trusted developer machines;
- better than rolling our own raw `bubblewrap`/`nsjail` wrapper;
- useful for replacing or tightening `host-passthrough`;
- useful for wrapping local MCP/tool subprocesses where we want filesystem and
  network policy without a container;
- fits OMA's Anthropic-compatible posture.

Not a full OMA session provider:

- it wraps arbitrary host processes; it does not provide a private Linux
  workspace with image lifecycle, file materialization, output collection,
  hibernation, or per-session VM state;
- it is OS-level policy, not a hardware or hypervisor boundary;
- broad allowed network domains can still be exfiltration channels;
- Linux support depends on user namespaces, `bubblewrap`, `socat`, and
  distribution-specific security settings;
- macOS options for Go TLS and Apple Events can weaken or remove important
  isolation.

Recommendation:

Treat `sandbox-runtime` as the **lean local policy-wrapper candidate**, not the
main production sandbox provider. A good first probe is:

- add a local-only `sandbox-runtime` provider mode or wrapper spike around
  host-passthrough;
- verify `bash/read/write/find/ls` parity;
- verify network deny-by-default and workspace-only write policy;
- verify it cannot replace Docker-local for session file mounts and output
  collection without adding OMA-owned workspace conventions.

References:

- [Sandbox Runtime README](https://github.com/anthropic-experimental/sandbox-runtime)
- [Claude Code sandbox environments](https://code.claude.com/docs/en/sandbox-environments)
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Anthropic engineering post](https://www.anthropic.com/engineering/claude-code-sandboxing)

### Docker Sandboxes

References:

- [Docker Sandboxes docs](https://docs.docker.com/ai/sandboxes/)
- [Why MicroVMs: Docker Sandboxes architecture](https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/)
- [Docker Sandboxes kits](https://docs.docker.com/ai/sandboxes/customize/kits/)
- [Docker Sandboxes credentials](https://docs.docker.com/ai/sandboxes/security/credentials/)

Verified:

- official Docker docs describe `sbx` sandboxes for AI coding agents;
- each sandbox gets its own microVM, filesystem, network, and private Docker
  daemon;
- sandboxes can be stopped without deletion and later restarted;
- the `sbx` CLI requires Docker authentication before even `sbx ls` or sandbox
  creation works;
- `sbx rm` deletes sandbox state;
- kits can declare tools, files, environment, startup commands, network rules,
  and credential proxy behavior;
- Docker documents host-side credential injection patterns where real secrets
  do not enter the sandbox.

OMA fit:

- closest conceptual upgrade from current `docker-local`;
- agent can run Docker inside the sandbox without a host Docker socket mount;
- macOS/Windows developer story appears stronger than Linux-only gVisor;
- kit network and credential concepts map closely to OMA's future provider
  policy contract.

Caveats:

- several docs mark kits and custom secrets as experimental;
- the product is young and the CLI/API surface may change;
- provider automation details need a direct probe, not just docs;
- the Docker account dependency is a product-posture caveat, not just install
  friction. It may be acceptable for a local developer tier, but it is in
  tension with OMA's self-hostability goal unless licensing, offline/headless
  operation, and account requirements are explicitly accepted;
- Linux server support and headless deployment posture need verification before
  calling this a self-hosted production provider.

Recommendation:

Make Docker Sandboxes the first **local microVM provider probe**, but do not
commit to it as production substrate until a spike proves:

- programmatic create/start/exec/copy/read/remove flows;
- file resource materialization equivalent to current Docker tar flow;
- session output collection;
- stop/start behavior during `requires_action` parking;
- credential proxy and network policy behavior;
- availability on the target developer and server platforms.

### Microsandbox

Repository: [superradcompany/microsandbox](https://github.com/superradcompany/microsandbox)

Verified on 2026-06-11:

- active, Apache-2.0, about 6.5k stars;
- beta software;
- local microVMs for untrusted workloads;
- supports OCI images, named sandboxes, `exec`, filesystem APIs, metrics,
  volumes, network policy, secret injection, stop/start, detached mode, logs,
  and snapshots;
- SDKs exist for Rust, Python, TypeScript, and Go;
- requirements are Linux with KVM enabled or Apple Silicon macOS;
- docs say the SDK embeds the runtime directly, with no separate daemon.
- local TypeScript SDK probe passed create, exec, guest filesystem copy
  host-to-sandbox and sandbox-to-host, stop, start, and cleanup with no account
  dependency;
- rootfs state under `/tmp` did not survive stop/start, but a named volume
  mounted at `/data` did survive. OMA must model session workspace persistence
  as an explicit volume/disk, not implicit rootfs state.

OMA fit:

- strongest self-hosted no-Kubernetes middle tier found so far;
- closer to OMA's programmatic provider contract than Docker Sandboxes because
  SDKs expose lifecycle and exec primitives directly;
- stop/start, detached mode, metrics, logs, and snapshots are directly relevant
  to long-lived OMA sessions.
- no Docker account dependency was observed in the local SDK probe.

Caveats:

- beta;
- OMA would depend on a young runtime for core isolation;
- rootfs stop/start persistence is not enough for OMA; the provider contract
  must require an explicit session workspace volume or disk;
- we must still verify output streaming, network deny defaults, secret-proxy
  semantics, and failure cleanup.

Recommendation:

Microsandbox is now the strongest self-hosted no-Kubernetes candidate. The next
probe should focus on the remaining production-shaped gaps:

- output streaming and cancellation;
- network deny/default policy behavior;
- secret proxy semantics;
- failure cleanup after crashed execs or killed sandboxes;
- whether snapshots help more than named volumes for `requires_action`
  parking.

### Kubernetes `agent-sandbox`

Repository: [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)

Verified on 2026-06-11:

- active Kubernetes SIG project, Apache-2.0, about 2.8k stars;
- provides a `Sandbox` CRD and controller;
- targets isolated, stateful, singleton workloads, including AI agent
  runtimes;
- supports stable identity, persistent storage, lifecycle management, scheduled
  deletion, pausing and resuming;
- extensions include `SandboxTemplate`, `SandboxClaim`, and `SandboxWarmPool`;
- roadmap includes suspend/resume, full state suspension with PVC persistence,
  warm-pool rolling updates, identity propagation, and security controls;
- docs explicitly mention runtimes like gVisor and Kata Containers.

OMA fit:

- best self-hosted Kubernetes design target;
- maps to OMA's long-lived session identity better than hand-rolled raw pods;
- warm pools and suspend/resume line up with `requires_action` parking;
- Kubernetes `RuntimeClass` can still provide runc, gVisor, or Kata beneath it.

Caveats:

- it is still evolving;
- it is infrastructure substrate, not an OMA `SandboxProvider` implementation;
- OMA still needs an exec/file/output/control channel and worker ownership
  model above the CRD.

Recommendation:

For any K8s provider work, design against `agent-sandbox` plus RuntimeClass,
not raw one-off pods. The first K8s slice should be a design/probe, not
production code.

References:

- [agent-sandbox README](https://github.com/kubernetes-sigs/agent-sandbox)
- [Kubernetes RuntimeClass](https://kubernetes.io/docs/concepts/containers/runtime-class/)
- [Kubernetes user namespaces](https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/)
- [gVisor Kubernetes quick start](https://gvisor.dev/docs/user_guide/quick_start/kubernetes/)
- [Kata Containers](https://katacontainers.io/)

### Apple `container`

Repository: [apple/container](https://github.com/apple/container)

Verified on 2026-06-11:

- active Apple project, Apache-2.0, about 30k stars;
- creates and runs Linux containers using lightweight VMs on Apple Silicon.

OMA fit:

- promising macOS local isolation substrate;
- worth tracking for developer-local production-ish workflows.

Caveats:

- Apple Silicon specific;
- not enough evidence yet that it exposes the session lifecycle, exec,
  file-transfer, and cleanup controls OMA needs as cleanly as Docker
  Sandboxes or microsandbox.

Recommendation:

Track, but do not make it a first provider probe.

### Docker + gVisor

References:

- [gVisor Docker quick start](https://gvisor.dev/docs/user_guide/quick_start/docker/)
- [gVisor overview](https://gvisor.dev/docs/)

OMA fit:

- still the most boring Linux-server hardening flag if current Docker-local can
  run with `--runtime=runsc`;
- likely preserves most of the current `docker.ts` provider code.

Caveats:

- Linux-only;
- syscall compatibility and performance must be probed against Pi's tool usage;
- does not solve macOS local isolation.

Recommendation:

Keep as the first Linux Docker hardening probe, but no longer make it the
headline local sandbox strategy.

### Rootless Docker and Podman

References:

- [Docker rootless mode](https://docs.docker.com/engine/security/rootless/)
- [Podman](https://podman.io/)
- [Podman rootless tutorial](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md)

OMA fit:

- cheap local/self-host posture improvements;
- likely compatible with much of the existing Docker-local mental model.

Caveats:

- not a hardware boundary;
- Podman compatibility with our exact use of labels, `exec`, tar
  materialization, tmpfs mounts, cgroups, and cleanup must be probed.

Recommendation:

Treat as compatibility/hardening probes, not as the production isolation target.

## Hosted Provider Matrix

Hosted providers are valuable, but should not be the only production path.
Evaluate them primarily on pause/resume/snapshot, credential proxying, egress
policy, file transfer, lifecycle cleanup, and self-host escape hatch.

| Provider | Fit to Evaluate | Links |
| --- | --- | --- |
| E2B | Mature agent sandbox; Firecracker; open infra available; good hosted candidate. | [E2B](https://e2b.dev/docs), [repo](https://github.com/e2b-dev/E2B), [infra](https://github.com/e2b-dev/infra) |
| Daytona | Open-source AI code infra; self-hostable story matters. | [Daytona](https://www.daytona.io/), [repo](https://github.com/daytonaio/daytona) |
| Modal | Good if GPU/serverless functions matter; sandbox persistence limits need care. | [Modal sandboxes](https://modal.com/docs/guide/sandboxes) |
| Deno Sandbox | Cloud Linux microVMs with JS/Python SDKs. | [Deno Sandbox](https://docs.deno.com/sandbox/) |
| Cloudflare Sandboxes | Persistent isolated Linux environments; `exec`, file, background process, preview, snapshot, credential proxy ideas. | [Docs](https://developers.cloudflare.com/sandbox/), [GA post](https://blog.cloudflare.com/sandbox-ga/), [SDK](https://github.com/cloudflare/sandbox-sdk) |
| Vercel Sandbox | Firecracker microVMs for untrusted code; likely more ephemeral than OMA sessions by default. | [Docs](https://vercel.com/docs/sandbox), [repo](https://github.com/vercel/sandbox) |
| Fly.io Sprites | Stateful hardware-isolated sandboxes with checkpoint/restore. | [Sprites](https://sprites.dev/), [Fly intro](https://fly.io/learn/agent-sandbox/) |
| CodeSandbox SDK | Strong snapshot/fork story; useful if OMA wants branch/fork workflows later. | [CodeSandbox](https://codesandbox.io/), [SDK](https://github.com/codesandbox/codesandbox-sdk) |
| Blaxel, Morph, Runloop, Northflank | Potential hosted options; verify from primary docs before weighting. | [Blaxel](https://blaxel.ai/), [Morph](https://morph.so/), [Runloop](https://runloop.ai/), [Northflank](https://northflank.com/) |

Vendor comparison posts can inform discovery, but should not be treated as
evidence for exact pricing, cold-start, or isolation claims.

## Adjacent But Not Mainline

- `judge0` / `piston`: snippet execution engines, not long-lived session
  workspaces.
- WebContainers: browser-side runtime, not server-side untrusted Linux
  sandboxing for OMA.
- Jupyter Kernel Gateway: kernel gateway, not a sandbox boundary.
- Slurm + Enroot/Pyxis: useful for HPC/GPU clusters, not general OMA
  production.
- Direct Firecracker / Cloud Hypervisor: too much substrate for OMA to own
  first. Consume through Kata, microsandbox, E2B infra, or hosted providers
  unless sandbox infrastructure becomes the product.
- Raw `bubblewrap` / `nsjail`: useful primitives, but `sandbox-runtime`
  packages this tier better for our purposes.

## Recommended Sequence

### 1. Do Not Implement a Provider Yet

First, pin the provider contract we actually need:

- `create`;
- `exec` with streaming output and cancellation;
- `read/write/list` files;
- materialize session file resources;
- collect session outputs;
- interrupt running commands;
- dispose hard;
- optional stop/start or suspend/resume;
- optional snapshot/fork;
- network policy;
- credential proxy;
- metrics/logs/audit;
- cleanup/reaper semantics.

The current `SandboxProvider` is close but does not name stop/start,
suspend/resume, snapshot, credential proxy, or observability.

### 2. First Local Probes

Run small probes in this order:

1. `sandbox-runtime` as a local policy wrapper around host-passthrough or tool
   subprocesses.
2. Docker Sandboxes as the first local microVM provider candidate.
3. Docker+gVisor as the Linux Docker hardening flag.
4. microsandbox as the self-hosted no-K8s microVM candidate.
5. Podman rootless as a compatibility/posture probe.

Each probe should produce a short evidence file:

- commands run;
- platform;
- install friction;
- account, licensing, and offline/headless dependencies;
- provider-contract coverage;
- failure modes;
- cleanup behavior;
- whether it can park a session cheaply.

### 3. K8s Design Target

For Kubernetes, design against `kubernetes-sigs/agent-sandbox` and
`RuntimeClass`, not raw pods.

The K8s design should answer:

- does OMA create `Sandbox`, `SandboxClaim`, or both?
- how does the worker execute commands inside the sandbox?
- how are uploads materialized and outputs collected?
- how is `requires_action` parking represented?
- when does a sandbox suspend, resume, or delete?
- which runtime classes are supported first: runc, gVisor, Kata?

### 4. Hosted Provider Matrix

Keep hosted provider research in the same framework, but do not let hosted-only
features distort the self-hosted contract.

Hosted providers should be compared on:

- pause/resume/snapshot;
- price while parked;
- egress and credential proxying;
- file transfer and output collection;
- command streaming and cancellation;
- logs/metrics;
- self-host option or migration path;
- lock-in risk.

## First Concrete Follow-Up

Create a new issue for "Sandbox provider contract audit and first probes" and
link this plan from it. The first implementation PR should not add a new
provider; it should either:

1. add the missing optional provider-contract concepts as types/docs only; or
2. add one scratch probe for `sandbox-runtime` or Docker Sandboxes with no
   production wiring.

## Open Questions

- Should `suspend/resume` be a first-class provider method, or a higher-level
  runtime-worker policy over provider-specific stop/start/snapshot primitives?
- Is Docker Sandboxes usable headlessly and programmatically enough for OMA, or
  is it primarily an interactive CLI product today?
- Does Docker Sandboxes' Docker-account dependency disqualify it as a
  self-hosted production substrate, leaving it as a local developer tier only?
- Can `sandbox-runtime` safely wrap only built-in tool execution inside OMA, or
  would that create confusing partial isolation next to Docker-local?
- Is microsandbox mature enough to own OMA session lifecycle before a
  Kubernetes provider exists?
- Does `agent-sandbox` already provide the exact pause/resume state model OMA
  needs, or does OMA still need a worker-local runtime owner ledger above it?
