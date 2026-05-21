# ADR 0005: Custom tools as blocking async functions

**Status:** Accepted, 2026-05-21

## Context

Managed Agents has a **custom tool** pattern: the agent decides to call a tool, the session goes `idle` with `stop_reason.type === "requires_action"`, the API caller (your orchestrator) executes the tool, and posts back a `user.custom_tool_result` event. The agent then resumes.

Pi's tool model is different. An `AgentTool` is an async function the engine *awaits*. There is no built-in "tool is suspended, here's the API to inject a result later" primitive.

So how do we implement Managed Agents custom tools on Pi?

## Decision

Implement Managed Agents custom tools as Pi `AgentTool` async functions that:

1. **Emit** an `agent.custom_tool_use` SSE event on the session's stream.
2. **Register** a resolver in a process-local `Map<toolUseId, (result) => void>`.
3. **Return** a `Promise<ToolResult>` that resolves when the resolver is called.

When the API caller posts `user.custom_tool_result` (carrying the `custom_tool_use_id` wire field — see Findings below for why this is NOT `tool_use_id`), the control plane looks up the resolver and calls it. Pi's loop unblocks naturally — from Pi's perspective, the async function just took a long time to return.

## Why this works

Pi doesn't *call back* to ask for a tool result. It **awaits the async function**. That tiny semantic difference is everything: it means the function can block on *anything* — an HTTP webhook, a user click in a UI, a Slack reply, a queue message — and Pi waits patiently. We're using JavaScript's `Promise` as the cross-process synchronization primitive.

This is **the same trick MCP servers use**: their async transport blocks until the response arrives. We're routing through SSE instead of an MCP transport, but the loop's view is identical.

## Sketch

```ts
const pendingToolCalls = new Map<string, {
  resolve: (result: ToolResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}>();

function makeCustomTool(def: CustomToolDef, sessionId: string): AgentTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.input_schema,
    async execute(input) {
      const toolUseId = `tu_${randomId()}`;

      sseEmit(sessionId, {
        type: "agent.custom_tool_use",
        id: toolUseId,
        name: def.name,
        input,
      });

      return new Promise<ToolResult>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            pendingToolCalls.delete(toolUseId);
            reject(new Error(`custom tool ${def.name} timed out`));
          },
          def.timeout_ms ?? DEFAULT_CUSTOM_TOOL_TIMEOUT_MS,
        );
        pendingToolCalls.set(toolUseId, { resolve, reject, timer });
      });
    },
  };
}

// On POST /v1/sessions/{id}/events with type === "user.custom_tool_result":
// The wire field is `custom_tool_use_id` — NOT `tool_use_id`.
// `tool_use_id` is the field on `user.tool_confirmation`, a separate event
// for permission gating. Conflating them is a wire-compat bug.
function handleCustomToolResult(event: UserCustomToolResultEvent) {
  const pending = pendingToolCalls.get(event.custom_tool_use_id);
  if (!pending) {
    throw new HttpError(404, `no pending tool call: ${event.custom_tool_use_id}`);
  }
  clearTimeout(pending.timer);
  pendingToolCalls.delete(event.custom_tool_use_id);
  if (event.is_error) {
    pending.resolve({ isError: true, content: event.content });  // surface to model, don't reject
  } else {
    pending.resolve({ isError: false, content: event.content });
  }
}
```

## Consequences

- **Pending-call map is process-local.** If the control plane crashes mid-call, the resolver is gone and Pi waits forever (until its own timeout). MVP: accept this. Post-MVP: persist pending calls to SQLite, restore on boot, time out abandoned ones.
- **Timeouts are mandatory.** A custom tool that never gets a result will hang Pi's loop forever. Every `AgentTool` must enforce a timeout, even if the API caller specified `null`.
- **Concurrency is free.** Multiple custom tools can be in-flight in one session (e.g., parallel `agent.custom_tool_use` calls from one assistant turn). The Map handles this naturally — one entry per `toolUseId`.
- **Same shape as MCP** (post-MVP). When we add MCP tool support, MCP tools are *also* async functions Pi awaits. The mental model carries over.
- **Horizontal scaling caveat.** A session is bound to one control-plane process for the duration of any in-flight tool call. To scale horizontally, we need sticky session routing or externalize the pending-call map (Redis, Postgres). Not MVP.
- **Error semantics.** When a tool result has `is_error: true`, we resolve (not reject) the Promise with `{isError: true, content}`. Pi's tool layer is responsible for surfacing it to the model. Rejecting the Promise might cause Pi to retry or abort — undesired.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Patch Pi to add a "tool_result injection" API** | Forks the engine. [ADR 0001](0001-use-pi-agent-sdk-as-engine.md) commits to changing Pi *configuration*, not Pi *code*. |
| **Run custom tools inside the sandbox via an out-of-band channel** | Defeats the purpose — custom tools exist to keep secrets and side effects on the *orchestrator* side, not in the sandbox. The whole point is that the API caller's auth/credentials never enter the agent's container. |
| **Use Pi's extensions system** | Extensions look like slash-command interactions, not tool execution proxies. Wrong shape. |
| **Use Pi's MCP support to forward to a "fake" MCP server we run** | Adds an entire MCP transport for no benefit. The Promise-based approach is simpler and doesn't require speaking MCP. |

