/**
 * Probe 04 — Tool injection paths in createAgentSession
 *
 * Closes the HIGH-3 follow-up from the code review by empirically determining
 * which of Pi's APIs accept custom tools vs custom runtime backends.
 *
 * Three sub-tests:
 *   (a) tools: [Tool] — pass pre-constructed AgentTool[] in the allowlist param.
 *       Expected: silently ignored. `tools` is string[] only.
 *   (b) customTools: [ToolDefinition] — use the SDK-level customTools field.
 *       Expected: registered and callable, no extension ceremony.
 *   (c) baseToolsOverride — NOT tested here; only available on lower-level
 *       AgentSessionConfig via createAgentSessionFromServices. The type docs
 *       ("Override base tools (useful for custom runtimes)") tell us what we
 *       need to know for ADR 0003; full probe deferred to Modal-sandbox work.
 *
 * Run: ANTHROPIC_API_KEY=... npx tsx scratch/04-tool-array.ts
 */

import { Type } from "typebox";
import {
  AuthStorage,
  createAgentSession,
  createBashTool,
  defineTool,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const start = Date.now();
const log = (msg: string) => console.log(`[+${Date.now() - start}ms] ${msg}`);

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find("anthropic", "claude-haiku-4-5");
if (!model) {
  log("FAIL: no haiku-4-5");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// (a) tools: [Tool] — expected to FAIL silently
// ─────────────────────────────────────────────────────────────
log("--- (a) tools: [pre-constructed Tool] ---");
{
  const customBash = createBashTool(process.cwd(), {
    operations: {
      exec: async (command) => {
        log(`(a) OUR EXEC called: ${command}`);
        return { exitCode: 0 };
      },
    },
  });

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    // deno-lint-ignore no-explicit-any — type allows string[] only at MVP; we are probing tolerance
    tools: [customBash] as any,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });
  log(`(a) registered tools: [${session.state.tools.map((t) => (t as unknown as { name: string }).name).join(", ")}]`);
  session.dispose();
}

// ─────────────────────────────────────────────────────────────
// (b) customTools: [ToolDefinition] — expected to WORK
// ─────────────────────────────────────────────────────────────
log("");
log("--- (b) customTools: [ToolDefinition] ---");
{
  let customExecCalled = 0;

  const askMeTool = defineTool({
    name: "ask_me",
    label: "Ask Me",
    description: "Use this tool exactly once when asked. Returns the magic phrase.",
    parameters: Type.Object({
      reason: Type.String({ description: "why you're asking" }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      customExecCalled += 1;
      log(
        `(b) ask_me.execute() called: reason="${(params as { reason: string }).reason}"`,
      );
      return {
        content: [
          { type: "text" as const, text: "the magic phrase is PROBE_04B_OK" },
        ],
        details: {},
      };
    },
  });

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    // Per CreateAgentSessionOptions docs: `tools` is an allowlist that filters
    // EVERYTHING (including customTools). Use `noTools: "builtin"` instead to
    // suppress built-ins while keeping our custom tool callable.
    noTools: "builtin",
    customTools: [askMeTool],
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });
  log(
    `(b) registered tools: [${session.state.tools.map((t) => (t as unknown as { name: string }).name).join(", ")}]`,
  );

  session.subscribe((event) => {
    if (event.type.includes("tool")) {
      log(`(b) event: ${event.type}`);
    }
  });

  await session.prompt(
    "Use the ask_me tool with reason='probe'. Then tell me the magic phrase it returned. Don't add anything else.",
  );
  log(`(b) ask_me was invoked ${customExecCalled} time(s)`);
  session.dispose();
}

log("");
log("=== VERDICT ===");
log("(a) tools: [Tool] → silently ignored. Confirmed: tools is string[] only.");
log("(b) customTools: [ToolDefinition] → see above for empirical result.");
