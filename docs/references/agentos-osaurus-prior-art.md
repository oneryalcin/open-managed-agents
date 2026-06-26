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
  (`fixed tools page layout hang (#1724)`). Native Swift app; macOS 15.5+
  generally, but the sandbox subsystem requires macOS 26+ and Apple Silicon.
  Repo: <https://github.com/osaurus-ai/osaurus>.

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
- `packages/core/src/sidecar/permissions.ts` — permission serialization.
- `packages/agentos-sandbox/` — the "pair with a full sandbox" extension.
- `crates/agentos-sidecar/` — Rust transport/dispatch/ACP extension.
- `packages/secure-exec/`, `packages/posix`, `packages/python`, `packages/shell`
  — the execution substrate the kernel composes.

### Interesting bits for OMA (overall)

1. **Unified permission model with deny-capable rules.** One `Permissions` shape
   covers `fs / network / childProcess / process / env / binding`, each
   `allow|deny` with path/pattern rules (`packages/core/src/runtime.ts:184`).
   The public runtime defaults missing permissions to `allowAll`, while the
   sidecar serializer can encode explicit deny policies
   (`packages/core/src/agent-os.ts:561-564`,
   `packages/core/src/sidecar/permissions.ts:45-50`). This is a more expressive
   version of what plan 0107 is sketching, and it is the closest **Pi-native**
   reference we have for a provider permission contract. Relevant well beyond
   the sandbox: it is also a model for tool-permission / builtin-access policy
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
- **The Node/V8 isolation path is not something to trust as-is.** The
  repo-local `crates/CLAUDE.md` says the intended model is V8 isolates with
  kernel-backed builtins, but also says that path is currently broken and guest
  JavaScript still spawns real host `node` in that area
  (`crates/CLAUDE.md:7-13`). This strengthens the "study the contract, do not
  adopt as isolation" conclusion.
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
framework. The app supports macOS 15.5+, but this sandbox subsystem requires
macOS 26+ / Apple Silicon. This is a concrete implementation of the Apple
`container` path that 0106 listed as "track, do not probe yet."

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
   per-agent token (8 MiB request cap), so the guest does not need direct host
   networking (`HostAPIBridgeServer.swift`, `docs/SANDBOX.md`). This is useful
   prior art for privileged host actions. It is **not** a boundary secret-proxy
   design: Osaurus can return secrets through the bridge and inject them into
   sandbox exec env, then scrub outputs before model persistence. Treat this as
   a host-bridge pattern, not as OMA's keep-secrets-out-of-guest target.

2. **Inactivity timeout instead of wall-clock.** Exec polls stdout/stderr every
   2s and times out only after N seconds of *no output*, sending SIGTERM from
   `waitWithInactivityTimeout`; separate live/user termination paths add the
   SIGTERM -> grace -> SIGKILL behavior. OMA's Docker provider uses a wall-clock
   `operationTimeoutMs`; inactivity-based termination handles long builds far
   better and is worth considering for the provider contract.

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

## Other OMA-Relevant Patterns

These are not blockers for the `microsandbox-local` provider, but they are
worth keeping in the repo because they touch future OMA surfaces outside
sandboxing.

1. **Live session-update delivery should be tested with an observable mid-turn
   window.** agentOS has a focused regression test proving `session/update`
   events stream before prompt resolution, not batched at the end. The test
   injects latency into the second model response so the tool-call update has a
   real window to arrive before the turn resolves
   (`packages/core/tests/session-update-live.test.ts:20-42`,
   `packages/core/tests/session-update-live.test.ts:199-209`). This is the same
   testing shape OMA should use whenever SSE or runtime event delivery can
   accidentally batch.

2. **Memory should stay compact and scoped.** Osaurus splits memory into
   identity, pinned facts, per-session episodes, and transcript fallback; raw
   transcript is not injected by default, and memory can inject a compact slice
   or nothing (`docs/MEMORY.md:22-73`). This is useful prior art for future OMA
   memory work: keep durable recall separate from transcript replay, score and
   decay facts, and avoid stuffing full history into every turn.

3. **Privacy filtering needs a fail-closed invariant if OMA ever proxies cloud
   model calls.** Osaurus documents a two-layer outbound privacy filter:
   deterministic regex plus optional on-device classifier, user review, stable
   placeholders, a post-scrub leak scan that blocks sends, and a wire probe for
   the exact bytes sent to the provider (`docs/PRIVACY_FILTER.md:5-10`,
   `docs/PRIVACY_FILTER.md:86-91`). This is not current OMA scope, but the
   fail-closed post-scrub check is the important pattern if we ever handle PII
   policy at the platform boundary.

4. **Loop-control tools are useful UX, but Pi owns OMA's loop.** Osaurus uses
   global `todo`, `complete`, and `clarify` tools, then intercepts successful
   results across chat, HTTP, and plugin surfaces (`docs/AGENT_LOOP.md:25-35`,
   `docs/AGENT_LOOP.md:39-79`). This is good product UX prior art for task
   planning and explicit completion, but not something to copy directly while
   OMA delegates the agent loop to Pi.

5. **File-operation history and undo are folder-product ideas, not control-plane
   obligations.** Osaurus logs file writes/edits and some simple shell
   mutations so the user or agent can inspect and undo them
   (`docs/AGENT_LOOP.md:111-139`). Useful if OMA grows a local workspace UI, but
   outside the current Managed Agents control-plane contract.

---

## Net takeaways

- The microsandbox-local decision is unaffected — both confirm the design space
  rather than redirect it.
- agentOS is the more important find: Pi-native, Apache-2.0, and it already names
  the permission + mount-plugin + lazy-escalation contract we are about to pin.
  It is a real omission from 0106.
- Osaurus contributes transferable patterns (vsock+token host bridge,
  inactivity timeout, warm rootfs) even though its substrate is macOS-only.
- Outside sandboxing, agentOS contributes a concrete live-session-event test
  shape, while Osaurus contributes compact memory, fail-closed privacy filtering,
  loop-control UX, and file-undo patterns for future product surfaces.
- One recurring theme across both: a **two-tier** model — a cheap default
  execution tier plus on-demand escalation to a heavier real sandbox — is worth
  weighing against OMA's current "one provider selection per deployment" shape
  (0107), especially for cheap `requires_action` parking.
