/**
 * Probe 10 — Pi raw event field dump (Cycle C gate)
 *
 * Captures raw subscribed Pi events as JSONL for four trajectories:
 *   1) simple_message
 *   2) tool_call
 *   3) tool_throw
 *   4) abort
 *
 * Output:
 *   scratch/artifacts/pi-events/<scenario>.jsonl
 *   scratch/artifacts/pi-events/_summary.json
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx scratch/10-pi-event-dump.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import {
  AuthStorage,
  createAgentSession,
  defineTool,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

type Scenario = "simple_message" | "tool_call" | "tool_throw" | "abort";

interface DumpLine {
  scenario: Scenario;
  seq: number;
  captured_at: string;
  event: unknown;
}

interface ScenarioResult {
  scenario: Scenario;
  eventCount: number;
  eventTypes: Record<string, number>;
}

const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "pi-events");
const MODEL_PROVIDER = "anthropic";
const MODEL_ID = "claude-haiku-4-5";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
if (!model) {
  console.error(`FAIL: modelRegistry.find(${MODEL_PROVIDER}, ${MODEL_ID}) returned null`);
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });

const results: ScenarioResult[] = [];

results.push(await runSimpleMessage());
results.push(await runToolCall());
results.push(await runToolThrow());
results.push(await runAbort());

const summary = {
  generated_at: new Date().toISOString(),
  model: `${MODEL_PROVIDER}/${MODEL_ID}`,
  out_dir: OUT_DIR,
  scenarios: results,
};

await writeFile(join(OUT_DIR, "_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));

async function runSimpleMessage(): Promise<ScenarioResult> {
  const scenario: Scenario = "simple_message";
  const lines: DumpLine[] = [];
  const typeCounts = new Map<string, number>();
  let seq = 0;

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    noTools: "all",
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });

  session.subscribe((event) => {
    seq += 1;
    const clean = redactSecrets(toPlain(event));
    lines.push({
      scenario,
      seq,
      captured_at: new Date().toISOString(),
      event: clean,
    });
    const type = readEventType(clean);
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  });

  try {
    await session.prompt("Reply with exactly: hello from probe-10");
  } finally {
    session.dispose();
  }

  return persistScenarioResult(scenario, lines, typeCounts);
}

async function runToolCall(): Promise<ScenarioResult> {
  const scenario: Scenario = "tool_call";
  const lines: DumpLine[] = [];
  const typeCounts = new Map<string, number>();
  let seq = 0;

  const askMe = defineTool({
    name: "ask_me",
    label: "Ask Me",
    description: "Return a fixed phrase",
    parameters: Type.Object({
      reason: Type.String(),
    }),
    execute: async () => ({
      content: [{ type: "text" as const, text: "PROBE_10_TOOL_CALL_OK" }],
      details: {},
    }),
  });

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    noTools: "builtin",
    customTools: [askMe],
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });

  session.subscribe((event) => {
    seq += 1;
    const clean = redactSecrets(toPlain(event));
    lines.push({
      scenario,
      seq,
      captured_at: new Date().toISOString(),
      event: clean,
    });
    const type = readEventType(clean);
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  });

  try {
    await session.prompt(
      "Use ask_me once with reason='probe-10-tool-call', then reply with its phrase and stop.",
    );
  } finally {
    session.dispose();
  }

  return persistScenarioResult(scenario, lines, typeCounts);
}

async function runToolThrow(): Promise<ScenarioResult> {
  const scenario: Scenario = "tool_throw";
  const lines: DumpLine[] = [];
  const typeCounts = new Map<string, number>();
  let seq = 0;

  const explode = defineTool({
    name: "explode",
    label: "Explode",
    description: "Always throws",
    parameters: Type.Object({
      marker: Type.String(),
    }),
    execute: async () => {
      throw new Error("synthetic test error from probe-10");
    },
  });

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    noTools: "builtin",
    customTools: [explode],
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });

  session.subscribe((event) => {
    seq += 1;
    const clean = redactSecrets(toPlain(event));
    lines.push({
      scenario,
      seq,
      captured_at: new Date().toISOString(),
      event: clean,
    });
    const type = readEventType(clean);
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  });

  try {
    await session.prompt(
      "Call explode once with marker='probe-10-throw'. After error, summarize and stop. Do not retry.",
    );
  } finally {
    session.dispose();
  }

  return persistScenarioResult(scenario, lines, typeCounts);
}

async function runAbort(): Promise<ScenarioResult> {
  const scenario: Scenario = "abort";
  const lines: DumpLine[] = [];
  const typeCounts = new Map<string, number>();
  let seq = 0;
  let onToolStarted!: () => void;
  const toolStarted = new Promise<void>((resolve) => {
    onToolStarted = resolve;
  });

  const waitTool = defineTool({
    name: "wait_for_signal",
    label: "Wait for signal",
    description: "Block until AbortSignal is fired",
    parameters: Type.Object({
      marker: Type.String(),
    }),
    execute: async (_toolCallId, _params, signal) => {
      onToolStarted();
      await new Promise<void>((_resolve, reject) => {
        if (!signal) {
          reject(new Error("signal missing"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted via signal", "AbortError")),
          { once: true },
        );
      });
      return { content: [{ type: "text" as const, text: "unexpected" }], details: {} };
    },
  });

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    noTools: "builtin",
    customTools: [waitTool],
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });

  session.subscribe((event) => {
    seq += 1;
    const clean = redactSecrets(toPlain(event));
    lines.push({
      scenario,
      seq,
      captured_at: new Date().toISOString(),
      event: clean,
    });
    const type = readEventType(clean);
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  });

  try {
    const promptPromise = session.prompt(
      "Call wait_for_signal once with marker='probe-10-abort' and wait.",
    );
    await withTimeout(toolStarted, 30_000, "timeout waiting for tool start");
    await session.abort();
    await promptPromise;
  } finally {
    session.dispose();
  }

  return persistScenarioResult(scenario, lines, typeCounts);
}

async function persistScenarioResult(
  scenario: Scenario,
  lines: DumpLine[],
  typeCounts: Map<string, number>,
): Promise<ScenarioResult> {
  const jsonl = lines.map((line) => JSON.stringify(line)).join("\n");
  await writeFile(join(OUT_DIR, `${scenario}.jsonl`), `${jsonl}\n`, "utf8");
  return {
    scenario,
    eventCount: lines.length,
    eventTypes: Object.fromEntries([...typeCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readEventType(value: unknown): string {
  if (!value || typeof value !== "object") return "unknown";
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && type.length > 0 ? type : "unknown";
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") return redactString(value);
    return value;
  }

  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (isSecretKey(key)) {
      out[key] = "<REDACTED>";
      continue;
    }
    if (typeof raw === "string") {
      out[key] = redactString(raw);
      continue;
    }
    out[key] = redactSecrets(raw);
  }
  return out;
}

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.includes("token")
    || k.includes("apikey")
    || k.includes("api_key")
    || k.includes("authorization")
    || k.includes("secret")
    || k.includes("password")
  );
}

function redactString(value: string): string {
  if (/^Bearer\s+[A-Za-z0-9._-]+$/i.test(value)) return "Bearer <REDACTED>";
  if (/^sk-[A-Za-z0-9_-]{8,}$/i.test(value)) return "<REDACTED>";
  return value;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
