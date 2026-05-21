# Scratch: Pi 0.75.4 empirical findings

Working notes capturing what we learn from probing Pi's actual behavior. Findings here feed back into ADRs 0001/0003/0005. Volatile — once a finding is incorporated into an ADR, the entry here can be left as-is but the ADR is the source of truth.

---

## Q3 — AgentTool interface + custom-tool registration

**Status:** RESOLVED 2026-05-21 (Task 4)
**Source:** type inspection of `node_modules/@earendil-works/pi-coding-agent@0.75.4` and `pi-agent-core` (nested dep). No API calls.

### Package architecture (unexpected)

Pi has three layers, not one:

```
@earendil-works/pi-coding-agent  ← the npm package we install (CLI + high-level SDK)
        └─ depends on ─┐
@earendil-works/pi-agent-core    ← agent loop, AgentLoopConfig, beforeToolCall/afterToolCall hooks
        └─ depends on ─┐
@earendil-works/pi-ai            ← Tool/AgentTool type, streamSimple
```

Implication: our integration may need to depend directly on `pi-agent-core` if we need agent-loop hooks (e.g., `beforeToolCall` for permission policies) that `pi-coding-agent`'s SDK doesn't re-export. For MVP, `pi-coding-agent` is sufficient.

### Built-in tools — pluggable backend interface

Every built-in tool exposes a typed `Operations` interface that's the swap-in backend. From `dist/core/tools/index.d.ts` (line 1–9) and `dist/core/tools/bash.d.ts`:

| Tool | Operations interface | Factory |
|---|---|---|
| bash | `BashOperations` | `createBashTool(cwd, { operations })` |
| read | `ReadOperations` | `createReadTool(cwd, { operations })` |
| write | `WriteOperations` | `createWriteTool(cwd, { operations })` |
| edit | `EditOperations` | `createEditTool(cwd, { operations })` |
| grep | `GrepOperations` | `createGrepTool(cwd, { operations })` |
| find | `FindOperations` | `createFindTool(cwd, { operations })` |
| ls | `LsOperations` | `createLsTool(cwd, { operations })` |

`BashOperations` shape (from `bash.d.ts`):

```ts
export interface BashOperations {
  exec: (command: string, cwd: string, options: {
    onData: (data: Buffer) => void;     // streaming output
    signal?: AbortSignal;                // cancellation
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  }) => Promise<{ exitCode: number | null }>;
}
```

`createLocalBashOperations({shellPath})` is Pi's default impl; we model our Modal/K8s/Docker impls on it.

**ADR 0003 implication:** The `Sandbox` interface I sketched is unnecessary. We implement Pi's `*Operations` interfaces directly. The Sandbox value our codebase owns becomes a *factory* that knows how to:
- Provision the backing instance (start a Modal sandbox, stop on session end, mount resources)
- Produce the per-tool `Operations` implementations against that instance

### Custom tools — registered via extensions, NOT `createAgentSession({tools})`

The `tools` parameter on `createAgentSession({ tools: [...] })` accepts only built-in tool *names*: `"read"|"bash"|"edit"|"write"|"grep"|"find"|"ls"` (from `tools/index.d.ts` line 21).

Custom tools register through Pi's extensions system. From `examples/sdk/06-extensions.ts`:

> ⚠️ **Superseded by the "Follow-up questions raised — RESOLVED via Probe 04" section near the bottom of this doc.** The extension-based path below works but is unnecessarily ceremonious; `customTools: [defineTool(...)]` + `noTools: "builtin"` on `CreateAgentSessionOptions` is the simpler SDK-level path Pi expects. Read the Probe 04 section before consuming this snippet.

```ts
pi.registerTool({
  name: "ask_user",
  label: "Ask User",
  description: "Block until the user answers",
  parameters: Type.Object({ question: Type.String() }),
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    // ...
    return { content: [{ type: "text", text: result }], details: {} };
  },
});
```

