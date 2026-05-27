/**
 * Probe 19 — Cycle E.0 provider-neutral builtin-tool injection.
 *
 * Goal:
 *   Verify the current Pi SDK path for routing one builtin tool (`bash`) through
 *   a swappable `BashOperations.exec` provider, without Modal or Docker.
 *
 * Why this exists:
 *   ADR 0003 recorded `createAgentSessionFromServices(... baseToolsOverride)`
 *   as the intended injection point. In Pi 0.75.4, `AgentSessionConfig` still
 *   has `baseToolsOverride`, but the exported SDK helpers do not expose or
 *   forward it. The current public route is replacing `session.agent.state.tools`
 *   with tools built by `create*Tool(cwd, { operations })`.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx scratch/19-e0-builtin-operations-injection.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  createBashTool,
  ModelRegistry,
  SessionManager,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";

const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "pi-sandbox");
const MODEL_PROVIDER = "anthropic";
const MODEL_ID = "claude-haiku-4-5";
const MARKER = `E0_BASE_TOOLS_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const PROBE_CWD = "/workspace";

type ExecCall = {
  command: string;
  cwd: string;
  timeout: number | undefined;
  envKeyCount: number;
  includesSecretLikeEnvKeys: boolean;
};

const execCalls: ExecCall[] = [];
const operations: BashOperations = {
  exec: async (command, cwd, options) => {
    execCalls.push({
      command,
      cwd,
      timeout: options.timeout,
      envKeyCount: Object.keys(options.env ?? {}).length,
      includesSecretLikeEnvKeys: Object.keys(options.env ?? {}).some((key) =>
        /(?:API|AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i.test(key),
      ),
    });
    options.onData(Buffer.from(`${MARKER}\n`, "utf8"));
    return { exitCode: 0 };
  },
};

const sdkDrift = inspectSdkDrift();
const events: unknown[] = [];
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
if (!model) {
  throw new Error(`modelRegistry.find(${MODEL_PROVIDER}, ${MODEL_ID}) returned null`);
}

const { session } = await createAgentSession({
  model,
  thinkingLevel: "off",
  tools: ["bash"],
  authStorage,
  modelRegistry,
  sessionManager: SessionManager.inMemory(),
});
session.subscribe((event) => events.push(toPlain(event)));

// Current public SDK route: replace the active Agent tools with our
// Operations-backed builtin tool. This is intentionally not called a sandbox;
// the operation is a guarded provider seam for E.0.
session.agent.state.tools = [createBashTool(PROBE_CWD, { operations })];

try {
  await session.prompt(
    [
      "Use the bash tool exactly once.",
      `Run this exact command: printf '${MARKER}\\n'`,
      `After the tool result, reply exactly with: ${MARKER}`,
      "Do not answer from memory; use the bash tool.",
    ].join(" "),
  );
} finally {
  session.dispose();
}

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
const eventTypes = events
  .filter(isRecord)
  .map((event) => event.type)
  .filter((type): type is string => typeof type === "string");

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, "builtin_operations_injection.jsonl"),
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
  marker: MARKER,
  sdk_drift: sdkDrift,
  injection_method: "session.agent.state.tools = [createBashTool(cwd, { operations })]",
  operations_exec_call_count: execCalls.length,
  operations_exec_calls: execCalls,
  event_types: eventTypes,
  final_text: finalText,
  verdict:
    execCalls.length === 1 && finalText.includes(MARKER)
      ? "PASS"
      : "FAIL",
};
writeFileSync(
  join(OUT_DIR, "_e0-builtin-operations-injection-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));

function inspectSdkDrift(): {
  agent_session_config_has_baseToolsOverride: boolean;
  create_agent_session_options_has_baseToolsOverride: boolean;
  create_agent_session_from_services_options_has_baseToolsOverride: boolean;
  create_agent_session_from_services_js_forwards_baseToolsOverride: boolean;
  create_agent_session_js_forwards_baseToolsOverride: boolean;
} {
  const sdkDts = readFileSync(
    join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "sdk.d.ts"),
    "utf8",
  );
  const servicesDts = readFileSync(
    join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "agent-session-services.d.ts"),
    "utf8",
  );
  const servicesJs = readFileSync(
    join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "agent-session-services.js"),
    "utf8",
  );
  const sessionDts = readFileSync(
    join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "agent-session.d.ts"),
    "utf8",
  );
  const sdkJs = readFileSync(
    join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "sdk.js"),
    "utf8",
  );
  return {
    agent_session_config_has_baseToolsOverride: sessionDts.includes("baseToolsOverride?:"),
    create_agent_session_options_has_baseToolsOverride:
      sdkDts.includes("interface CreateAgentSessionOptions") &&
      sdkDts.slice(sdkDts.indexOf("interface CreateAgentSessionOptions")).includes("baseToolsOverride"),
    create_agent_session_from_services_options_has_baseToolsOverride:
      servicesDts.includes("interface CreateAgentSessionFromServicesOptions") &&
      servicesDts
        .slice(servicesDts.indexOf("interface CreateAgentSessionFromServicesOptions"))
        .includes("baseToolsOverride"),
    create_agent_session_from_services_js_forwards_baseToolsOverride:
      servicesJs.includes("baseToolsOverride: options.baseToolsOverride"),
    create_agent_session_js_forwards_baseToolsOverride:
      sdkJs.includes("baseToolsOverride: options.baseToolsOverride"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPlain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
