# ADR 0001: Use Pi Agent SDK as engine

**Status:** Accepted, 2026-05-21

## Context

The agent loop — call model → handle `tool_use` → execute → return `tool_result` → loop, plus compaction, streaming, and context-window management — is the small, well-understood part of a Managed Agents implementation. The platform around it (REST/SSE control plane, session persistence, sandbox lifecycle, vaults, multi-tenancy) is the bulk of the work.

Our engine needs to be:

1. Mature enough not to break under us mid-project.
2. Exposable as a session we drive externally — programmatic prompts, event subscriptions, interrupts, compaction control.
3. Compatible with arbitrary sandbox / tool implementations (so we can route file ops to Modal, K8s, etc.).
4. Not opinionated about the *shape* of the platform around it (no built-in HTTP server, no required filesystem convention).

Three options considered.

## Decision

Use **Pi Agent SDK** (`@earendil-works/pi-coding-agent`) as the engine.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Build the loop from scratch on top of the Anthropic SDK** | Multi-week scope just to match feature parity — compaction, streaming, tool execution, error recovery, retries. Defeats the goal of focusing engineering budget on the platform. We can swap to this later if Pi doesn't fit. |
| **Claude Agent SDK** (`claude-agent-sdk-python`) | Local-first by design — spawns the `claude` CLI as a subprocess. Wrong shape for a multi-tenant hosted platform; the per-session container model and the subprocess-per-session model don't compose well. |
| **Flue** (`@flue/runtime`, withastro) | Framework-shaped: it wants to own the project layout (`.flue/agents/*.ts`, triggers metadata, AGENTS.md). For a REST-API platform we'd be writing TypeScript files to disk every time someone POSTs `/v1/agents` — impedance mismatch. Also marked Experimental ("APIs may change") at evaluation time. |

## Why Pi specifically

- **Library, not framework.** Pi gives us `createAgentSession()` and an `AgentSession` interface. No imposed file conventions, no triggers, no AGENTS.md discovery.
- **Explicit primitives that map cleanly to Managed Agents endpoints**:
  - `prompt()` / `steer()` / `followUp()` → `events.send` with `user.message`
  - `subscribe()` → `events.stream`
  - `abort()` → `events.send` with `user.interrupt`
  - `compact()` → internal lever for context management
  - `fork()` / `newSession()` → session lifecycle ops
- **Async-function tool model** — Pi's `AgentTool` is an async function the engine awaits. This makes the Managed Agents custom-tool round-trip fall out for free (see [ADR 0005](0005-custom-tools-as-blocking-async-functions.md)).
- **Pi's typed Operations interfaces** give the clean hook for cwd-bound file/shell behavior — that's where sandbox-backed implementations attach (see [ADR 0003](0003-pluggable-sandbox-interface-modal-first.md)).
- **Reported as stable** with active community uptake (user assertion; not independently verified at decision time). **TODO before production:** independent maturity assessment — release cadence, contributor count, public issue/PR turnaround, security disclosure history, semver-compliance track record. Acceptable for MVP experiment; revisit before depending on it for anything load-bearing.

## Consequences

- Both control plane and engine are TypeScript (see [ADR 0002](0002-typescript-end-to-end.md)).
- We depend on `@earendil-works/pi-coding-agent` for the loop. If Pi's public API changes, we adapt; we don't fork it. If Pi's behavior is wrong for us, we change Pi *configuration*, not Pi *code*.
- Pi's tool list (`["read", "bash", ...]`) and per-tool implementations need to be replaced with sandbox-aware implementations. This is the largest piece of integration work.
- We accept Pi's compaction and context-management decisions as-is for MVP. If they don't fit, we expose `compact()` to the API caller as an explicit lever before considering re-implementing.

## Open questions

- Does Pi support tool *streaming* (intermediate output during a single tool call)? The docs show `tool_execution_update` events suggesting yes. Verify before promising it to API clients.
- How does Pi handle tool errors — does an exception in our async tool body cause Pi to retry, surface to the model, or abort? Verify before designing the `user.custom_tool_result` `is_error: true` path.

## Findings (2026-05-21)

See [scratch-pi-findings.md](../scratch-pi-findings.md) for full evidence.

- **Tool streaming: confirmed.** Pi's `BashOperations.exec` accepts `onData: (data: Buffer) => void`. Custom tools' `execute` receives an `onUpdate` callback as its 4th parameter. Pi can stream tool output progressively — we surface this as `tool_execution_update`-style events to our API clients.
- **Package architecture clarification:** Pi has three layers — `pi-coding-agent` (the CLI/SDK we install) → `pi-agent-core` (agent loop + hooks: `AgentLoopConfig`, `beforeToolCall`, `afterToolCall`) → `pi-ai` (where `Tool`/`AgentTool` actually lives). For MVP we depend only on `pi-coding-agent`. If we need agent-loop hooks not re-exported (e.g., `beforeToolCall` for permission policies), we add `pi-agent-core` as a direct dep at that point.
- **Tool error behavior: confirmed via Probe 03 (`scratch/03-throw.ts`).** Pi catches thrown errors from `Tool.execute()` and surfaces them to the model as a `toolResult` message with `isError: true`. The thrown `Error.message` becomes the `text` of `content[0]`. Pi does **not** retry — the model decides based on its system prompt and the error content. `session.prompt()` resolves normally even when a tool throws. See [scratch-pi-findings.md](../scratch-pi-findings.md) §Q2 for the full message-shape evidence.
- **Abort behavior: confirmed via Probe 02 (`scratch/02-abort.ts`).** `session.abort()` fires the `AbortSignal` passed as the 3rd param to `execute()` within ~1ms. `session.isStreaming` returns to `false`; the session is reusable post-abort.