## Open questions

- Does Pi expose a hook to *cancel* an in-flight tool when the session is interrupted (`session.abort()`)? If yes, we need to wire `abort()` → reject all pending tool Promises. If not, an interrupted session might leave pending entries. Verify.
- How does Pi handle a thrown error from an `AgentTool`? Does it retry, surface to the model, or abort the session? Affects our error-handling design.

## Findings (2026-05-21)

See [scratch-pi-findings.md](../scratch-pi-findings.md) for full evidence.

**Registration mechanism — SUPERSEDED by `## Findings (post code-review, 2026-05-21)` below.**

This block originally documented an extension-based registration path (`DefaultResourceLoader` + `extensionFactories: [(pi) => pi.registerTool({...})]`) based on `examples/sdk/06-extensions.ts`. **That path works but is unnecessarily ceremonious.** Probe 04 (`scratch/04-tool-array.ts`) confirmed `customTools: ToolDefinition[]` on `CreateAgentSessionOptions` — combined with `noTools: "builtin"` to suppress defaults — is the SDK-level path Pi expects for our use case. **Use the corrected pattern in the post-code-review Findings section below; the extension-based mechanism described in this paragraph is no longer the recommended path.**

**`signal: AbortSignal` is the 3rd parameter to `execute`.** This closes the first open question above: `session.abort()` propagates via this signal. Our blocking-async pattern wires `signal.addEventListener("abort", onAbort, { once: true })` to reject the pending Promise and clear the resolver. The original ADR sketch was directionally right; the closure shape just changes slightly:

```ts
async execute(toolCallId, params, signal, onUpdate, ctx) {
  const toolUseId = `tu_${randomId()}`;
  sseEmit(sessionId, {
    type: "agent.custom_tool_use",
    id: toolUseId, name: def.name, input: params,
  });
  return new Promise<ToolResult>((resolve, reject) => {
    const onAbort = () => {
      pendingToolCalls.delete(toolUseId);
      reject(new DOMException("session aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(/* ... */);
    pendingToolCalls.set(toolUseId, { resolve, reject, timer, onAbort });
  });
}
```

**Result shape:** `execute` returns `{ content: (TextContent | ImageContent)[], details: unknown, isError?: boolean, terminate?: boolean }`. Errors are signaled via `{ isError: true }` on the result.

**Throwing from `execute` — CONFIRMED via Probe 03 (`scratch/03-throw.ts`).** Pi catches the thrown `Error` and surfaces it to the model as a `toolResult` message with `isError: true`, where `content[0].text === error.message`. Pi does NOT retry; the model decides based on its system prompt and the error content. `session.prompt()` resolves normally.

**Two error-signaling paths from `execute()`:**

1. **Throw** — Pi catches, sets `isError: true`, uses `error.message` as the single-text-block content. Simple but loses control of content shape.
2. **Return** `{ content: [...], details: {}, isError: true }` — explicit error result with structured content (multi-block possible).

For the Managed Agents bridge specifically: when the API caller posts `user.custom_tool_result` with `is_error: true`, our `execute()` body **should resolve the Promise with `{content: event.content, details: {}, isError: true}` (path 2), not reject it**. Rejecting works (Pi catches) but loses the structured content from the API caller. Reserve path 1 (throw) for genuinely unexpected exceptions inside our handler — e.g., the Promise resolver got cleared but the tool body still ran.

**Abort propagation: CONFIRMED via Probe 02 (`scratch/02-abort.ts`).** `session.abort()` fires `AbortSignal.abort` on the signal passed to `execute()` within ~1ms. `tool_execution_end` and `agent_end` events fire after abort. `session.prompt()` resolves rather than throws. `session.isStreaming` returns to `false`. The pattern in this ADR is correct as written.

