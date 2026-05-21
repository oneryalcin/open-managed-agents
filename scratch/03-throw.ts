/**
 * Probe 03 — AgentTool throw behavior
 *
 * Goal: determine what Pi does when a custom tool's `execute()` throws a plain
 * Error (not an AbortError). Hypotheses to discriminate:
 *   (a) Pi retries the tool call
 *   (b) Pi surfaces the error as a tool_result with isError:true (continues loop)
 *   (c) Pi aborts the session entirely
 *   (d) Pi crashes / unhandled rejection
 *
 * Method: register a custom tool `explode` whose body throws synchronously.
 * Run a prompt that calls it. Observe how many times it gets called, what
 * events fire, what session.prompt() resolves to, and what's in session.state.
 *
 * Run: ANTHROPIC_API_KEY=... npx tsx scratch/03-throw.ts
 */

import { Type } from "typebox";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const start = Date.now();
const eventCounts = new Map<string, number>();
const log = (msg: string) => console.log(`[+${Date.now() - start}ms] ${msg}`);

let callCount = 0;
const ERROR_MESSAGE = "synthetic test error from probe-03";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find("anthropic", "claude-haiku-4-5");
if (!model) {
  console.error("FAIL: no haiku-4-5");
  process.exit(1);
}

const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  extensionFactories: [
    (pi) => {
      pi.registerTool({
        name: "explode",
        label: "Explode",
        description:
          "Always throws a synthetic error. Use this exactly once when asked to test error handling.",
        parameters: Type.Object({
          marker: Type.String({ description: "any short string identifier" }),
        }),
        execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
          callCount += 1;
          log(
            `tool.execute() call #${callCount}: marker="${(params as { marker: string }).marker}" — about to throw`,
          );
          throw new Error(ERROR_MESSAGE);
        },
      });
    },
  ],
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  model,
  thinkingLevel: "off",
  authStorage,
  modelRegistry,
  sessionManager: SessionManager.inMemory(),
  resourceLoader,
});

log(`session: ${session.sessionId}`);

session.subscribe((event) => {
  const type = event.type;
  eventCounts.set(type, (eventCounts.get(type) ?? 0) + 1);
  if (type.includes("tool") || type === "agent_end" || type.includes("error")) {
    // deno-lint-ignore no-explicit-any
    log(`event: ${type}${(event as any).isError ? " (isError)" : ""}`);
  }
});

log("calling session.prompt()...");
const result = await session
  .prompt(
    "Call the explode tool exactly once with marker='probe-03'. After it errors, briefly explain in one sentence what went wrong, then stop. Do not retry.",
  )
  .then(
    () => "resolved-normally",
    (err) => `threw: ${(err as Error).message}`,
  );

log(`prompt outcome: ${result}`);
log(`explode was called ${callCount} time(s)`);

console.log("\n=== event counts ===");
for (const [type, count] of [...eventCounts.entries()].sort()) {
  console.log(`  ${type}: ${count}`);
}

console.log("\n=== message summary ===");
console.log(`messages: ${session.state.messages.length}`);
for (let i = 0; i < session.state.messages.length; i++) {
  const m = session.state.messages[i] as unknown as {
    role?: string;
    content?: unknown;
    type?: string;
  };
  const preview = JSON.stringify(m).slice(0, 280);
  console.log(`  [${i}] role=${m.role ?? "?"} type=${m.type ?? "?"}: ${preview}`);
}

console.log(`\nisStreaming: ${session.isStreaming}`);
session.dispose();
log("disposed");
