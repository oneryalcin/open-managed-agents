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
2. **First implementation for wiring/tests: guarded host passthrough.** This is not a sandbox and must never be selectable for untrusted/production prompts without an explicit unsafe opt-in. Its job is to prove `baseToolsOverride` wiring and lifecycle cleanup deterministically in local tests.
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

- proving `baseToolsOverride` and Pi Operations wiring without cloud credentials,
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

| Tool | Operations interface | Factory |
|---|---|---|
| bash | `BashOperations` | `createBashTool(cwd, { operations })` |
| read | `ReadOperations` | `createReadTool(cwd, { operations })` |
| write | `WriteOperations` | `createWriteTool(cwd, { operations })` |
| edit | `EditOperations` | `createEditTool(cwd, { operations })` |
| grep | `GrepOperations` | `createGrepTool(cwd, { operations })` |
| find | `FindOperations` | `createFindTool(cwd, { operations })` |
| ls | `LsOperations` | `createLsTool(cwd, { operations })` |

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
2. Provide provider-backed tool factories that produce `baseToolsOverride` records by passing our Operations impls into Pi's `create*Tool(cwd, {operations: ...})` factories.
3. The single high-level `ManagedSandbox` value our codebase owns becomes a wrapper that handles the *lifecycle* (provision instance, mount resources, stop on session end) and produces the per-tool Operations impls against it. It is *not* an alternative to Pi's Operations interfaces — it sits one level above them.

**Follow-up question (raised in scratch-pi-findings.md):** Can `createAgentSession({ tools })` accept a `Tool[]` array directly (constructed via `create*Tool(cwd, {operations})`)? Or only string-names? If only string-names, we'll need to inject our Operations through `ToolsOptions` (the per-tool options map on the SDK config). Verify in Task 1 smoke test.

## Findings (post code-review, 2026-05-21)

Empirical verification via `scratch/04-tool-array.ts`:

- **`tools: [Tool]` does NOT work.** `tools` is `string[]` only — an *allowlist* of built-in tool names. Pre-constructed `AgentTool` objects passed in `tools: [...]` are silently ignored. Confirmed via probe — `session.state.tools` was `[]`.

- **The official Operations-injection API exists, just one layer down.** From `dist/core/agent-session.d.ts`:

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

  `baseToolsOverride` is **explicitly documented for the custom-runtime use case** — exactly what we need. The keys are built-in tool names (`"bash"`, `"read"`, `"write"`, etc.); the values are `AgentTool` instances constructed via `createBashTool(cwd, {operations: ourOps})` etc. The synthesis-into-ToolDefinitions happens internally.

- **`baseToolsOverride` is on `AgentSessionConfig`, not `CreateAgentSessionOptions`.** So we use the lower-level `createAgentSessionFromServices` (also exported from `pi-coding-agent`) rather than the top-level `createAgentSession`. This is a documented public API path, not a hack.

- **Reviewer's "core integration risk" concern is therefore narrower than stated:** the API exists and is named for our use case. The residual unknowns are runtime behavior of `baseToolsOverride` end-to-end (does our `BashOperations.exec` actually get called when the model invokes bash?), and lifecycle plumbing (resource mounting, sandbox teardown) — both deferred to Modal-sandbox-impl work.

**Revised consumer pattern** (will go in `src/engine/pi/sandbox/` when we implement):

```ts
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createBashTool,
  createReadTool,
  // ... etc.
} from "@earendil-works/pi-coding-agent";

const services = await createAgentSessionServices({ cwd: sandboxCwd });
const { session } = await createAgentSessionFromServices({
  services,
  sessionManager,
  sessionStartEvent: { /* ... */ },
  baseToolsOverride: {
    bash: createBashTool(sandboxCwd, { operations: ourModalBashOps }),
    read: createReadTool(sandboxCwd, { operations: ourModalReadOps }),
    write: createWriteTool(sandboxCwd, { operations: ourModalWriteOps }),
    edit: createEditTool(sandboxCwd, { operations: ourModalEditOps }),
    grep: createGrepTool(sandboxCwd, { operations: ourModalGrepOps }),
    find: createFindTool(sandboxCwd, { operations: ourModalFindOps }),
    ls: createLsTool(sandboxCwd, { operations: ourModalLsOps }),
  },
  // ... model, customTools, etc.
});
```

This supersedes the `createAgentSession({ tools: customTools })` approach mentioned in the original ADR text. The ADR direction (pluggable Operations, Modal as first managed remote) is unchanged; the precise injection point is now pinned.

## Findings (Cycle E planning, 2026-05-27)

Flue and OpenAI Agents both support the revised sequencing:

- Flue separates lightweight virtual/local execution from remote sandbox connectors. Its local provider is useful for trusted developer and automation workflows, while remote connectors are used when a real coding-agent environment is required.
- OpenAI Agents JS exposes a similar progression for sandbox agents: local sandbox client for development, Docker for container isolation and image parity, hosted sandbox providers for managed remote execution.

Adopt the same split:

1. **Provider-neutral probe first.** Verify `createAgentSessionFromServices + baseToolsOverride` with one builtin tool and a swappable Operations implementation.
2. **Guarded passthrough for deterministic lifecycle tests.** Name it as non-isolating and require explicit unsafe opt-in outside test/dev.
3. **First isolation decision.** Choose Docker-local or Modal deliberately. Docker-local gives locally testable isolation; Modal gives the production remote target.
4. **Modal remote hardening.** Measure cold start, forced sandbox death, teardown reliability, and orphan/cost behavior.
