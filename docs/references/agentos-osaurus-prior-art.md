# Prior art: agentOS (rivet-dev) and Osaurus (osaurus-ai)

Date: 2026-06-26

Purpose: survey two recently-found agent-runtime projects as prior art for OMA,
read from primary source (local clones), not from their marketing. The trigger
was the upcoming `microsandbox-local` sandbox provider slice (issue #121, plan
[0107](../plans/0107-sandbox-provider-contract-audit.md)), but this note records
the interesting bits for OMA **overall**, not only sandbox relevance.

Neither project is a Managed Agents clone, so this complements — does not
overlap — [oma-implementations-prior-art.md](oma-implementations-prior-art.md).
agentOS is a Pi-native in-process agent runtime; Osaurus is a macOS-only desktop
agent harness with an Apple-Containerization Linux-VM sandbox.

This is not an ADR. It records where these implementations validate, challenge,
or diverge from our decisions, and what (if anything) we should borrow.

## Sources checked

- agentOS: local clone `/tmp/agentos`, pinned to
  `4c2b9bbbf41faa215b41f56f802c5f8afe3477d0`
  (`fix(actor-plugin): live sessionEvent streaming over the RivetKit actor
  path`). Apache-2.0. TypeScript + Rust monorepo (pnpm/turbo).
  Repo: <https://github.com/rivet-dev/agentos>. Docs: <https://agentos-sdk.dev/docs>.
- Osaurus: local clone `/tmp/osaurus`, pinned to
  `86195e1d5854c282937ba894581f8d9918074efb`
  (`fixed tools page layout hang (#1724)`). Native Swift, macOS 15.5+ Apple
  Silicon only. Repo: <https://github.com/osaurus-ai/osaurus>.

All file:line citations below are against those pinned clones.

---

## agentOS (rivet-dev) — Pi-native in-process agent OS

### What it is

A "portable operating system for AI agents" that runs **inside your Node
process** rather than in a VM or container. It boots an in-process kernel
(virtual filesystem, process table, pipes, PTYs, virtual network stack) and runs
commands as WASM (Rust-compiled coreutils/git/ripgrep/etc.) plus JS/Python
(Pyodide) — *not* a real Linux kernel. README claims ~5ms p50 cold start and
~22–131 MB/instance, versus ~440ms+ and ~1 GiB for hosted microVM sandboxes.

Crucially for us: it ships a first-class **Pi** integration
(`@agentos-software/pi`, wrapping `@mariozechner/pi-coding-agent`) and speaks
**ACP** (Agent Communication Protocol) so Pi, Claude Code, and OpenCode are
interchangeable behind one session API.

Key locations:

- `packages/core/src/agent-os.ts` — session lifecycle, mounts, limits, public
  `exec` / `readFile` / `writeFile`.
- `packages/core/src/runtime.ts` — `VirtualFileSystem`, `NetworkAdapter`,
  `Permissions` interfaces.
- `packages/core/src/sidecar/permissions.ts` — deny-by-default serialization.
- `packages/agentos-sandbox/` — the "pair with a full sandbox" extension.
- `crates/agentos-sidecar/` — Rust transport/dispatch/ACP extension.
- `packages/secure-exec/`, `packages/posix`, `packages/python`, `packages/shell`
  — the execution substrate the kernel composes.

### Interesting bits for OMA (overall)

1. **Unified deny-by-default permission model.** One `Permissions` shape covers
   `fs / network / childProcess / process / env / binding`, each `allow|deny`
   with path/pattern rules (`packages/core/src/runtime.ts:184`). With no
   permissions supplied, everything serializes to `"deny"`
   (`packages/core/src/sidecar/permissions.ts:45-50`). This is a more expressive
   version of what plan 0107 is sketching, and it is the closest **Pi-native**
   reference we have for a provider permission contract. Relevant well beyond the
   sandbox: it is also a model for tool-permission / builtin-access policy
   (cf. `PiToolPermissionBridge`).

