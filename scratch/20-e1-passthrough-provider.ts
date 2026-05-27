/**
 * Probe 20 — Cycle E.1 guarded host-passthrough provider.
 *
 * Goal:
 *   Verify the PiSessionRunner can route a real Pi builtin bash call through
 *   the provider boundary introduced in E.1. This provider is intentionally
 *   non-isolating and guarded; it is a deterministic lifecycle/test double, not
 *   a sandbox for untrusted prompts.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx scratch/20-e1-passthrough-provider.ts
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiSessionRunner } from "../src/control-plane/sessions/pi/runner.ts";
import {
  createHostPassthroughSandboxProvider,
  type SandboxProvider,
} from "../src/control-plane/sessions/pi/sandbox/provider.ts";

const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "pi-sandbox");
const MARKER = `E1_PASSTHROUGH_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

const workspaceRoot = await mkdtemp(join(tmpdir(), "oma-e1-passthrough-"));
let provider: SandboxProvider | undefined;
const runner = new PiSessionRunner({
  idleTtlMs: 0,
  sandboxProviderFactory: async () => {
    provider = createHostPassthroughSandboxProvider({
      workspaceRoot,
      unsafeAllowHostPassthrough: true,
      envAllowlist: ["PATH"],
    });
    return provider;
  },
});

const events: unknown[] = [];
try {
  for await (const event of runner.runUserMessage(
    "wrk_default",
    "sesn_e1_passthrough",
    [
      "Use the bash tool exactly once.",
      `Run this exact command: printf '${MARKER}\\n'`,
      `After the tool result, reply exactly with: ${MARKER}`,
      "Do not answer from memory; use the bash tool.",
    ].join(" "),
  )) {
    events.push(toPlain(event));
  }
} finally {
  runner.close();
  await rm(workspaceRoot, { force: true, recursive: true });
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
const providerInvocationCount = provider?.invocations.total ?? 0;

await mkdir(OUT_DIR, { recursive: true });
await writeFile(
  join(OUT_DIR, "passthrough_provider.jsonl"),
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
  marker: MARKER,
  workspace_root_removed: true,
  provider: "host-passthrough",
  provider_is_isolating: false,
  env_allowlist: ["PATH"],
  provider_invocation_count: providerInvocationCount,
  provider_invocations_by_tool: provider?.invocations.byTool ?? null,
  event_types: eventTypes,
  final_text: finalText,
  verdict:
    providerInvocationCount > 0 && finalText.includes(MARKER) ? "PASS" : "FAIL",
};
await writeFile(
  join(OUT_DIR, "_e1-passthrough-provider-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPlain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
