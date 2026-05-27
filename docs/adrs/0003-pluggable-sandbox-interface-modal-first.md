# ADR 0003: Pluggable sandbox providers, Modal first managed remote

**Status:** Accepted, 2026-05-21

## Context

The session container is where `bash`, file ops, and code execution actually run. Anthropic's Managed Agents provisions this on their side; for our self-hosted clone, we provision it on ours.

The "runs anywhere" pitch (Modal / K8s / Docker / Fly) requires that the sandbox not be coupled to one provider's APIs. But "support every provider on day one" is a trap — we'd build the wrong abstraction by guessing what every provider needs.

Options:

- **Docker locally** — easiest to start, but the per-session-container model is the *whole point* of the architecture; building only against local Docker biases the abstractions toward "single-host, processes-as-tenants," which is the wrong direction.
- **Modal Sandboxes** — purpose-built for "spin up an isolated Linux env from a script," has a TypeScript SDK, fast cold start, no infra to host.
- **K8s pods** — most realistic for "production self-hosting," but heavy operational burden for an experiment (we'd be writing pod manifests and exec proxies before writing any agent code).

## Decision

1. **Define a sandbox provider boundary** in our codebase, owned by us. The boundary owns lifecycle; Pi's `*Operations` interfaces own per-tool shell/file behavior.
2. **First implementation for wiring/tests: guarded host passthrough.** This is not a sandbox and must never be selectable for untrusted/production prompts without an explicit unsafe opt-in. Its job is to prove Pi Operations wiring and lifecycle cleanup deterministically in local tests.
3. **First managed remote provider: Modal Sandboxes.** Modal remains the first cloud sandbox provider we target for real remote execution.
4. **First isolating provider is an explicit fork.** Choose Docker-local or Modal deliberately after the provider-neutral probe. Docker-local gives locally testable isolation without cloud credentials or cost; Modal gives the production remote shape and cost/teardown realities.
5. **Pi's default tool implementations (`bash`, `read`, `write`, etc.) get rewired** to delegate to the active provider's Operations impl instead of running on the host by default.
6. **Future implementations** (K8s pods, Fly.io machines, other remote sandbox providers) implement the same lifecycle boundary.

## Sandbox interface (sketch — to be refined when we write the first impl)

```ts
interface Sandbox {
  id: string;

  // Lifecycle
  start(opts: StartOpts): Promise<void>;
  stop(): Promise<void>;

  // File ops (back Pi's `read`/`write`/`edit`/`glob`/`grep`)
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  listDir(path: string, opts?: ListOpts): Promise<DirEntry[]>;

  // Shell
  bash(cmd: string, opts?: BashOpts): Promise<BashResult>;

  // Resources
  mount(resource: Resource): Promise<void>;
  listOutputs(): Promise<OutputFileMeta[]>;  // /mnt/session/outputs/
  downloadOutput(path: string): Promise<Uint8Array>;
}

interface StartOpts {
  image?: string;            // OCI image ref; impl-specific default
  workdir?: string;          // default /workspace
  env?: Record<string, string>;
  resources?: Resource[];    // mounted at start
}
```

## Why Modal first managed remote

- **No infra to host.** Crucial for an experiment — we're not running our own K8s cluster on day one.
- **TypeScript SDK exists.** Matches [ADR 0002](0002-typescript-end-to-end.md).
- **Fast cold start.** Per-session containers only matter if they spin up in seconds, not minutes.
- **Pricing maps cleanly to per-session billing** — useful if anyone ever runs this as a service.

This does **not** mean Modal must be the first code path we implement. A guarded passthrough provider and/or Docker-local provider can land first to prove the control-plane lifecycle and Pi Operations injection with deterministic tests. Modal is the first managed remote provider, not the only useful implementation target.

## Why passthrough is guarded, not a sandbox

Host passthrough binds agent-driven shell/file calls to the control-plane host. That is arbitrary code execution on the developer machine, test runner, or any host process that enables it. It is useful only for:

- proving Pi Operations wiring without cloud credentials,
- deterministic lifecycle tests around provision/exec/teardown,
- trusted local development where the operator explicitly accepts the risk.

The provider name and config must make the lack of isolation impossible to miss. Production/untrusted use requires an explicit unsafe opt-in if passthrough is available at all.

## Why Docker-local remains on the table

Docker-local is a better first isolating provider than host passthrough and may be a better implementation step before Modal:

- A developer can exercise a real isolation boundary locally without Modal credentials or cloud cost.
- The lifecycle and teardown bugs that matter for Modal can be tested locally first.
- It audits the provider boundary before we encode too many Modal-specific assumptions.

The tradeoff is that Docker can bias the interface toward local container semantics. Keep the provider boundary minimal and Pi-Operations-shaped so Modal still gets to audit the design.

## Why not K8s on day one

- Forces us to make pod manifest, RBAC, exec-proxy, and storage-class decisions before writing a single agent endpoint.
- We learn nothing about the *right* sandbox interface by struggling with K8s ergonomics — we just push the abstraction toward "looks like K8s exec."

## Why not Docker-local *only*

- It's a fine *second* impl (offline dev, CI), but if it's our *only* impl the interface won't survive contact with a real remote sandbox. We'd ship coupling we'd have to undo.

## Consequences

- Pi's default tool implementations are bypassed; we supply ours that talk to the active Sandbox impl. This is the largest piece of Pi-integration work in the MVP.
- Each Managed Agents session = one Sandbox instance. Lifecycle is tied to the session.
- Modal cost / quota becomes a real concern at any kind of scale; expose timeouts, idle-shutdown, and per-session limits early.
- The interface is the contract for adding more impls. **Design it before writing the second impl, not after** — the second impl is the audit.
- Resources (files, GitHub repos) attach via `mount()` — same call shape regardless of backing impl.

## Out of scope for this ADR

- The `Sandbox` interface for self-hosted-mode (Anthropic-style: where Anthropic runs the loop and *you* expose tool execution via a worker). That's a different shape — outbound worker polling rather than control-plane-initiated exec. Defer.
- Persistent volumes across sessions. MVP sandboxes are ephemeral; memory-store-style persistence is post-MVP.

## Findings (2026-05-21)

See [scratch-pi-findings.md](../scratch-pi-findings.md) for full evidence.

**The `Sandbox` interface I sketched in this ADR is unnecessary — Pi already exposes the exact abstraction.** Every built-in tool has a typed `Operations` interface that's the backend plug-in:

| Tool | Operations interface | Public custom-tool factory |
|---|---|---|
| bash | `BashOperations` | `createBashToolDefinition(cwd, { operations })` |
| read | `ReadOperations` | `createReadToolDefinition(cwd, { operations })` |
| write | `WriteOperations` | `createWriteToolDefinition(cwd, { operations })` |
| edit | `EditOperations` | `createEditToolDefinition(cwd, { operations })` |
| grep | `GrepOperations` | `createGrepToolDefinition(cwd, { operations })` |
| find | `FindOperations` | `createFindToolDefinition(cwd, { operations })` |
| ls | `LsOperations` | `createLsToolDefinition(cwd, { operations })` |

Each interface is the minimal contract for that tool's filesystem/shell backend. Example, `BashOperations`:

```ts
export interface BashOperations {
  exec: (command: string, cwd: string, options: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  }) => Promise<{ exitCode: number | null }>;
}
```

**Revised plan** (supersedes the `Sandbox interface (sketch)` section above):

1. Implement Pi's `*Operations` interfaces against each backend. Start with a guarded host-passthrough provider for wiring/tests, then the first isolating provider (Docker-local or Modal), then Modal as the managed remote.
2. Provide provider-backed `ToolDefinition` records by passing our Operations impls into Pi's `create*ToolDefinition(cwd, {operations: ...})` factories, then register them through `createAgentSession({ noTools: "builtin", tools: [...names], customTools: [...definitions] })`. This keeps the tool surface public and provider-owned without mutating `session.agent.state.tools`.
3. The single high-level `ManagedSandbox` value our codebase owns becomes a wrapper that handles the *lifecycle* (provision instance, mount resources, stop on session end) and produces the per-tool Operations impls against it. It is *not* an alternative to Pi's Operations interfaces — it sits one level above them.

**Resolved follow-up:** `tools` is a string allowlist, not a `Tool[]` slot. Use `customTools` for provider-backed `ToolDefinition`s and `tools` for the exact active tool names.

## Historical findings (post code-review, 2026-05-21; superseded in part)

Empirical verification via `scratch/04-tool-array.ts`:

- **`tools: [Tool]` does NOT work.** `tools` is `string[]` only — an *allowlist* of built-in tool names. Pre-constructed `AgentTool` objects passed in `tools: [...]` are silently ignored. Confirmed via probe — `session.state.tools` was `[]`.

- **The Operations-injection field exists on `AgentSessionConfig`, but the public helper route changed.** From `dist/core/agent-session.d.ts`:

  ```ts
  export interface AgentSessionConfig {
    // ... other fields ...

    /**
     * Override base tools (useful for custom runtimes).
     *
     * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
     * a definition-first registry even when callers provide plain AgentTool instances.
     */
    baseToolsOverride?: Record<string, AgentTool>;
  }
  ```

  `baseToolsOverride` is documented on `AgentSessionConfig`, but Cycle E.0 verified that Pi 0.75.4 does not expose or forward it through the exported session helper APIs. Treat it as an internal/low-level field unless a future SDK re-exposes it through helpers.

- **`baseToolsOverride` is on `AgentSessionConfig`, not `CreateAgentSessionOptions` or `CreateAgentSessionFromServicesOptions`.** Cycle E.0 first used `session.agent.state.tools = [...]` as a working route, but Cycle E.1 superseded it with public `customTools` registration of Operations-backed `ToolDefinition`s.

- **Reviewer's "core integration risk" concern is narrower than stated, but the precise injection point moved:** Operations-backed tools are still the correct boundary; the public install path is `customTools` plus a strict `tools` allowlist, not `createAgentSessionFromServices(... baseToolsOverride)` and not internal active-tool mutation.

**Current consumer pattern** (Cycle E.1):

```ts
import {
  createAgentSession,
  createBashToolDefinition,
  createReadToolDefinition,
  // ... etc.
} from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  model,
  sessionManager,
  noTools: "builtin",
  tools: ["bash", "read"],
  customTools: [
    createBashToolDefinition(sandboxCwd, { operations: ourModalBashOps }),
    createReadToolDefinition(sandboxCwd, { operations: ourModalReadOps }),
    // ... write/edit/find/ls.
  ],
  // ... auth/model registry/user custom tools/etc.
});
```

This supersedes the original `createAgentSession({ tools: customTools })` guess, the later `createAgentSessionFromServices(... baseToolsOverride)` plan, and the interim `session.agent.state.tools = [...]` E.0 route. The ADR direction (pluggable Operations, Modal as first managed remote) is unchanged; the precise current public injection point is now pinned by Cycle E.1.

## Findings (Cycle E planning, 2026-05-27)

Flue and OpenAI Agents both support the revised sequencing:

- Flue separates lightweight virtual/local execution from remote sandbox connectors. Its local provider is useful for trusted developer and automation workflows, while remote connectors are used when a real coding-agent environment is required.
- OpenAI Agents JS exposes a similar progression for sandbox agents: local sandbox client for development, Docker for container isolation and image parity, hosted sandbox providers for managed remote execution.

Adopt the same split:

1. **Provider-neutral probe first.** Verify the current public Pi Operations injection path with one builtin tool and a swappable Operations implementation.
2. **Guarded passthrough for deterministic lifecycle tests.** Name it as non-isolating and require explicit unsafe opt-in outside test/dev.
3. **First isolation decision.** Choose Docker-local or Modal deliberately. Docker-local gives locally testable isolation; Modal gives the production remote target.
4. **Modal remote hardening.** Measure cold start, forced sandbox death, teardown reliability, and orphan/cost behavior.

OpenAI Agents sandbox docs add four design constraints we should copy conceptually, not as an API dependency:

- **Harness and compute stay separate.** The trusted harness/control plane owns the agent loop, model calls, tool routing, approvals, tracing, recovery, and run state. The sandbox owns provider-specific execution: files, commands, packages, ports, mounts, and snapshots. This matches our control-plane/Pi-vs-sandbox split and argues against running API orchestration inside the sandbox.
- **Provider is run/session configuration, not agent identity.** OpenAI keeps the sandbox agent/manifest/capabilities stable while swapping the sandbox client and provider options per run. Mirror that: an OMA agent's persisted definition should not bake in "Docker vs Modal" unless the user explicitly makes that part of the environment/session config.
- **Separate manifest, live session, serialized state, and snapshots.** A manifest is the fresh-session workspace contract; a live sandbox session is current execution state; serialized sandbox state resumes a provider session; snapshots seed a new workspace. For OMA, this maps to future environment/session resources and prevents overloading one `resources` blob with both initial inputs and resumable state.
- **Workspace paths are portable, relative contracts.** Manifest/input paths are workspace-relative and cannot escape with absolute paths or `..`. Keep that rule for mounted resources and generated outputs so Docker-local, Modal, and future providers do not each invent path semantics.

OpenClaw prior art (checked at `OpenClaw/OpenClaw@3e351b71`) adds useful sandbox-provider details, but not a framework to copy:

- **Backend handle before second real provider.** OpenClaw's sandbox backend handle includes `buildExecSpec`, `finalizeExec`, `runShellCommand`, optional `createFsBridge`, runtime metadata, and capabilities (`src/agents/sandbox/backend-handle.types.ts:40`). Before Docker-local or Modal, evolve our provider boundary toward that shape rather than a bare `exec(command)` API. Remote backends need exec specs and finalizers for cleanup tokens; file operations need an explicit bridge.
- **Separate backend, scope, and workspace access.** OpenClaw treats backend choice (`docker`, `ssh`, managed remote), sandbox scope (`agent`, `session`, `shared`), and workspace access (`none`, `ro`, `rw`) as independent configuration dimensions (`docs/gateway/sandboxing.md:60`, `docs/gateway/sandboxing.md:68`). Do not let "Docker vs Modal" implicitly decide lifecycle scope or file-write policy.
- **Env and path policies are distinct.** OpenClaw has explicit env sanitization (`src/agents/sandbox/sanitize-env-vars.ts:1`) and separate filesystem bridge/path containment logic. Our E.1 deny-by-default env allowlist is stricter, but Docker/Modal will still need mount/path translation rather than a single host-root jail.
- **Tool-surface control must stay fail-closed.** OpenClaw converts its registered tools to Pi `customTools`, passes an exact `tools` name allowlist, and then calls `setActiveToolsByName(...)` (`src/agents/pi-embedded-runner/run/attempt.ts:2735`). We should keep the E.1 exact active-tool assertion and unknown-tool rejection; "bash ran" is not enough to prove sandboxing.
- **Provider-owned builtins through `customTools`.** OpenClaw always routes its tool implementations through Pi `customTools` so policy filtering and sandbox integration stay provider-owned (`src/agents/pi-embedded-runner/tool-split.ts:5`). Cycle E.1 verified the same public shape works here without reimplementing Pi's tool semantics: Pi's `create*ToolDefinition(cwd, {operations})` factories produce `ToolDefinition`s that can be registered as custom tools under the public builtin names.
- **Do not copy the embedded runner.** OpenClaw's channel delivery, transcript repair, tool-result guard, compaction, and reply plumbing solve its product surface. Importing that stack would add the wrong abstraction pressure here. Lift the backend/lifecycle lessons only.

## Findings (Cycle E.0 probe, 2026-05-27)

Probe: `scratch/19-e0-builtin-operations-injection.ts`.

Findings:

- **`baseToolsOverride` is not a public helper path in Pi 0.75.4.** `AgentSessionConfig` still has `baseToolsOverride`, but neither `CreateAgentSessionOptions` nor `CreateAgentSessionFromServicesOptions` exposes it, and neither exported helper forwards it at runtime.
- **The interim internal injection path works:** create the session normally, then replace the active tool list with `session.agent.state.tools = [createBashTool(cwd, { operations })]`. A live Haiku run invoked `BashOperations.exec` exactly once and the model observed the returned tool output. Cycle E.1 later superseded this with public `customTools` registration.
- **Pi passes host environment data into `BashOperations.exec`.** The probe recorded 124 env keys and detected secret-like names. Provider implementations must not blindly forward `options.env` into passthrough, Docker, or Modal. Apply an allowlist/drop policy at the provider boundary.
- **The internal injection path would have to fail closed.** `session.agent.state.tools = [...]` is internal coupling. If a future Pi SDK changed that state shape and our replacement stopped taking effect, Pi could fall back to its default builtin bash implementation: host execution with host env. That risk is why E.1 moved to public `customTools` registration; the runtime still keeps provider-invocation accounting as defense in depth.
- **File path containment is separate from env filtering.** Pi resolves model-supplied paths to absolute paths before calling file Operations; providers must still reject paths outside the workspace root. Env allowlisting protects bash. Path jail protects read/write/edit/find/ls.
- **Grep is not sandbox-safe through Operations in Pi 0.75.4.** `createGrepTool` accepts `GrepOperations`, but its implementation still runs host `rg` and only uses Operations for directory checks/context reads. Do not enable grep as a sandbox-backed builtin until we own or upstream a fully delegated grep implementation. Grep-like capability is still available through the policed bash path.

If a future Pi SDK re-exposes `baseToolsOverride` through `createAgentSessionFromServices`, we can consider it without changing the provider boundary. The provider still owns lifecycle; Pi Operations still own per-tool calls.

## Findings (Cycle E.1 public customTools probe, 2026-05-27)

Probe: `scratch/21-e2-define-tool-builtins.ts`.

Findings:

- **A custom tool can occupy the public builtin name.** `createAgentSession({ noTools: "builtin", tools: ["bash"], customTools: [defineTool({ name: "bash", ... })] })` activated exactly `["bash"]`, exposed a tool definition for `bash`, and emitted Pi events with `toolName: "bash"`.
- **The custom-tool path streams.** Pi passed `onUpdate` into `ToolDefinition.execute(...)`, and the probe observed `tool_execution_update` before `tool_execution_end`.
- **The cleaner route does not require owning Pi's bash semantics.** Pi already exports `createBashToolDefinition`, `createReadToolDefinition`, `createWriteToolDefinition`, `createEditToolDefinition`, `createFindToolDefinition`, and `createLsToolDefinition`. Register those definitions through `customTools` with provider Operations. That uses public APIs, preserves Pi's tool descriptions/rendering/execution semantics, and avoids internal `session.agent.state.tools` mutation.
- **The bypass class is designed out, not merely detected.** Pi executes the registered `ToolDefinition`; the provider Operations live inside that execute body. Keep invocation accounting and gated release as defense in depth, but they are no longer the primary containment mechanism.

Updated implementation direction:

```ts
const sandboxTools = [
  createBashToolDefinition("/workspace", { operations: provider.operations.bash }),
  createReadToolDefinition("/workspace", { operations: provider.operations.read }),
  // ... write/edit/find/ls.
];

const { session } = await createAgentSession({
  model,
  noTools: "builtin",
  tools: ["bash", "read", "write", "edit", "find", "ls", ...userToolNames],
  customTools: [...sandboxTools, ...userCustomTools],
  sessionManager,
});
```

`grep` remains disabled. The current Pi `createGrepToolDefinition` still delegates part of its behavior to host `rg`, so grep-like capability stays routed through policed `bash` until we own or upstream a fully delegated grep implementation.