**Critical: `signal: AbortSignal` is the third parameter to `execute`.** This is Pi's cancellation primitive — when `session.abort()` fires, the signal aborts. Our blocking-async pattern wires `signal.addEventListener("abort", ...)` to reject the pending Promise.

### Result shape

`execute` returns:
```ts
{
  content: (TextContent | ImageContent)[],
  details: unknown,    // tool-specific render metadata
  isError?: boolean,   // surface as error to model
  terminate?: boolean, // hint to end the turn
}
```

Errors are surfaced via `{ isError: true }`. **Throwing from `execute` — pending empirical test (Task 3).** Strong hint from `pi-agent-core/dist/types.d.ts` `StreamFn` docstring ("Must not throw or return a rejected promise...failures must be encoded in the returned stream via protocol events") that thrown errors are caught and converted to error results, but that contract is for `StreamFn`, not `Tool.execute`. Verify.

### Hook surface for `always_ask` permission gating

`AgentLoopConfig.beforeToolCall(ctx)` returns `{ block?: boolean, reason?: string }`. Blocked tools emit an error result with `reason` text. From `pi-agent-core/dist/types.d.ts`:

> Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead. `reason` becomes the text shown in that error result.

Also exposed at the extension level via `pi.on("tool_call", async (event) => { return { block: true, reason: "..." }; })`.

This is the implementation surface for Managed Agents `permission_policy: always_ask`.

### Streaming tool output

`BashOperations.exec` has `onData: (data: Buffer) => void`. Custom tools' `execute` receives `onUpdate` (4th param). Pi can stream tool output progressively — unlocks Managed Agents `tool_execution_update`-style events for clients.

### Follow-up questions raised — RESOLVED via Probe 04 (`scratch/04-tool-array.ts`)

**Triggered by code-review (HIGH 3): "Pi sandbox-injection assumption is not proven enough to be an accepted ADR."**

Empirical findings:

| Attempt | Result |
|---|---|
| `tools: [Tool]` (pre-constructed `AgentTool[]` via `createBashTool(cwd, {operations})`) | **Silently ignored.** `session.state.tools` was `[]`. `tools` is `string[]` only — an allowlist of built-in tool names. |
| `customTools: [ToolDefinition]` + `tools: []` | Registered nothing — the empty `tools` allowlist filters customTools too. |
| `customTools: [defineTool({...})]` + `noTools: "builtin"` | **WORKS.** `session.state.tools` shows `[ask_me]`, `execute()` is called when prompted, `tool_execution_start/_end` events fire. |

Canonical paths (confirmed via type definitions in `dist/core/sdk.d.ts` and `dist/core/agent-session.d.ts`):

| Use case | API | Where |
|---|---|---|
| Custom tool with blocking-async `execute()` (Managed Agents `agent.custom_tool_use` pattern) | `customTools?: ToolDefinition[]` + `noTools: "builtin"` | `CreateAgentSessionOptions` (top-level `createAgentSession`) |
| Built-in tool backend override (Modal/K8s/Docker sandbox) | `baseToolsOverride?: Record<string, AgentTool>` | `AgentSessionConfig` (lower-level `createAgentSessionFromServices`). Docstring: "Override base tools (useful for custom runtimes)." |
| Tool name allowlist (built-ins only) | `tools?: string[]` (e.g. `["read", "bash"]`) | `CreateAgentSessionOptions` |
| Suppress built-ins | `noTools?: "all" \| "builtin"` | `CreateAgentSessionOptions` |

**Architectural implications:**

- **ADR 0005 simplifies:** custom tools register via `customTools: [defineTool(...)]` directly on `createAgentSession`. No extension factory ceremony. Same blocking-async-Promise pattern in `execute()`; same AbortSignal propagation (Probe 02); same error-surfacing (Probe 03). Update ADR 0005 accordingly.
- **ADR 0003 is now empirically grounded:** `baseToolsOverride` is the documented API for Operations injection at the built-in-tool level. We use `createAgentSessionFromServices` (one layer below `createAgentSession`) to access this. Probe deferred to Modal-sandbox implementation.
- **`tools` allowlist warning:** `tools: []` is a "deny all" allowlist that filters customTools too. To suppress built-ins while keeping custom tools, use `noTools: "builtin"`.