2. **Composable VFS mount plugins.** Mounts are first-class and pluggable —
   host-dir, S3, Google Drive, overlay (copy-on-write lower/upper), and a remote
   "sandbox" backend (`packages/core/src/agent-os.ts`, `NativeMountConfig` /
   `OverlayMountConfig`). This is directly relevant to OMA's
   `materializeFileResources` / `collectOutputFiles` and to ADR 0013/0014. The
   overlay-as-mount idea is a lighter alternative to provider snapshots for the
   "session workspace = explicit durable mount" invariant from 0107.

3. **Lazy "sandbox extension" as a tool toolkit.** A heavier full-sandbox
   (E2B/Daytona/etc.) is mounted **on demand** as a virtual filesystem and
   surfaced as agent-callable tools — `run-command`, `create-process`,
   `list-processes`, `stop-process`, `get-process-logs`, `send-input`
   (`packages/agentos-sandbox/src/toolkit.ts:25-220`;
   `createSandboxFs` re-exported from `@secure-exec/sandbox` at
   `packages/agentos-sandbox/src/index.ts:5`). Two-tier model: cheap in-process
   runtime for light work, escalate to a real sandbox only when needed. This is a
   concrete answer to OMA's open question on **lazy sandbox start / cheap
   `requires_action` parking** (0106 requirement #2, 0107 open question).

4. **ACP decouples the agent from the execution substrate.** Pi runs as a
   separate process speaking ACP/JSON-RPC over stdio; the kernel never imports
   Pi. That is the same separation OMA enforces with `SessionRunner` /
   `SandboxProvider`, validated by an independent codebase — and a hint that an
   ACP seam could one day let OMA host non-Pi agents without touching the
   provider contract.

5. **Fine-grained resource accounting.** `AgentOsLimits.resources` caps
   cpuCount, processes, fds, pipes, ptys, sockets, connection bytes, filesystem
   bytes, inode count, plus WASM fuel/memory (`packages/core/src/agent-os.ts`).
   Richer than our current memory/PID/CPU/timeout set; a menu for the provider
   contract's L2 layer.

### Where it diverges / limits as prior art

- **Not a microVM/Docker provider.** Isolation is an in-process JS/WASM kernel,
  not an OS kernel boundary. There is no pid/namespace isolation from the host;
  enforcement is kernel-internal accounting. Heavy/native workloads (browsers,
  arbitrary binaries, real package installs) require escalating to the external
  sandbox extension. For OMA's untrusted-code isolation bar this is a *policy /
  light-isolation* tier, comparable to where 0106 places `sandbox-runtime`, not a
  replacement for microsandbox/Docker.
- **Credentials are per-session env injection** (`CreateSessionOptions.env`),
  not a boundary proxy. Simpler than microsandbox's (broken) secret proxy, but
  the secret enters the guest — the opposite of OMA's "keep secrets in the
  harness" goal and the 0109 gate. Useful as the explicit `env-plaintext`
  delivery shape 0107 names, never as proxy-grade secrets.
- **No true suspend/hibernate.** "Resume" is persistence-backed transcript
  continuation (`resumeSession()` reloads a stored session and re-reads the
  transcript), not VM state suspension. Cheap parking comes from the runtime
  being in-process, not from snapshotting.

### Action for OMA

- **Add agentOS to plan 0106** as a candidate substrate — it is currently
  missing. Classify it as the *Pi-native in-process light-isolation* tier
  (sibling to `sandbox-runtime`), with the two-tier "escalate to real sandbox"
  pattern called out.
- **Before freezing the 0107 contract vocabulary**, read agentOS's `Permissions`
  + mount-plugin + sandbox-extension design. It is the most directly applicable
  permission/mount prior art we have found and it is Pi-native.

---

## Osaurus (osaurus-ai) — Apple-Containerization Linux-VM sandbox

### What it is

A native Swift macOS agent harness (local model inference + agent loop + tools).
Only the **sandbox subsystem** is prior art for us: agents execute in an isolated
Linux microVM via Apple's
[Containerization](https://developer.apple.com/documentation/containerization)
framework. macOS 15.5+ / Apple Silicon only. This is a concrete implementation of
the Apple `container` path that 0106 listed as "track, do not probe yet."

Key locations:

- `Packages/OsaurusCore/Services/Sandbox/SandboxManager.swift` — VM lifecycle
  (actor singleton): provision, warm/cold create, boot, exec, stop, remove,
  reset.
- `Packages/OsaurusCore/Services/Sandbox/SandboxAgentProvisioner.swift` — per
  agent provisioning/cleanup.
- `Packages/OsaurusCore/Networking/HostAPIBridgeServer.swift` — host API over
  vsock-relayed Unix socket.
- `Packages/OsaurusCore/Tools/BuiltinSandboxTools.swift` — `sandbox_exec`,
  `sandbox_read_file`, path sanitizer.
- `sandbox/Dockerfile` — Alpine guest image (bash, python3, node, git,
  build-base, uv/uvx), pinned by digest and SHA-256 verified.
- `docs/SANDBOX.md`, `docs/AGENT_LOOP.md` — design docs.

### Interesting bits for OMA (overall)

1. **Host API bridge over vsock + per-agent bearer token.** The guest reaches
   host capabilities through a vsock-relayed Unix socket with a 256-bit
   per-agent token (8 MiB request cap), so the guest never touches host
   networking and **secrets stay host-side** (`HostAPIBridgeServer.swift`,
   `docs/SANDBOX.md`). This is a clean realization of OMA's "keep secrets and
   privileged actions in the harness" goal — and a more credible pattern than
   microsandbox's TLS-interception secret proxy (gated out in 0109). Worth
   recording as a design option for credential-bearing tools.

2. **Inactivity timeout instead of wall-clock.** Exec polls stdout/stderr every
   2s and kills only after N seconds of *no output* (SIGTERM → 3s grace →
   SIGKILL), plus a user `[Terminate]` button
   (`SandboxManager.swift` `waitWithInactivityTimeout`). OMA's Docker provider
   uses a wall-clock `operationTimeoutMs`; inactivity-based termination handles
   long builds far better and is worth considering for the provider contract.

3. **Warm rootfs reuse + digest-pinned guest image.** Second+ boot reuses a
   persisted ext4 rootfs instead of re-unpacking the OCI image; the image is
   pinned by digest and integrity-checked, discarded if the pinned digest
   changes (`SandboxManager.swift`, `sandbox/Dockerfile`). Mirrors our
   digest-discipline instincts and is a concrete fast-restart pattern.

4. **One long-lived VM, many agents via per-agent Linux users.** Rather than one
   sandbox per session, Osaurus boots one VM and isolates agents with
   `agent-{name}` users + mode-0700 homes under a VirtioFS workspace mount, with
   explicit per-agent teardown (kill user procs, remove home/plugins/manifest).
   A different lifecycle than OMA's one-container-per-`sesn_*`; interesting for
   density, but it trades the hard per-session boundary we currently get for
   free. Note, do not adopt for v1.

5. **Structured path-rejection that the model self-corrects on.** The path
   sanitizer returns a typed rejection with a reason (and a hint when the model
   used a host path), instead of a generic failure
   (`BuiltinSandboxTools.swift`). Small but nice for tool-error ergonomics.

### Limits as prior art

- macOS / Apple-Silicon / Apple-Containerization only — **not a server
  substrate**. A Linux server equivalent would use KVM/Firecracker/Kata/cloud
  hypervisor, not this framework.
- Desktop app, single machine, in-process orchestration; Swift not TypeScript.
- The transferable parts are *patterns* (vsock+token host bridge, inactivity
  timeout, warm rootfs, per-agent isolation, structured path rejection), not the
  substrate choice.

### Action for OMA

- **Cross-reference Osaurus in plan 0106** under Apple `container` as the
  concrete reference implementation, and capture the vsock+token host-bridge and
  inactivity-timeout patterns as provider-contract design options in 0107.

---

## Net takeaways

- The microsandbox-local decision is unaffected — both confirm the design space
  rather than redirect it.
- agentOS is the more important find: Pi-native, Apache-2.0, and it already names
  the permission + mount-plugin + lazy-escalation contract we are about to pin.
  It is a real omission from 0106.
- Osaurus contributes transferable patterns (host-side secrets via vsock+token,
  inactivity timeout, warm rootfs) even though its substrate is macOS-only.
- One recurring theme across both: a **two-tier** model — a cheap default
  execution tier plus on-demand escalation to a heavier real sandbox — is worth
  weighing against OMA's current "one provider selection per deployment" shape
  (0107), especially for cheap `requires_action` parking.