**Defensive note:** the type of `signal` in `execute(toolCallId, params, signal, onUpdate, ctx)` is nullable in Pi's type definitions. Our `execute()` body should `if (!signal)` defensively — in observed runs `signal` was always defined, but the type allows undefined.

See [scratch-pi-findings.md](../scratch-pi-findings.md) §Q1 and §Q2 for full empirical evidence.

## Findings (post code-review, 2026-05-21)

Two findings from the code review pass surface meaningful corrections to this ADR. Neither changes the core blocking-async-function pattern, but both change implementation details that would otherwise produce a wire-incompatible build.

### 1. The wire field is `custom_tool_use_id`, not `tool_use_id`

Anthropic's Managed Agents protocol uses **two different identifiers** for two different events:

| Event type | ID field | Purpose |
|---|---|---|
| `user.custom_tool_result` | `custom_tool_use_id` | The reply to an `agent.custom_tool_use` event (our blocking-async pattern) |
| `user.tool_confirmation` | `tool_use_id` | The reply to an `agent.tool_use` event with `evaluated_permission === "ask"` (permission gating for built-in or MCP tools) |

The pseudocode in the ADR body originally read `event.tool_use_id` for the `user.custom_tool_result` handler — that would silently 404 against any real Anthropic SDK client. **Fixed in the code sample above.** Permission-gating (the `tool_use_id` path) is a separate feature, post-MVP.

### 2. Custom tool round-trip MUST also emit `session.status_idle` with `requires_action`

Anthropic's contract is more strict than just "emit `agent.custom_tool_use` and wait for the reply." The canonical client loop (see the skill's `managed-agents-client-patterns.md` Pattern 5) breaks on:

```js
if (event.type === "session.status_idle" && event.stop_reason.type !== "requires_action") break;
```

So when our custom tool's `execute()` starts blocking, we MUST emit **two events**, in this order:

1. `agent.custom_tool_use` — the request to the client (carries the `id` used as `custom_tool_use_id` in the reply).
2. `session.status_idle` with `stop_reason: { type: "requires_action", event_ids: [<custom_tool_use id>] }` — the explicit "we're idle, waiting for you" signal that clients drain on.

When `user.custom_tool_result` arrives and the Promise resolves, the session transitions back to `running` — we emit `session.status_running` for live SSE listeners.

### 3. Registration is via `customTools`, not the extensions system

Probe 04 (`scratch/04-tool-array.ts`) empirically resolved how to register custom tools cleanly. The path is simpler than this ADR originally described:

```ts
import { defineTool, createAgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const askUser = defineTool({
  name: "ask_user",
  label: "Ask User",
  description: "Block until the user answers",
  parameters: Type.Object({ question: Type.String() }),
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    // emit agent.custom_tool_use + session.status_idle{requires_action}
    // store resolver in pendingToolCalls keyed by custom_tool_use_id
    // return new Promise((resolve) => { ... })
    // wire signal.addEventListener("abort", ...) as documented above
  },
});

const { session } = await createAgentSession({
  model,
  customTools: [askUser],   // ← SDK-level custom tool registration
  noTools: "builtin",       // ← suppress built-ins (we route those through Sandbox)
  // ... other config
});
```

No `DefaultResourceLoader`, no `extensionFactories: [...]`, no `pi.registerTool`. The original ADR sketched the extension-based path because that's the only one `examples/sdk/06-extensions.ts` demonstrates; the simpler `customTools` field on `CreateAgentSessionOptions` is documented in the type definitions but not in the examples. Empirical verification: `session.state.tools` shows `[ask_me]` after probe; `execute()` is called and round-trips correctly.

The blocking-async pattern from this ADR is unchanged. The registration ceremony shrinks from "build a `DefaultResourceLoader` with an extension factory" to "pass an array."

### 4. `signal` on `execute()` is typed nullable but observed always-defined

Defensive guard recommended — see ADR body. Empirically (Probe 02), `signal` was always defined in our runs, but the type allows `undefined`. Don't rely on it being defined.

**Permission gating (`always_ask`) is a separate hook.** `AgentLoopConfig.beforeToolCall(ctx)` returns `{ block?: boolean, reason?: string }`. Also exposed at the extension level via `pi.on("tool_call", ...)`. This is where Managed Agents `permission_policy: "always_ask"` plugs in — different code path from custom tools.