---

## Task 1 — Smoke test (RESOLVED 2026-05-21)

**Status:** RESOLVED.
**Script:** `scratch/01-smoke.ts`.
**Result:** Pi boots and round-trips on `ANTHROPIC_API_KEY` env alone — no `pi login` required.

Key observations:

- **Auth path:** `AuthStorage.create()` + `ModelRegistry.create(authStorage)` discovers ~480 models across providers (anthropic, google, groq, openai, openrouter, together, deepseek). For our project we only need the `anthropic/*` ones; the rest come from the user's pre-existing Pi config (`~/.pi/agent/`).
- **Default tools when `tools` is unspecified:** `["read", "bash", "edit", "write"]` — 4 tools. To get a tool-less session, pass `tools: []` explicitly. (Confirms ADR-0003 plan: we'll override Pi's default tool factories with our Operations-plugged versions.)
- **Event taxonomy for a tool-less single-prompt response** (Haiku 4.5, "say hello from pi"):

  | Event type | Count |
  |---|---|
  | `agent_start` | 1 |
  | `agent_end` | 1 |
  | `turn_start` | 1 |
  | `turn_end` | 1 |
  | `message_start` | 2 (user + assistant) |
  | `message_end` | 2 |
  | `message_update` | 4 (text deltas + lifecycle) |

  No `tool_execution_*` events for tool-less prompts. We'll see those in Task 2 (abort probe with a custom tool).
- **`sessionId`** is UUIDv7 format (`019e4a61-a599-7670-bf42-f47f26d62392`). Maps cleanly to our Managed Agents `sevt_…` / `session_…` ID convention via simple prefixing.
- **Duration:** ~2.5s end-to-end (Haiku, no tools, single short prompt, including Pi boot overhead).
- **Cost:** below 0.1 cents (Haiku for a single trivial round-trip).

**Architectural implication:** the boot pattern is clean. Our control plane's "create session" handler reduces to ~20 lines of Pi setup + the auth/registry plumbing.

---

## Q1 — `session.abort()` mid-custom-tool (RESOLVED 2026-05-21)

**Status:** RESOLVED.
**Script:** `scratch/02-abort.ts`.
**Result:** Pi propagates `session.abort()` to in-flight tools via the `AbortSignal` passed to `execute()`. Sub-millisecond from `abort()` call to `signal` firing.

Observed sequence (timestamps from probe run):

```
+1325ms  event: tool_execution_start
+1326ms  tool.execute() called: signal.aborted=false
+1527ms  session.abort() called
+1527ms  tool: signal abort event fired (signal.aborted=true)   ← <1ms after abort
+1527ms  tool: caught during await: aborted via signal
+1528ms  event: tool_execution_end
+1529ms  event: agent_end
+1529ms  session.abort() resolved
+1529ms  session.prompt() resolved (NOT threw)
```

Findings:

- **`AbortSignal` is `undefined`-checked.** Pi *might* not pass a signal in some configurations (the type is `signal?: AbortSignal`). The probe handled `if (!signal)` defensively — in this run signal was always defined. Treat as nullable when implementing.
- **`signal.aborted` is `true`** at the moment the `abort` listener fires.
- **Re-throwing `AbortError` from `execute()` is handled gracefully.** Pi catches, emits `tool_execution_end`, then `agent_end`. No unhandled rejection, no session crash.
- **`session.prompt()` resolves** rather than throws. So our control-plane caller of `prompt()` doesn't need a special abort-handling code path.
- **`session.isStreaming` returns to `false`** post-abort. Session is reusable.

