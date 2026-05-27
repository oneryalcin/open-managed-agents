/**
 * Probe 21 — provider-owned builtin-shaped tools through Pi customTools.
 *
 * Cycle E.1 started with Pi builtin Operations injection:
 *   createBashTool(cwd, { operations }) + session.agent.state.tools = [...]
 *
 * That works, but it leaves us policing a bypass class: Pi owns the builtin
 * execution body, so a future SDK change can run a host builtin without calling
 * our provider. This probe tests the cleaner alternative:
 *
 *   defineTool({ name: "bash", execute(...) { provider.exec(...); onUpdate(...) } })
 *   createAgentSession({ noTools: "builtin", tools: ["bash"], customTools: [...] })
 *
 * If this emits Pi tool events under the public name "bash" and streams
 * tool_execution_update through onUpdate, E can move to provider-owned builtins
 * instead of internal active-tool mutation.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx scratch/21-e2-define-tool-builtins.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import {
  AuthStorage,
  createAgentSession,
  defineTool,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "pi-sandbox");
const MODEL_PROVIDER = "anthropic";
const MODEL_ID = "claude-haiku-4-5";
const PARTIAL_MARKER = "PROBE_21_PARTIAL_FROM_PROVIDER";
const FINAL_MARKER = "PROBE_21_FINAL_FROM_PROVIDER";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
if (!model) {
  throw new Error(`modelRegistry.find(${MODEL_PROVIDER}, ${MODEL_ID}) returned null`);
}

mkdirSync(OUT_DIR, { recursive: true });

const results = [];
results.push(
  await runScenario({
    scenario: "custom_tool_named_bash_no_builtin",
    toolName: "bash",
    noTools: "builtin",
    tools: ["bash"],
    prompt:
      "Use the bash tool exactly once with command 'printf probe-21'. Then reply with the final marker you saw.",
  }),
);
results.push(
  await runScenario({
    scenario: "custom_tool_named_oma_bash_baseline",
    toolName: "oma_bash",
    noTools: "builtin",
    tools: ["oma_bash"],
    prompt:
      "Use the oma_bash tool exactly once with command 'printf probe-21'. Then reply with the final marker you saw.",
  }),
);

const summary = {
  generated_at: new Date().toISOString(),
  model: `${MODEL_PROVIDER}/${MODEL_ID}`,
  results,
  verdict: results.every((result) => result.toolCalled && result.updateObserved)
    ? "PASS"
    : "FAIL",
};

writeFileSync(
  join(OUT_DIR, "_e2-define-tool-builtins-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));

async function runScenario(opts: {
  scenario: string;
  toolName: string;
  noTools: "all" | "builtin";
  tools: string[];
  prompt: string;
}) {
  const events: unknown[] = [];
  const calls: Array<{
    toolCallId: string;
    params: unknown;
    signalPresent: boolean;
    onUpdatePresent: boolean;
  }> = [];

  const tool = defineTool({
    name: opts.toolName,
    label: opts.toolName,
    description:
      "Run a shell command in the managed sandbox. Use this probe tool exactly when requested.",
    parameters: Type.Object({
      command: Type.String(),
    }),
    execute: async (toolCallId, params, signal, onUpdate) => {
      calls.push({
        toolCallId,
        params,
        signalPresent: signal !== undefined,
        onUpdatePresent: onUpdate !== undefined,
      });
      onUpdate?.({
        content: [{ type: "text" as const, text: `${PARTIAL_MARKER}\n` }],
        details: { phase: "partial" },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        content: [{ type: "text" as const, text: `${FINAL_MARKER}\n` }],
        details: { phase: "final" },
      };
    },
  });

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    noTools: opts.noTools,
    tools: opts.tools,
    customTools: [tool],
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });

  const activeBefore = safeCall(() => session.getActiveToolNames());
  const allToolsBefore = safeCall(() =>
    session.getAllTools().map((candidate) => ({
      name: candidate.name,
    })),
  );
  const hasDefinitionBefore = session.getToolDefinition(opts.toolName) !== undefined;

  session.setActiveToolsByName(opts.tools);
  const activeAfterSet = safeCall(() => session.getActiveToolNames());

  session.subscribe((event) => events.push(toPlain(event)));

  let promptError: string | undefined;
  try {
    await session.prompt(opts.prompt);
  } catch (error) {
    promptError = error instanceof Error ? error.message : String(error);
  } finally {
    session.dispose();
  }

  const path = join(OUT_DIR, `${opts.scenario}.jsonl`);
  writeFileSync(
    path,
    events
      .map((event, index) =>
        JSON.stringify({
          seq: index + 1,
          captured_at: new Date().toISOString(),
          event,
        }),
      )
      .join("\n") + "\n",
  );

  const toolEvents = events.filter(
    (event) => isRecord(event) && event.toolName === opts.toolName,
  ) as Record<string, unknown>[];
  const eventTypes = events.reduce<Record<string, number>>((acc, event) => {
    const type = isRecord(event) && typeof event.type === "string" ? event.type : "unknown";
    acc[type] = (acc[type] ?? 0) + 1;
    return acc;
  }, {});
  const assistantText = events
    .filter(isRecord)
    .filter((event) => event.type === "message_end")
    .flatMap((event) => textBlocksFromMessage(event.message))
    .join("\n");

  return {
    scenario: opts.scenario,
    toolName: opts.toolName,
    promptError,
    activeBefore,
    activeAfterSet,
    allToolsBefore,
    hasDefinitionBefore,
    eventTypes,
    toolEvents: toolEvents.map((event) => ({
      type: event.type,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      result: event.result,
      partialResult: event.partialResult,
    })),
    calls,
    toolCalled: calls.length > 0,
    updateObserved: toolEvents.some((event) => event.type === "tool_execution_update"),
    finalObserved: toolEvents.some(
      (event) =>
        event.type === "tool_execution_end" &&
        JSON.stringify(event).includes(FINAL_MARKER),
    ),
    assistantText,
    artifact: path,
  };
}

function safeCall<T>(fn: () => T): T | string {
  try {
    return fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function textBlocksFromMessage(message: unknown): string[] {
  if (!isRecord(message) || message.role !== "assistant") return [];
  if (!Array.isArray(message.content)) return [];
  return message.content
    .filter(isRecord)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPlain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
