# Sandbox Provider Landscape for OMA — June 2026

Research notes for the remote/local sandboxing audit. Merges two independent sweeps
(codex + Claude) over web search and GitHub. Star counts as of 2026-06-11.

## Context: what OMA needs

OMA's provider boundary (`provider.ts`) is already provider-shaped: `bash/read/write/edit/find/ls`,
optional file materialization, optional output collection, `dispose()`. Docker-local
(`docker.ts`) implements it with one container per session — no network, read-only rootfs,
tmpfs workspace/uploads/outputs, memory/PID/CPU limits, label-based cleanup.

Two OMA-specific constraints shape the evaluation:

1. **Sessions park indefinitely on `requires_action`** (custom tools, tool confirmations).
   Pause/resume/snapshot semantics are therefore a load-bearing provider feature — not boot
   milliseconds. An always-billed container per paused session is the wrong shape.
2. **OMA is self-hostable.** Designing only around hosted providers (E2B/Modal/Daytona)
   would make self-hosted production second-class. Local → self-hosted → hosted should share
   one logical contract.

---

## 1. Current baseline

| Option | Notes |
|---|---|
| **Docker-local (current)** | Decent L2/L3/L4 posture (limits, read-only, no network) but shared host kernel (weak L1). Next steps: admission limits, reaper policy, rootless support. |
| **Rootless Docker** | Daemon + containers without root. Cheap posture win, platform/network/storage caveats. [Docs](https://docs.docker.com/engine/security/rootless/) |
| **Rootless Podman** | Daemonless OCI alternative; likely a Docker-compatible provider variant. Needs probes for exec, labels, tar materialization, cgroups. [Podman](https://podman.io/) · [Rootless tutorial](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md) |

## 2. Local & lean (no orchestrator)

| Option | What it is | OMA fit |
|---|---|---|
| **Docker Sandboxes** (Docker official, ~Mar 2026) | MicroVM isolation under Docker UX: each sandbox gets **its own kernel and its own Docker daemon**, via a proprietary VMM that works on **macOS and Windows** (unlike Firecracker/gVisor). "Sandbox Kits" = YAML declaring tools, env, injected credentials, **allowed network domains**, files, startup commands — nearly OMA's provider contract shape. Caveats: proprietary, agent-CLI-oriented, programmatic API undocumented (Rivet reverse-engineered it). | **First local probe.** Smallest step from `docker.ts` to a hardware boundary, runs where dev happens (macOS). [Docker blog: Why MicroVMs](https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/) · [InfoWorld explainer](https://www.infoworld.com/article/4177309/docker-sandboxes-and-microvms-explained.html) · [Rivet: reverse-engineered API](https://rivet.dev/blog/2026-02-04-we-reverse-engineered-docker-sandbox-undocumented-microvm-api/) |
| **anthropic-experimental/sandbox-runtime** (4.4k★) | The OS-level sandbox Claude Code itself uses: bubblewrap on Linux, Seatbelt on macOS, enforced network proxying, **no container required**. | Leanest credible local tier (dev/test, trusted-ish). Fitting for a Managed Agents clone. [GitHub](https://github.com/anthropic-experimental/sandbox-runtime) |
| **apple/container** (30k★) + **apple/containerization** (8.6k★) | Apple-official: each Linux container in its own lightweight VM on Apple silicon. | VM-per-session isolation for macOS self-hosters. [container](https://github.com/apple/container) · [containerization](https://github.com/apple/containerization) |
| **Docker + gVisor (runsc)** | User-space kernel; `--runtime=runsc` swap keeps most of the Docker provider. Linux-only; syscall-compat and perf tradeoffs. | Right hardening flag for **Linux** self-hosted Docker; shouldn't be the headline (no macOS). [Docker quick start](https://gvisor.dev/docs/user_guide/quick_start/docker/) · [gVisor](https://gvisor.dev/docs/) (18.5k★) |
| **bubblewrap** (7.6k★) / **nsjail** (4k★) / **minijail** (372★) / **isolate** (1.4k★) | Linux namespace/seccomp wrappers. Shared host kernel; easy to get subtly wrong for untrusted agents. | Experiments and trusted-ish execution only — prefer `sandbox-runtime` which packages this properly. [bubblewrap](https://github.com/containers/bubblewrap) · [nsjail](https://github.com/google/nsjail) · [minijail](https://github.com/google/minijail) · [isolate](https://github.com/ioi/isolate) |

## 3. MicroVM engines & self-hosted sandbox servers (Linux, no K8s)

A tier between "hardened Docker" and "Kubernetes" that the first sweep missed entirely.

| Option | What it is | OMA fit |
|---|---|---|
| **microsandbox** (6.5k★, active) | Self-hosted microVM sandbox server (libkrun-based) with SDKs; "Daytona-like on your own Linux box". | Strong middle-tier candidate. [GitHub](https://github.com/superradcompany/microsandbox) |
| **Self-hosted Daytona** (72k★, open source) | Secure elastic infra for AI-generated code; container-based isolation; pause/archive semantics. | Outsource sandbox plumbing while staying self-hostable. [GitHub](https://github.com/daytonaio/daytona) · [daytona.io](https://www.daytona.io/) |
| **Self-hosted E2B infra** (E2B 12.5k★, infra 1.2k★) | E2B publishes its full Firecracker-based cloud stack (Terraform, GCP/AWS). | Same idea, microVM isolation, heavier ops. [E2B](https://github.com/e2b-dev/E2B) · [infra](https://github.com/e2b-dev/infra) · [docs](https://e2b.dev/docs) |
| **libkrun** (2.3k★) | Library-level VM isolation; also `podman --runtime=krun`. | Leaner than Kata for VM-isolating the existing container flow. [GitHub](https://github.com/libkrun/libkrun) |
| **sysbox** (3.7k★) | "Next-gen runc": rootless-style containers that can run systemd/Docker/K8s inside. | Posture upgrade without VMs. [GitHub](https://github.com/nestybox/sysbox) |
| **forkd** (2.1k★) | `fork()` for agent microVMs — spawn ~100 children in ~100ms from a warm parent, CoW snapshots. | Interesting for warm pools + snapshot/backtracking. [GitHub](https://github.com/deeplethe/forkd) |
| **arrakis** (816★) | Self-hosted MicroVM sandbox for agents with backtracking/snapshots, REST API, Python SDK. | Same niche; less active (last push 2025-06). [GitHub](https://github.com/abshkbh/arrakis) |
| **Cloud Hypervisor** (5.8k★) / **Firecracker** (34.9k★) / **firecracker-containerd** | Raw VMMs. Direct use means owning rootfs/networking/exec/file-sync/reaping — becoming a sandbox platform. | Consume via Kata/microsandbox/E2B-infra instead, unless that's the product. [cloud-hypervisor](https://github.com/cloud-hypervisor/cloud-hypervisor) · [firecracker](https://github.com/firecracker-microvm/firecracker) · [firecracker-containerd](https://github.com/firecracker-microvm/firecracker-containerd) |
| **kuasar** (1.4k★, CNCF) | Multi-sandbox containerd runtime unifying microVM/wasm/quark sandboxes. | Watch; relevant if we standardize on containerd. [GitHub](https://github.com/kuasar-io/kuasar) |
| **flintlock** (1.4k★) / **cocoon** / **arcbox** / **smolvm** (3.7k★) / **microvm.nix** (2.6k★) | Assorted microVM lifecycle managers and engines. | Reference points; none obviously beats microsandbox for our use. [flintlock](https://github.com/liquidmetal-dev/flintlock) · [cocoon](https://github.com/cocoonstack/cocoon) · [arcbox](https://github.com/arcboxlabs/arcbox) · [smolvm](https://github.com/smol-machines/smolvm) · [microvm.nix](https://github.com/microvm-nix/microvm.nix) · [awesome-microvm](https://github.com/infracloudio/awesome-microvm) |
| **Quark** (365★) | gVisor-like secure container runtime in Rust. | Niche. [GitHub](https://github.com/QuarkContainer/Quark) |

## 4. Orchestrated self-hosted (Kubernetes & alternatives)

| Option | What it is | OMA fit |
|---|---|---|
| **kubernetes-sigs/agent-sandbox** (2.8k★, active) | Official K8s SIG project: "isolated, stateful, singleton workloads, ideal for AI agent runtimes" — warm pools, lifecycle controller. Base of Google's managed **GKE Agent Sandbox** (gVisor underneath). | **Design the K8s provider against this, not raw pods.** The contract problem is being solved upstream. [GitHub](https://github.com/kubernetes-sigs/agent-sandbox) |
| **K8s pods + RuntimeClass** | One pod per session; native quotas/namespaces/cleanup; RuntimeClass selects runc/gVisor/Kata; user namespaces now stable. | The production self-hosted target shape. [RuntimeClass](https://kubernetes.io/docs/concepts/containers/runtime-class/) · [user namespaces](https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/) |
| **K8s + gVisor** | Stronger isolation, stays in K8s; lighter than Kata. | Default hardened runtime class. [K8s quick start](https://gvisor.dev/docs/user_guide/quick_start/kubernetes/) |
| **K8s + Kata Containers** (8.1k★) | VM-style isolation via RuntimeClass; heavier ops. | Strongest self-hosted isolation. [katacontainers.io](https://katacontainers.io/) · [GitHub](https://github.com/kata-containers/kata-containers) |
| **netclode** (155★) | Existence proof: self-hosted cloud coding agent on k3s + Kata + cloud-hypervisor microVMs + tailscale. | Worth reading their architecture. [GitHub](https://github.com/angristan/netclode) |
| **Nomad** | Lighter orchestrator; task drivers for Docker, isolated fork/exec, QEMU. | If K8s is too much for a self-hoster. [Task drivers](https://developer.hashicorp.com/nomad/docs/drivers) · [firecracker-task-driver](https://github.com/cneira/firecracker-task-driver) |
| **LXD** | API-managed system containers and VMs. | Viable substrate, uncommon for agent products. [Docs](https://documentation.ubuntu.com/lxd/) |
| **beam-cloud/beta9** (1.7k★) | Self-hostable serverless platform with sandbox primitive + GPU. | If GPU sandboxes become a requirement. [GitHub](https://github.com/beam-cloud/beta9) |

## 5. Hosted sandbox platforms

Evaluate primarily on **pause/resume/snapshot semantics and egress policy**, not cold-start ms.
(Caveat: most comparison posts below are vendor content — directionally useful, trust numbers less.)

| Provider | Isolation | Notable | Links |
|---|---|---|---|
| **E2B** (12.5k★) | Firecracker microVMs | Largest template ecosystem; 30-day pause; open infra. | [e2b.dev](https://e2b.dev/) · [docs](https://e2b.dev/docs) |
| **Daytona** (72k★) | Containers | Sub-90ms starts; archive after 30 days; open source. | [daytona.io](https://www.daytona.io/) |
| **Modal** | gVisor | GPU workloads; snapshots capped ~7 days (alpha). | [Sandboxes docs](https://modal.com/docs/guide/sandboxes) |
| **Deno Sandbox** | Cloud Linux microVMs | Sub-second boot; JS/Python SDK. | [docs](https://docs.deno.com/sandbox/) |
| **Fly.io Sprites** | Fly Machines microVMs | Agent-specific product on Fly; pay-per-use. | [sprites.dev](https://sprites.dev/) · [Machines API](https://fly.io/docs/machines/api/) |
| **Cloudflare Sandboxes** (SDK 1k★) | Edge containers | Runs on Cloudflare's network; SDK open. | [GitHub](https://github.com/cloudflare/sandbox-sdk) |
| **Vercel Sandbox** | microVM | Ephemeral compute for untrusted code; Vercel-native. | [GitHub](https://github.com/vercel/sandbox) · [docs](https://vercel.com/docs/vercel-sandbox) |
| **CodeSandbox SDK** | microVM, memory snapshot/fork | Snapshot/resume + VM forking. | [GitHub](https://github.com/codesandbox/codesandbox-sdk) · [docs](https://codesandbox.io/docs/sdk) |
| **Blaxel** | microVM | Indefinite zero-cost standby, ~25ms resume claim. | [blaxel.ai](https://blaxel.ai/) |
| **Morph** | microVM ("Infinibranch") | Snapshot/branch-heavy model. | [morph.so](https://morph.so/) |
| **Runloop** | Devboxes for agents | Agent-focused devbox API. | [runloop.ai](https://runloop.ai/) |
| **Northflank** | Containers/microVM | Lowest published CPU rate in comparisons; GPU. | [northflank.com](https://northflank.com/) |
| **Unikraft Cloud** | Unikernels | ms-scale cold starts. | [unikraft.org](https://unikraft.org/) · [GitHub](https://github.com/unikraft/unikraft) (3.7k★) |
| Cloud-vendor managed | varies | Azure Container Apps dynamic sessions, AWS Bedrock AgentCore code interpreter, GKE Agent Sandbox. | [Azure](https://learn.microsoft.com/en-us/azure/container-apps/sessions) · [AgentCore](https://aws.amazon.com/bedrock/agentcore/) |

Comparisons: [Northflank: Daytona vs E2B](https://northflank.com/blog/daytona-vs-e2b-ai-code-execution-sandboxes) · [Northflank: pricing](https://northflank.com/blog/ai-sandbox-pricing) · [Superagent benchmark](https://www.superagent.sh/blog/ai-code-sandbox-benchmark-2026) · [ZenML: E2B alternatives](https://www.zenml.io/blog/e2b-alternatives) · [Better Stack: sandbox runners](https://betterstack.com/community/comparisons/best-sandbox-runners/) · [Blaxel comparison](https://blaxel.ai/blog/sandboxes-for-coding-agents-comparison) · [StartupHub 2026](https://www.startuphub.ai/ai-news/artificial-intelligence/2026/daytona-vs-e2b-vs-modal-vs-vercel-sandbox-2026) · [Ry Walker research](https://rywalker.com/research/ai-agent-sandboxes)

## 6. Adjacent — not mainline for OMA

| Option | Why not |
|---|---|
| **judge0** (4.2k★) / **Piston** (2.7k★) | Snippet-execution engines, not session workspaces. [judge0](https://github.com/judge0/judge0) · [piston](https://github.com/engineer-man/piston) |
| **dagger/container-use** (3.8k★) | Dev environments for coding agents (git-branch-per-agent); orchestration layer, not an isolation substrate. [GitHub](https://github.com/dagger/container-use) |
| **Wasmtime / WASI / WasmEdge** | Constrained tool execution, not full Linux coding-agent parity; Node WASI explicitly disclaims secure sandboxing. [Wasmtime](https://wasmtime.dev/) · [Node WASI note](https://nodejs.org/api/wasi.html) |
| **WebContainers** | Browser-side dev runtime, not a server-side untrusted Linux sandbox. [webcontainers.io](https://webcontainers.io/) |
| **Jupyter Kernel Gateway** | Code-interpreter kernels, not a sandbox boundary. [Docs](https://jupyter-kernel-gateway.readthedocs.io/) |
| **Slurm + Enroot/Pyxis** | HPC/GPU clusters only. [Slurm containers](https://slurm.schedmd.com/containers.html) · [Pyxis](https://github.com/NVIDIA/pyxis) |

## 7. Evaluation framework worth adopting

[**The Agent Sandbox Taxonomy (AST)**](https://github.com/kajogo777/the-agent-sandbox-taxonomy)
(v1.0, March 2026, WIP) — 7 defense layers (compute isolation, resource limits, filesystem,
network, credentials, action governance, observability) × 7 threat categories × 3 scoring
dimensions, with score cards for 26 products (Docker Sandbox, E2B, Daytona, Sprites, Deno,
Cloudflare, Vercel, GKE Agent Sandbox, Claude Code local/web, …).

The OMA sandbox audit doc should adopt this framing instead of inventing criteria, and score
the current Docker-local provider honestly with it (good L2/L3/L4; shared-kernel L1).

## 8. Recommendation

1. **Audit doc first, no code.** Structure with AST layers/threats; baseline-score Docker-local.
2. **First local probes:** Docker Sandboxes (official, macOS-capable, smallest step from
   `docker.ts`) alongside Docker+gVisor (the Linux-server hardening flag). Add
   `sandbox-runtime` as the lean no-container dev/test tier. Podman-rootless as compat probe.
3. **K8s production target:** design against `kubernetes-sigs/agent-sandbox` + RuntimeClass
   (runc → gVisor → Kata), not hand-rolled pods.
4. **Self-hosted-no-K8s middle tier:** microsandbox, or self-hosted Daytona / E2B-infra.
5. **Hosted matrix:** E2B, Daytona, Modal, Deno + Sprites, Cloudflare, Vercel, Morph,
   Runloop, Blaxel, CodeSandbox, Northflank. Differentiate on pause/resume + egress policy.
6. **Contract addition:** suspend/restore must be first-class in the provider contract
   (OMA sessions park indefinitely on `requires_action`).
7. **Do not build direct Firecracker/Cloud Hypervisor.** Consume microVMs through
   Kata/microsandbox/Docker Sandboxes/hosted providers.
