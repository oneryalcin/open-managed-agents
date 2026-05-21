/**
 * Probe 02 — session.abort() behavior mid-custom-tool
 *
 * Goal: confirm that `session.abort()` fires the AbortSignal passed to a custom
 * tool's `execute()`, so we can wire it to reject pending Promises in our
 * blocking-async-tool pattern (ADR 0005).
 *
 * Method: register a custom tool `wait_for_signal` whose body awaits a Promise
 * that only rejects via AbortSignal. Trigger it with a prompt, then call
 * session.abort() once the tool is in-flight. Observe whether the AbortSignal
 * fires, whether `session.prompt()` settles, and what events are emitted.
 *
 * Run: ANTHROPIC_API_KEY=... npx tsx scratch/02-abort.ts
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

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find("anthropic", "claude-haiku-4-5");
if (!model) {
  console.error("FAIL: no haiku-4-5 in registry");
  process.exit(1);
}

// Sentinels we use to coordinate the test
let onToolStarted!: () => void;
const toolStarted = new Promise<void>((r) => (onToolStarted = r));

type ToolOutcome =
  | { kind: "aborted-via-signal"; signalAborted: boolean }
  | { kind: "resolved-normally" }
  | { kind: "threw-unrelated"; message: string };

let onToolFinished!: (o: ToolOutcome) => void;
const toolFinished = new Promise<ToolOutcome>((r) => (onToolFinished = r));

const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  extensionFactories: [
    (pi) => {
      pi.registerTool({
        name: "wait_for_signal",
        label: "Wait for signal",
        description:
          "Blocks indefinitely until the orchestrator cancels via AbortSignal. Use this exactly once when asked to test the abort path.",
        parameters: Type.Object({
          marker: Type.String({ description: "any short string identifier" }),
        }),
        execute: async (toolCallId, params, signal, _onUpdate, _ctx) => {
          log(
            `tool.execute() called: marker="${(params as { marker: string }).marker}", signal.aborted=${signal?.aborted ?? "no-signal"}`,
          );
          onToolStarted();

          try {
            await new Promise<void>((_resolve, reject) => {
              if (!signal) {
                log("tool: WARN no signal passed to execute()");
                return; // hang forever, will be force-aborted by test timeout
              }
              const onAbort = () => {
                log(`tool: signal abort event fired (signal.aborted=${signal.aborted})`);
                reject(new DOMException("aborted via signal", "AbortError"));
              };
              signal.addEventListener("abort", onAbort, { once: true });
            });
            onToolFinished({ kind: "resolved-normally" });
            return { content: [{ type: "text", text: "should not happen" }], details: {} };
          } catch (err) {
            const message = (err as Error).message;
            log(`tool: caught during await: ${message}`);
            if ((err as Error).name === "AbortError") {
              onToolFinished({ kind: "aborted-via-signal", signalAborted: signal?.aborted ?? false });
            } else {
              onToolFinished({ kind: "threw-unrelated", message });
            }
            // Re-throw — let Pi observe the rejection
            throw err;
          }
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
log(`tools: ${session.state.tools.map((t) => (t as unknown as { name: string }).name).join(", ")}`);

session.subscribe((event) => {
  const type = event.type;
  eventCounts.set(type, (eventCounts.get(type) ?? 0) + 1);
  if (type.includes("tool") || type.includes("error") || type === "agent_end") {
    log(`event: ${type}`);
  }
});

log("calling session.prompt()...");
const promptPromise = (async () => {
  try {
    await session.prompt(
      "Call the wait_for_signal tool exactly once with marker='probe-02'. Don't return until you've called it.",
    );
    return "resolved";
  } catch (err) {
    return `threw: ${(err as Error).message}`;
  }
})();

log("waiting for tool to start...");
await Promise.race([
  toolStarted,
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timeout waiting for tool to start (30s)")), 30_000),
  ),
]);

log("tool is in-flight; waiting 200ms then calling session.abort()");
await new Promise((r) => setTimeout(r, 200));

log("session.abort() →");
const abortResult = await session.abort().then(
  () => "resolved",
  (err) => `threw: ${(err as Error).message}`,
);
log(`session.abort() ${abortResult}`);

log("awaiting prompt + tool settlement (max 5s)...");
const [promptOutcome, toolOutcome] = await Promise.all([
  promptPromise,
  Promise.race([
    toolFinished,
    new Promise<ToolOutcome>((r) =>
      setTimeout(() => r({ kind: "threw-unrelated", message: "tool never settled (5s)" }), 5_000),
    ),
  ]),
]);

log(`prompt outcome: ${promptOutcome}`);
log(`tool outcome: ${JSON.stringify(toolOutcome)}`);

console.log("\n=== event counts ===");
for (const [type, count] of [...eventCounts.entries()].sort()) {
  console.log(`  ${type}: ${count}`);
}
console.log(`messages in state: ${session.state.messages.length}`);
console.log(`isStreaming: ${session.isStreaming}`);

session.dispose();
log("disposed");