**Architectural implication for ADR 0005:** the blocking-async-tool pattern is fully sound. Our pending-call map's cleanup wires `signal.addEventListener("abort", () => { pendingToolCalls.delete(id); reject(new DOMException(...)); }, { once: true })`. Pi does the rest.

---

## Q2 — `AgentTool` throw behavior (RESOLVED 2026-05-21)

**Status:** RESOLVED.
**Script:** `scratch/03-throw.ts`.
**Result:** Pi catches synchronous and async errors from `execute()` and surfaces them to the model as a `toolResult` message with `isError: true`. Pi does **not** retry — retry is the model's decision based on its system prompt and the error content.

Observed message history when `execute()` throws `new Error("synthetic test error from probe-03")`:

```jsonc
[
  { role: "user",       content: [{ type: "text", text: "Call the explode tool ..." }] },
  { role: "assistant",  content: [{ type: "toolCall", id: "toolu_01C6...", name: "explode",
                                    arguments: { marker: "probe-03" } }] },
  { role: "toolResult", toolCallId: "toolu_01C6...", toolName: "explode",
                        content: [{ type: "text", text: "synthetic test error from probe-03" }],
                        details: {}, isError: true },                                              // ← Pi's conversion
  { role: "assistant",  content: [{ type: "text", text: "The `explode` tool threw a synthetic test error ..." }] }
]
```

Findings:

- **Thrown `Error.message` becomes the `text` of the tool result's `content[0]`.** So whatever string we throw is what the model sees. Implication: throw human-readable error messages.
- **`isError: true`** is set automatically on the toolResult.
- **Pi does NOT retry the tool call** (`callCount === 1`). The model received the error and decided what to do next (in our case, explained it and stopped, per system prompt).
- **`session.prompt()` resolves normally.** Tool errors don't propagate as rejected Promises.
- **`tool_execution_end` event carries `isError: true`** on its payload. We can use this directly when translating to Managed Agents `agent.tool_result` events.
- **Two error-signaling paths from `execute()`:**
  1. **Throw** — Pi catches, sets `isError: true`, uses `error.message` as content text.
  2. **Return** `{ content: [...], details: {}, isError: true }` — explicit error result with structured content.

  We'll prefer **path 2 (explicit return)** for tools we control, because it gives us control over content shape (multi-block, structured, etc.). **Path 1 (throw)** is the safety net for unexpected exceptions.

**Architectural implication for ADR 0005:** when the Managed Agents API caller posts `user.custom_tool_result` with `is_error: true`, our `execute()` body should resolve the Promise with `{content: event.content, details: {}, isError: true}` (path 2), not reject it. Rejecting would still work (Pi catches), but loses the structured content.

---

## Cumulative — what's now decided vs what's open

| Question | Status | Where resolved |
|---|---|---|
| Q3: AgentTool interface shape + custom-tool registration mechanism | RESOLVED | Type inspection + `examples/sdk/06-extensions.ts` |
| Auth path (`ANTHROPIC_API_KEY` env vs `pi login`) | RESOLVED | Probe 01 |
| Default `tools` list when unspecified | RESOLVED | Probe 01 (`["read", "bash", "edit", "write"]`) |
| Event taxonomy for a tool-less prompt | RESOLVED | Probe 01 |
| Event taxonomy for tool calls | RESOLVED | Probes 02 + 03 (`tool_execution_start`/`_end`) |
| Q1: `session.abort()` cancels in-flight tools? | RESOLVED YES | Probe 02 |
| Q2: thrown error from `execute()` retried / surfaced / aborted? | RESOLVED — surfaced as `isError: true` toolResult; not retried | Probe 03 |
| Can `createAgentSession({tools})` accept `Tool[]` instead of string names? | OPEN | Defer to Sandbox-impl work |
| MCP tool integration shape | OPEN | Post-MVP |
| How `beforeToolCall` permission-policy hook composes with extension-registered custom tools | OPEN | Defer to permission-policies work |
