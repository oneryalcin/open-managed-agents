# Prior art: Firecracker, Agent Substrate, and celld

Date: 2026-08-07

Purpose: evaluate three projects proposed as alternatives to OMA's current
sandbox tiers — `docker-local` (default) and `microsandbox-local` (limited
support, plan [0110](../plans/0110-microsandbox-local-provider.md)):

- [firecracker-microvm/firecracker](https://github.com/firecracker-microvm/firecracker)
- [agent-substrate/substrate](https://github.com/agent-substrate/substrate)
- [denoland/celld](https://github.com/denoland/celld)

All three were read from primary source (local clones), not from marketing.
This extends the survey in plan
[0106](../plans/0106-sandbox-provider-landscape.md), which currently disposes of
Firecracker in one line and mentions neither of the others.

This is not an ADR. It records what each project actually is, whether it can
replace or sit under our provider contract
([0107](../plans/0107-sandbox-provider-contract-audit.md)), and what to borrow
regardless of adoption.

## Verdict up front

**The load-bearing finding is that none of the three is at the layer it is
proposed for.** Each was suggested as a replacement for our sandbox; each turns
out to be a different subsystem entirely.

| Project | Where it actually sits | Analogy |
| --- | --- | --- |
| Firecracker | *below* the sandbox — a VMM, peer of `runc` | the walls |
| Agent Substrate | *above* the sandbox — a K8s actor multiplexer | the dispatcher |
| celld | *beside* the sandbox — durable per-session state | the session's memory |

- **None is a drop-in alternative to `docker-local`, and none should change the
  default.** They are not the same kind of thing as each other, and none is the
  same kind of thing as our provider.
- **Firecracker is a VMM.** It is a peer of `runc`/`crun`, one layer *below*
  `docker.ts`. "Switch to Firecracker" means OMA takes ownership of guest
  kernels, block-device rootfs building, TAP networking, a guest agent for
  exec/file ops, jailer/cgroup setup, snapshot storage, and a documented host
  hardening burden. 0106's existing "too much substrate for OMA to own first"
  line is correct; this note replaces the assertion with cited reasons.
- **Agent Substrate is an orchestration layer, one layer *above* our provider,
  and it has no exec or file API at all.** Actors are HTTP servers reached
  through a DNS + Envoy mesh; there is no `bash`/`read`/`write`/`find`/`ls`
  surface for a harness to drive. It cannot host Pi's built-in tool delegation
  without OMA writing an in-guest agent first.
- **Substrate is nevertheless the single most relevant piece of prior art we
  have found for the problem 0106 flags and does not solve: parking a session
  indefinitely on `requires_action` without paying for it.** Its answer —
  full RAM+filesystem snapshot to object storage, warm worker pool, resume on
  any node, request-triggered wake at the router — is the design we should
  measure our own eventual answer against.
- **celld runs JavaScript in V8 isolates and cannot execute a subprocess at
  all** (`node:child_process` is an unimplemented inert stub). It is not a
  sandbox in the sense we need. It *is* a credible candidate for a layer we had
  not evaluated: durable per-session state, i.e. the storage layer in plan
  [0103 phase 2](../plans/0103-phase-2-storage-design.md).
- **Notable data point:** Substrate's micro-VM sandbox class is **Kata
  Containers + Cloud Hypervisor**, not Firecracker. A well-resourced team
  building exactly this, in 2026, consumed microVMs through Kata rather than
  owning a VMM. That is independent support for our position.
- **Parking has two halves, and we had only been looking at one.** Substrate
  answers "stop paying for idle compute"; celld answers "keep the session's
  state and its open client connection alive while nothing runs". OMA
  eventually needs both, and they are different subsystems. See
  [Parking has two halves](#parking-has-two-halves) below.

## Sources checked

- Firecracker: local clone pinned to `6dbec6c5d53dc7c881272a42f2b692163fe6cdac`
  (2026-08-06). Apache-2.0, Rust, ~36k stars. Latest release tag `v1.16.1`
  (`git ls-remote --tags`). Repo:
  <https://github.com/firecracker-microvm/firecracker>.
- Agent Substrate: local clone pinned to
  `97489938a87a864b54d8e2e4fbfa45ddbe5f407b`
  (`api: add actor_uid to Assignment alongside actor (#736)`, 2026-08-06).
  Apache-2.0, Go, ~1k stars, 210 forks. Repo:
  <https://github.com/agent-substrate/substrate>. Explicitly "not an officially
  supported Google product" (`README.md`), though its threat model is authored
  by google.com addresses and the CNCF Slack hosts its channels.
- microsandbox VMM lineage cross-check: its README credits
  [libkrun](https://github.com/containers/libkrun) (KVM on Linux, Windows
  Hypervisor Platform, Apple Silicon on macOS).

All file citations below are against those pinned clones.

---

## Firecracker

### What it actually is

A minimalist VMM: it opens `/dev/kvm`, boots a Linux guest, and exposes a REST
API over a Unix socket to configure it. It does not build images, manage
networks, schedule anything, or run commands for you.

Facts that matter for OMA specifically:

1. **No shared filesystem.** The device model is deliberately minimal:
   virtio-block, virtio-net, virtio-vsock, virtio-rng, virtio-pmem, virtio-mem,
   serial console, i8042 (`docs/design.md`, `docs/device-api.md`). There is no
   virtio-fs and no 9p. **There is no bind mount.** Our
   `materializeFileResources` (a `docker cp`-style tar stream into the
   container) and `collectOutputFiles` have no equivalent primitive — every
   session would need a purpose-built block image, or a vsock file-transfer
   protocol we write and maintain on both sides.
2. **No exec.** There is no "run this command" API. Pi tool delegation would
   require an OMA-authored guest agent speaking over vsock, plus its lifecycle,
   versioning, and failure semantics. Osaurus's vsock+token bridge (recorded in
   [agentos-osaurus-prior-art.md](agentos-osaurus-prior-art.md)) is the shape,
   but we would be building it.
3. **KVM only, and that is more restrictive than it sounds.** x86_64 and
   aarch64 Linux hosts (`docs/kernel-policy.md`). The getting-started guide is
   blunt about the cloud consequence: "We exclusively use `.metal` instance
   types, because EC2 only supports KVM on `.metal` instance types"
   (`docs/getting-started.md`). Nested virtualization is available on some GCP
   machine types but is not a portable assumption.
4. **No macOS.** This alone disqualifies it as a replacement for the default
   tier. `docker-local` is what makes the developer-laptop path work, and
   `microsandbox-local` covers Apple Silicon via libkrun. Firecracker covers
   neither.
5. **Host hardening is the operator's job, and the list is long.**
   `docs/prod-host-setup.md` has sections for seccomp, jailer cgroup
   configuration, disk/memory/vCPU isolation, kvm-pit CPU overhead, network
   flood mitigation, guest egress filtering, storage noisy-neighbour
   mitigation, disabling swap, and hardware-vulnerability mitigations. Firing
   this at an appliance operator (`oma up`, plan
   [0115](../plans/0115-appliance-entrypoint.md)) is not viable.
6. **Snapshot semantics are sharper than "it saves the VM".**
   `docs/snapshotting/snapshot-support.md`:
   - Captures guest memory, device state, and microVM config. **Disk contents
     are not flushed to backing files**; network/vsock packet loss across
     restore is expected. Our workspace durability would still have to be an
     explicit volume — which is exactly the invariant 0107 already pins.
   - Restore requires effectively identical host CPU/kernel configuration;
     forward compatibility is narrow (5.10 → 6.1, not the reverse). A
     heterogeneous self-hosted fleet cannot freely resume anywhere.
   - **Diff snapshots are still developer preview**
     (`docs/snapshotting/snapshot-support.md:114`).
   - **Resuming the same snapshot more than once is explicitly called
     insecure**: "identifiers, random numbers and random number seeds, the
     guest OS entropy pool, as well as cryptographic tokens" may be duplicated
     (`snapshot-support.md:517-525`). VMGenID reseeds the *kernel* PRNG on
     resume; application-level state stays cloned.

### Where it does show up in our stack already

Indirectly, and that is the right shape. E2B and Vercel Sandbox (both in
0106's hosted matrix) run on Firecracker. Consuming it through a provider is
already how we would get it.

### Recommendation

Do not adopt directly. Keep 0106's disposition, now with reasons. If OMA later
wants hardware-virtualization isolation on Linux servers, get it from a layer
that already owns kernel, rootfs, networking, and agent:
`microsandbox-local` (libkrun; already wired, and works on macOS), or Kata
under a Kubernetes `RuntimeClass` beneath `kubernetes-sigs/agent-sandbox`
(0106's K8s design target). Owning a VMM is only correct if sandbox
infrastructure becomes the product, which it is not.

---

## Agent Substrate

### What it actually is

A Kubernetes-native control plane that multiplexes a large set of stateful
"actors" onto a small pool of pre-warmed "worker" pods, by snapshotting an idle
actor's **RAM and filesystem** to object storage and restoring it on demand —
on any worker, on any node. Its stated targets: 100 ms p95 activation, 1
billion actors per cluster, 1000 wakeups/second (`docs/architecture.md`). The
headline demo multiplexes ~250 actors across 8 pods.

Component shape (`docs/architecture.md`, `README.md`):

- `ate-api-server` — gRPC control plane; actor/worker records live in
  Valkey/Redis, **not** in the Kubernetes API server, deliberately ("The
  Kubernetes API server is not designed to handle millions of resources").
- `atecontroller` — reconciles the two CRDs, `WorkerPool` and `ActorTemplate`.
- `atelet` — per-node DaemonSet; drives checkpoint/restore, moves snapshots to
  and from GCS/S3.
- `ateom-gvisor` / `ateom-microvm` — in-pod sandbox herders. gVisor uses
  `runsc` checkpoint/restore; the micro-VM class uses **Kata + Cloud
  Hypervisor**, with `userfaultfd` demand paging on restore.
- `atenet` — CoreDNS + Envoy with an `ext_proc` filter that reads the actor
  name from the `Host` header, calls the control plane to **resume the actor**,
  then tunnels over mTLS to `atunnel` in the worker pod.

### Why it is not an OMA sandbox provider

1. **No exec/file surface.** The full control-plane API
   (`pkg/proto/ateapipb/ateapi.proto`) is `CreateActor`, `GetActor`,
   `UpdateActor`, `SuspendActor`, `PauseActor`, `ResumeActor`, `DeleteActor`,
   snapshot get/list/tag, `ListWorkers`, `ListActors`, atespace CRUD, plus
   `MintJWT`/`MintCert`. The node-level API
   (`internal/proto/ateompb/ateom.proto`) is `RunWorkload`,
   `CheckpointWorkload`, `RestoreWorkload`. **Nothing runs a command or moves a
   file.** The only way into an actor is an HTTP request through the router.
   Our `SandboxOperations` (`bash`, `read`, `write`, `edit`, `find`, `ls`)
   would have to be re-expressed as an HTTP protocol against an OMA-authored
   in-actor server — which is what their own sandbox demo does
   (`demos/sandbox/main.go` exposes a `/process` endpoint, with a README
   warning that it "will execute any client-provided commands with no
   validation").
2. **Kubernetes is mandatory, and so is the rest of the stack.** A cluster,
   Valkey, object storage (GCS today; "Support for S3 (via plugin)" is still on
   the roadmap), plus CRDs and a DaemonSet. This is in direct tension with
   0106 requirement 6 (self-hostability) and with the appliance direction in
   [0114](../plans/0114-appliance-product-roadmap.md)/[0115](../plans/0115-appliance-entrypoint.md).
   `oma up` and "bring a GKE cluster" are not the same product.
3. **Maturity.** "Currently in early development. It is not ready for
   production use, and the APIs are almost guaranteed to change" (`README.md`).
   `docs/architecture.md` opens with "Much of this architecture is aspirational,
   and is not yet implemented!" The threat model states Substrate "has little
   to no security hardening at this time". Garbage collection of deleted
   actors' snapshots is not implemented. The gVisor backend needs a `runsc`
   built with `--allow-connected-on-save` to work around a networking bug on
   checkpoint. The micro-VM class needs nested-virt-capable nodes plus a
   hand-assembled five-file toolchain (`hack/microvm-assets/README.md`).
4. **It solves a scale problem we do not have.** 1B actors and 1000 wakeups/s
   is a hyperscaler shape. OMA's admission-limit and single-node durable
   storage work ([0103](../plans/0103-deployment-hardening.md),
   [0113](../plans/0113-workspace-authentication-admission.md)) is sized for a
   very different deployment.

### What is genuinely worth taking

This is the valuable part of the evaluation. Six items, in rough order of how
soon they bite us.

1. **Identity must not be baked into anything that gets snapshotted.**
   Substrate delivers each actor its own name via a read-only bind mount at
   `/run/ate/actor-id`, and the API guide explains why an env var would be
   wrong: an env var "would be frozen at the *golden* actor's name, since it
   lives in the checkpointed process memory, and would therefore be identical
   for every actor of the template" (`docs/api-guide.md`). This is a real,
   non-obvious correctness bug class that OMA hits **the moment** it adds any
   snapshot-based warm start or parking — every resumed session would carry the
   golden session's identifiers. Pair it with Firecracker's uniqueness warning
   above: the same hazard shows up at the VMM layer as duplicated entropy and
   cryptographic tokens. Both belong in 0107 as explicit park/resume contract
   requirements, not as folklore.
2. **Workspace persistence separate from the snapshot — independently
   arrived at.** Substrate's micro-VM class captures a memory-only VM snapshot
   with container rootfs writes in a guest `tmpfs` overlay, while `DurableDir`
   volumes are **host-backed**, served over a second writable virtio-fs share,
   and shipped in snapshots as a tar so a `Data`-scope snapshot needs no guest
   memory at all (`docs/architecture.md`). That is 0107's invariant —
   "session workspace = explicit durable mount; sandbox rootfs = disposable
   implementation detail" — reached by a different team from a different
   direction. Good confirmation that we pinned the right thing.
3. **Runtime version pinned into the snapshot; class is a hard scheduling
   gate.** `SandboxConfig` is cluster-scoped and supplies the sandbox binaries;
   the version is recorded in each snapshot's manifest so restores stay
   reproducible across runtime upgrades, and `sandboxClass` is immutable and
   AND'd into every placement decision because "a snapshot is not restorable
   across sandbox runtimes" (`docs/api-guide.md`). Our analogue: any OMA state
   we persist for a session must record the provider **and** its runtime
   version, and resume must refuse a mismatch rather than discover it during
   restore. Adjacent to the digest-pinning already in plan
   [0140](../plans/0140-alpha-coding-sandbox-image.md).
4. **A readiness gate on create *and* restore.** Each container may declare a
   `readyz` HTTP probe; `RunWorkload` and `RestoreWorkload` return only after
   every probed container answers 200, bounded by a 30 s deadline, polled at
   ~500 µs (`docs/api-guide.md`). When every container declares `readyz`, the
   template controller skips its default ~20 s "let the workload settle" delay
   before taking the golden snapshot. Our provider contract has no readiness
   concept — create returns when the container is up, not when the sandbox is
   usable. Worth adding to 0107 as an optional provider capability.
5. **Golden snapshot as the warm-start primitive.** An `ActorTemplate` boots
   once, initializes, and is checkpointed; every actor of that template starts
   by restoring that snapshot rather than booting. Their best-practice advice
   is to push expensive init (model loads, connection setup) into startup so it
   lands in the golden snapshot. The OMA-shaped version is one warm snapshot
   per immutable agent version, amortizing Pi/npm/tool boot across sessions.
   Note the constraint it inherits: see item 1, plus Firecracker's
   resume-more-than-once warning.
6. **Credentials bound to the scheduling assignment, not to a bearer token in
   the guest.** `MintCert`/`MintJWT` are not callable by actors. The broker
   signs only when the caller's cert identifies the `atelet` service account
   with a Pod Identity extension pinning it to a node, **and** the actor is
   currently running, **and** the worker pod hosting it is on that same node
   and still assigned to it. Failures return `PERMISSION_DENIED` with no
   detail, so the RPC cannot be used to probe for actor existence
   (`docs/api-guide.md`). This is a sharper version of the posture ADR 0016
   already takes (secrets stay in the harness, never in the guest), and it is
   the right model for the egress/secret work in
   [0117e](../plans/0117e-egress-session-wiring.md): bind the credential to
   (session, worker, node), and let the sandbox hold nothing.

Their threat model (`docs/threat-model.md`) is also worth reading directly. Two
rows map onto open OMA work almost exactly:

- **Worker reuse.** "All actor-specific worker state, including process state,
  filesystem, env vars, mounted config, network policy, and security policy,
  must be completely reset between actors that subsequently run on the same
  worker" — with the suggested test being honeypots on each side of the
  boundary. This is our reaper/teardown gap, which
  [threat-model.md](../threat-model.md) still lists as open before untrusted
  multi-tenant deployment.
- **Credential leakage.** "Agent leaks credentials exposed in sandbox, because
  LLMs are unreliable. Due to prompt injection or just agent silliness."
  Mitigating invariant: "Credentials are not exposed in sandboxes by default."
  Same conclusion as ADR 0016, independently reached.

### Recommendation

Do not adopt as a provider. Track as the design target for a future OMA
Kubernetes tier, **alongside** `kubernetes-sigs/agent-sandbox` rather than
instead of it — they answer different questions. `agent-sandbox` answers "how
is a long-lived session modelled as a Kubernetes object"; Substrate answers
"how do I park a thousand of them cheaply and wake one in 100 ms". Substrate
deliberately does *not* put actors in the Kubernetes API server, so the two are
complementary designs, not competing ones.

The near-term action is not a provider probe. It is to fold items 1–4 above
into 0107 as contract requirements before any park/resume or snapshot work
starts, since all four are cheap to specify now and expensive to retrofit.
Tracked in [issue #229](https://github.com/oneryalcin/open-managed-agents/issues/229).

---

## celld

### What it actually is

Self-hosted Cloudflare Durable Objects. Each "cell" is a V8 isolate plus its
own SQLite database, addressed by name, continuously replicated to an
S3-compatible bucket you own using LTX (Litestream's replica format). Workers
and Durable Objects code deployed with a Wrangler config subset runs unchanged.

The genuinely elegant part is coordination: **there is no control plane and no
consensus.** Ownership of a cell is a compare-and-swap lease in the bucket;
nodes discover owners and peers from the bucket alone, with no membership
protocol or failure detector (`README.md`). The bucket is the durable source of
truth and nodes are replaceable. Stated numbers: ~4 MB RAM per resident cell,
~1000 cells per 8 GB node, RPO=0 on acknowledged writes, ~20 s failover after
node loss.

### Why it is not a sandbox

The pitch that reached us framed Durable Objects as the thing that finally
replaces "Docker, Kubernetes, VPSs, and a slew of other unholy tooling" for
agent isolation. That argument turns on one word meaning two things:

- **State isolation** — every agent gets its own memory, database, and handler,
  with no shared table locks. Cells are excellent at this, and the throughput
  argument for per-agent SQLite is correct.
- **Execution isolation** — running code you do not trust, that shells out.
  **A cell cannot do this at all.**

From `docs/cloudflare-compat.md`: `node:child_process` is **not implemented**
(an inert stub, flagged as a known silent gap), along with `node:net`,
`node:tls`, `node:dns`, `node:os`, `node:process`, `node:vm`, and
`node:worker_threads`. `node:fs` reads fail with `ENOENT`. `cloudflare:sockets`
`connect()` returns an inert stub. A cell cannot run `bash`, `npm install`, or
`git clone` — which is the entire job of our sandbox tier. Pi itself could not
run in a cell either.

Nor is a V8 isolate a stronger boundary than a container; it is a weaker one.
`docs/security.md` is explicit: **"celld is an alpha. It is not safe for
hostile multi-tenant use."** The same layering shows up at Cloudflare, where
Sandboxes are a separate container-based product *alongside* Durable Objects
rather than built on them.

The closest thing to code execution is **Worker Loader ("Code Mode")**, an
experimental port behind `CELLD_WORKER_LOADER` that starts a fresh isolate per
loaded worker and supports `globalOutbound: null` for no egress. That is a JS
plugin sandbox, capped at 64 MiB of code, not a workspace.

### Where it is genuinely relevant

celld is not competing with `docker.ts`. It is competing with our **storage
layer** — the single-node `better-sqlite3` store in plan
[0103 phase 2](../plans/0103-phase-2-storage-design.md).

One OMA session is an event log, an SSE replay cursor, a state machine, and a
client holding a connection open. One cell is a SQLite database, an HTTP
handler, durable alarms, and an **inbound hibernatable WebSocket**. The mapping
is close to one-to-one, and hibernation — holding a live client connection
while the cell's compute is shut down — is the piece with no analogue in our
current stack.

### Parking has two halves

The Substrate evaluation above treats `requires_action` parking as one problem.
Reading celld makes clear it is two, in different subsystems:

| Half | Question | Prior art |
| --- | --- | --- |
| Compute | how do I stop paying for an idle sandbox? | Substrate — snapshot RAM+FS, warm worker pool |
| Session | how do I keep the session's state *and its open client connection* alive while nothing runs? | celld — cell hibernation + WebSocket hibernation |

OMA eventually needs both. They do not have to be solved by the same system,
and the architecture both point at is two-tier: **session state in cells,
execution in containers.**

### What blocks adoption today

- **v0.1.0, tagged 2026-08-05** — two days before this evaluation.
  Self-described alpha; security fixes go to the latest release only.
- **"A fleet runs one application deployment."** No multi-tenant scheduler, no
  account service, no managed ingress, no global placement layer
  (`docs/limitations.md`). OMA is a multi-workspace control plane
  ([0113](../plans/0113-workspace-authentication-admission.md)); this is a
  direct collision, not a gap to work around.
- Peer HTTP **does not terminate TLS** — private network or an encrypted
  overlay (WireGuard/Tailscale) is required, and a public advertise address is
  rejected without an explicit unsafe flag.
- Bucket credentials are **fleet administrator access**, by design.
- Pressure shedding is off by default pending release measurements.
- Adoption is not a swap. It is a rewrite of the control plane into the Workers
  programming model, against a storage layer we have already built.
- Governance worth knowing before taking a dependency: **pull requests are
  disabled** (patches by email), and the CLA assigns rights to Deno Land Inc.
  Apache-2.0, but a single-vendor project with no normal contribution path.

### Recommendation

Do not adopt. Track deliberately rather than casually: it is the first credible
answer we have seen to the session half of the parking problem, and the
"coordinate through object storage, no consensus" design is worth understanding
even if we never depend on it. Revisit when multi-tenancy exists and the
alpha label comes off.

The near-term action is again not a probe. It is to notice that our storage
design and our parking design are the same design, and that plan 0103 phase 2
should be written knowing a session's durable state and its live client
connection have a shared lifecycle. Tracked in
[issue #230](https://github.com/oneryalcin/open-managed-agents/issues/230).

---

## Net takeaways

- No change to the default. `docker-local` stays; `microsandbox-local` remains
  the self-hosted no-Kubernetes tier.
- 0106's one-line dismissal of Firecracker was right, and is now backed by
  specifics: no shared filesystem, no exec, KVM-only (`.metal` on EC2), no
  macOS, a long host-hardening obligation, and snapshot semantics that forbid
  naive reuse.
- Substrate is not a Docker alternative — it is an orchestration layer with no
  exec/file surface, requiring Kubernetes + Valkey + object storage, in early
  development with little security hardening. Its value to us is as a
  reference design for cheap `requires_action` parking, and as a source of four
  concrete contract requirements we should adopt now.
- The strongest single finding: **snapshot-based parking silently breaks
  identity and entropy uniqueness unless the contract says otherwise.**
  Substrate names it at the application layer (`/run/ate/actor-id` as a bind
  mount, never an env var); Firecracker names it at the VMM layer (duplicated
  seeds, entropy pools, and cryptographic tokens across restores). Any OMA
  park/resume design has to answer both, and 0107 currently answers neither.
- celld is not a sandbox and cannot become one — a cell has no subprocess, no
  filesystem, and no sockets, and its own docs say it is "not safe for hostile
  multi-tenant use". It is a candidate for the storage layer instead, blocked
  today by the one-application-per-fleet limit.
- Parking is two problems, not one: idle **compute** (Substrate's answer) and
  live **session state plus held client connection** (celld's answer). Plan
  0103 phase 2 and any future parking design are the same design.
- Secondary finding worth recording: the project best positioned to use
  Firecracker chose Kata + Cloud Hypervisor instead. Consume microVMs through a
  layer that owns kernel, rootfs, networking, and agent — do not own a VMM.
- Recurring shape across all three: **the useful unit is one durable thing per
  session** — Substrate's actor, celld's cell, our session. Each project's
  hardest-won lessons are about what may and may not be baked into that unit's
  frozen state.
