/**
 * Probe 18 — Pi custom-tool error result propagation.
 *
 * Settles whether returning `{ isError: true }` from a Pi custom tool is
 * observed in Pi's raw `tool_execution_end` event and by the model.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx scratch/18-d-custom-tool-error.ts
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

const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "pi-custom-tools");
const MODEL_PROVIDER = "anthropic";
const MODEL_ID = "claude-haiku-4-5";
const ERROR_TEXT = "PROBE_18_TOOL_ERROR";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
if (!model) {
  throw new Error(`modelRegistry.find(${MODEL_PROVIDER}, ${MODEL_ID}) returned null`);
}

const events: unknown[] = [];
const failingTool = defineTool({
  name: "failing_external",
  label: "Failing External",
  description: "Always returns an explicit tool error.",
  parameters: Type.Object({
    marker: Type.String(),
  }),
  execute: async () => ({
    content: [{ type: "text" as const, text: ERROR_TEXT }],
    details: {},
    isError: true,
  }),
});

const { session } = await createAgentSession({
  model,
  thinkingLevel: "off",
  noTools: "builtin",
  customTools: [failingTool],
  authStorage,
  modelRegistry,
  sessionManager: SessionManager.inMemory(),
});
session.subscribe((event) => events.push(toPlain(event)));

try {
  await session.prompt(
    [
      "Call failing_external exactly once with marker='probe-18'.",
      "If the tool is reported as an error, reply exactly: ERROR_SEEN.",
      "If it is reported as successful, reply exactly: SUCCESS_SEEN.",
    ].join(" "),
  );
} finally {
  session.dispose();
}

const toolExecutionEnd = events.find(
  (event) =>
    isRecord(event) &&
    event.type === "tool_execution_end" &&
    event.toolName === "failing_external",
) as Record<string, unknown> | undefined;
const finalText = events
  .filter(isRecord)
  .filter((event) => event.type === "message_end")
  .flatMap((event) => {
    const message = event.message;
    if (!isRecord(message) || message.role !== "assistant") return [];
    const content = message.content;
    if (!Array.isArray(content)) return [];
    return content
      .filter(isRecord)
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string);
  })
  .join("\n");

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, "error_result.jsonl"),
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
const summary = {
  generated_at: new Date().toISOString(),
  model: `${MODEL_PROVIDER}/${MODEL_ID}`,
  tool_execution_end_is_error: toolExecutionEnd?.isError,
  tool_execution_end_content: isRecord(toolExecutionEnd?.result)
    ? toolExecutionEnd?.result.content
    : undefined,
  final_text: finalText,
  verdict:
    toolExecutionEnd?.isError === true && finalText.includes("ERROR_SEEN")
      ? "PASS"
      : "FAIL",
};
writeFileSync(
  join(OUT_DIR, "_d-live-custom-tool-error-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPlain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
