# ADR 0003: Pluggable sandbox interface, Modal first

**Status:** Accepted, 2026-05-21

## Context

The session container is where `bash`, file ops, and code execution actually run. Anthropic's Managed Agents provisions this on their side; for our self-hosted clone, we provision it on ours.

The "runs anywhere" pitch (Modal / K8s / Docker / Fly) requires that the sandbox not be coupled to one provider's APIs. But "support every provider on day one" is a trap — we'd build the wrong abstraction by guessing what every provider needs.

Options:

- **Docker locally** — easiest to start, but the per-session-container model is the *whole point* of the architecture; building only against local Docker biases the abstractions toward "single-host, processes-as-tenants," which is the wrong direction.
- **Modal Sandboxes** — purpose-built for "spin up an isolated Linux env from a script," has a TypeScript SDK, fast cold start, no infra to host.
- **K8s pods** — most realistic for "production self-hosting," but heavy operational burden for an experiment (we'd be writing pod manifests and exec proxies before writing any agent code).

## Decision

1. **Define a `Sandbox` interface** in our codebase, owned by us.
2. **First implementation: Modal Sandboxes.**
3. **Pi's default tool implementations (`bash`, `read`, `write`, etc.) get rewired** to delegate to the active `Sandbox` impl instead of running on the host.
4. **Future implementations** (Docker-local for offline dev, K8s pods for production self-hosting, Fly.io machines) implement the same interface.

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

## Why Modal first

- **No infra to host.** Crucial for an experiment — we're not running our own K8s cluster on day one.
- **TypeScript SDK exists.** Matches [ADR 0002](0002-typescript-end-to-end.md).
- **Fast cold start.** Per-session containers only matter if they spin up in seconds, not minutes.
- **Pricing maps cleanly to per-session billing** — useful if anyone ever runs this as a service.

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

1. Implement Pi's `*Operations` interfaces against each backend — Modal first (`createModalBashOperations`, `createModalReadOperations`, etc.). Model on Pi's `createLocalBashOperations`.
2. Provide a `createModalSandboxTools(cwd, modalSandbox)` factory that produces a full `Tool[]` array by passing our Operations impls into Pi's `create*Tool(cwd, {operations: ...})` factories.
3. The single high-level `ManagedSandbox` value our codebase owns becomes a wrapper that handles the *lifecycle* (provision Modal sandbox, mount resources, stop on session end) and produces the per-tool Operations impls against it. It is *not* an alternative to Pi's Operations interfaces — it sits one level above them.

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

This supersedes the `createAgentSession({ tools: customTools })` approach mentioned in the original ADR text. The ADR direction (pluggable Operations, Modal first) is unchanged; the precise injection point is now pinned.
