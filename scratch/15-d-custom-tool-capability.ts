/**
 * Probe 15 — Cycle D custom-tool capability probe.
 *
 * Answers the unknowns that gate Cycle D before implementing the control-plane
 * bridge:
 *
 *   1. Can a Pi custom tool block on an external Promise, then resume cleanly
 *      when that Promise resolves?
 *   2. What raw Pi events appear before the external result is supplied, and
 *      what correlation ID should the Managed Agents bridge preserve?
 *   3. Does Pi emit any `evaluated_permission`-like field for a blocked
 *      permission-policy hook, or is permission gating purely an extension hook?
 *
 * Output:
 *   scratch/artifacts/pi-custom-tools/blocking_roundtrip.jsonl
 *   scratch/artifacts/pi-custom-tools/permission_block.jsonl
 *   scratch/artifacts/pi-custom-tools/_summary.json
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx scratch/15-d-custom-tool-capability.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

type Scenario = "blocking_roundtrip" | "permission_block";

interface DumpLine {
  scenario: Scenario;
  seq: number;
  phase: "before_result" | "after_result" | "all";
  captured_at: string;
  event: unknown;
}

interface ScenarioSummary {
  scenario: Scenario;
  eventCount: number;
  eventTypes: Record<string, number>;
  facts: Record<string, unknown>;
}

const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "pi-custom-tools");
const MODEL_PROVIDER = "anthropic";
const MODEL_ID = "claude-haiku-4-5";
const EXTERNAL_RESULT = "PROBE_15_CUSTOM_TOOL_RESULT_OK";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
if (!model) {
  console.error(`FAIL: modelRegistry.find(${MODEL_PROVIDER}, ${MODEL_ID}) returned null`);
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });

const summaries = [
  await runBlockingRoundTrip(),
  await runPermissionBlock(),
];

const summary = {
  generated_at: new Date().toISOString(),
  model: `${MODEL_PROVIDER}/${MODEL_ID}`,
  out_dir: OUT_DIR,
  scenarios: summaries,
};
await writeFile(join(OUT_DIR, "_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));

async function runBlockingRoundTrip(): Promise<ScenarioSummary> {
  const scenario: Scenario = "blocking_roundtrip";
  const capture = createCapture(scenario);
  let executeCall:
    | {
        toolCallId: string;
        params: unknown;
        signalPresent: boolean;
        signalInitiallyAborted: boolean;
      }
    | undefined;
  let resolveExternal!: (value: {
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, never>;
  }) => void;
  const externalResult = new Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, never>;
  }>((resolve) => {
    resolveExternal = resolve;
  });
  let toolStarted!: () => void;
  const toolStartedPromise = new Promise<void>((resolve) => {
    toolStarted = resolve;
  });

  const askExternal = defineTool({
    name: "ask_external",
    label: "Ask External",
    description:
      "Blocks until the external API caller supplies a result. Use this exactly once when asked.",
    parameters: Type.Object({
      question: Type.String(),
    }),
    execute: async (toolCallId, params, signal) => {
      executeCall = {
        toolCallId,
        params,
        signalPresent: signal !== undefined,
        signalInitiallyAborted: signal?.aborted ?? false,
      };
      toolStarted();
      return externalResult;
    },
  });

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    noTools: "builtin",
    customTools: [askExternal],
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });

  session.subscribe((event) => capture.push(event));

  try {
    const promptPromise = session.prompt(
      [
        "Call ask_external exactly once with question='probe-15'.",
        `After the tool returns, reply with exactly: ${EXTERNAL_RESULT}`,
      ].join(" "),
    );

    await withTimeout(toolStartedPromise, 45_000, "timeout waiting for ask_external execute()");
    await waitForCapturedEvent(capture.lines, "tool_execution_start", 5_000);
    const beforeResultCount = capture.lines.length;

    resolveExternal({
      content: [{ type: "text", text: EXTERNAL_RESULT }],
      details: {},
    });
    await withTimeout(promptPromise, 90_000, "timeout waiting for prompt after external result");
    const allLines = capture.lines;
    await persistScenario(scenario, allLines, beforeResultCount);

    return {
      scenario,
      eventCount: allLines.length,
      eventTypes: countEventTypes(allLines),
      facts: {
        execute_called: executeCall !== undefined,
        execute_call: executeCall,
        events_before_result: beforeResultCount,
        event_types_before_result: allLines
          .slice(0, beforeResultCount)
          .map((line) => readEventType(line.event)),
        tool_execution_start_before_result: allLines
          .slice(0, beforeResultCount)
          .some((line) => readEventType(line.event) === "tool_execution_start"),
        tool_execution_end_after_result: allLines
          .slice(beforeResultCount)
          .some((line) => readEventType(line.event) === "tool_execution_end"),
        external_result_seen_by_model: JSON.stringify(allLines).includes(EXTERNAL_RESULT),
        evaluated_permission_paths: findKeyPaths(allLines, "evaluated_permission"),
        verdict:
          executeCall !== undefined &&
          allLines.some((line) => readEventType(line.event) === "tool_execution_start") &&
          allLines.some((line) => readEventType(line.event) === "tool_execution_end") &&
          JSON.stringify(allLines).includes(EXTERNAL_RESULT)
            ? "PASS"
            : "FAIL",
      },
    };
  } finally {
    session.dispose();
  }
}

async function runPermissionBlock(): Promise<ScenarioSummary> {
  const scenario: Scenario = "permission_block";
  const capture = createCapture(scenario);
  const toolCallHookEvents: unknown[] = [];
  let executeCalled = false;

  const permissionProbe = defineTool({
    name: "permission_probe",
    label: "Permission Probe",
    description: "A tool used to probe Pi permission blocking behavior.",
    parameters: Type.Object({
      marker: Type.String(),
    }),
    execute: async () => {
      executeCalled = true;
      return {
        content: [{ type: "text" as const, text: "should-not-execute" }],
        details: {},
      };
    },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    extensionFactories: [
      (pi) => {
        pi.on("tool_call", (event) => {
          toolCallHookEvents.push(toPlain(event));
          return {
            block: true,
            reason: "probe-15 permission block",
          };
        });
      },
    ],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    noTools: "builtin",
    customTools: [permissionProbe],
    resourceLoader,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });

  session.subscribe((event) => capture.push(event));

  let promptOutcome = "unknown";
  try {
    await withTimeout(
      session.prompt(
        "Call permission_probe exactly once with marker='probe-15-permission'. Then stop.",
      ),
      90_000,
      "timeout waiting for permission block prompt",
    );
    promptOutcome = "resolved";
  } catch (error) {
    promptOutcome = `threw: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    session.dispose();
  }

  await persistScenario(scenario, capture.lines, capture.lines.length);
  return {
    scenario,
    eventCount: capture.lines.length,
    eventTypes: countEventTypes(capture.lines),
    facts: {
      tool_call_hook_count: toolCallHookEvents.length,
      tool_call_hook_events: toolCallHookEvents,
      execute_called: executeCalled,
      prompt_outcome: promptOutcome,
      evaluated_permission_paths: findKeyPaths(
        { events: capture.lines, toolCallHookEvents },
        "evaluated_permission",
      ),
      verdict:
        toolCallHookEvents.length > 0 && executeCalled === false ? "PASS" : "INCONCLUSIVE",
    },
  };
}

function createCapture(scenario: Scenario): {
  lines: DumpLine[];
  push: (event: unknown) => void;
} {
  const lines: DumpLine[] = [];
  return {
    lines,
    push(event) {
      lines.push({
        scenario,
        seq: lines.length + 1,
        phase: "all",
        captured_at: new Date().toISOString(),
        event: redactSecrets(toPlain(event)),
      });
    },
  };
}

async function persistScenario(
  scenario: Scenario,
  lines: DumpLine[],
  beforeResultCount: number,
): Promise<void> {
  const tagged = lines.map((line, index) => ({
    ...line,
    phase:
      scenario === "blocking_roundtrip"
        ? index < beforeResultCount
          ? "before_result"
          : "after_result"
        : "all",
  }));
  await writeFile(
    join(OUT_DIR, `${scenario}.jsonl`),
    `${tagged.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
}

async function waitForCapturedEvent(
  lines: DumpLine[],
  eventType: string,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (lines.some((line) => readEventType(line.event) === eventType)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for captured event ${eventType}`);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function countEventTypes(lines: DumpLine[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const type = readEventType(line.event);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function readEventType(value: unknown): string {
  if (!value || typeof value !== "object") return "unknown";
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && type.length > 0 ? type : "unknown";
}

function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") return redactString(value);
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (isSecretKey(key)) {
      out[key] = "<REDACTED>";
    } else {
      out[key] = redactSecrets(raw);
    }
  }
  return out;
}

function redactString(value: string): string {
  if (/sk-ant-[A-Za-z0-9_-]+/.test(value)) return "<REDACTED>";
  return value;
}

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("api_key") ||
    lower.includes("apikey") ||
    lower.includes("authorization") ||
    lower.includes("token") ||
    lower.includes("secret")
  );
}

function findKeyPaths(value: unknown, targetKey: string): string[] {
  const paths: string[] = [];
  visit(value, "$");
  return paths;

  function visit(current: unknown, path: string): void {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      const nextPath = `${path}.${key}`;
      if (key === targetKey) paths.push(nextPath);
      visit(child, nextPath);
    }
  }
}
