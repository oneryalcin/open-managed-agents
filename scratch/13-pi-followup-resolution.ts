/**
 * Probe 13 — Does prompt() stay alive through queued followUp() turns?
 *
 * This gates the C.3a runner model. If prompt(p1) resolves before the queued
 * followUp(p2) turn emits events, the current "one subscriber on the prompt
 * generator captures follow-up output" model drops real Pi events.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx scratch/13-pi-followup-resolution.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = "anthropic";
const MODEL_ID = "claude-haiku-4-5";
const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "pi-session-probe");
const UNIQUE = `followup-${Math.random().toString(36).slice(2, 8)}`;

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find(PROVIDER, MODEL_ID);
if (!model) throw new Error(`Pi model not available: ${PROVIDER}/${MODEL_ID}`);

const { session } = await createAgentSession({
  model,
  thinkingLevel: "off",
  noTools: "builtin",
  authStorage,
  modelRegistry,
  sessionManager: SessionManager.inMemory(),
});

interface Observation {
  at_ms: number;
  kind: string;
  type?: string;
  text?: string;
}

const startedAt = Date.now();
const observations: Observation[] = [];
let running = false;

const stop = session.subscribe((event: unknown) => {
  const e = event as { type?: string; message?: { role?: string; content?: unknown } };
  if (e.type === "agent_start") running = true;
  if (e.type === "agent_end") running = false;
  observations.push({
    at_ms: Date.now() - startedAt,
    kind: "event",
    type: e.type,
    text: readAssistantText(e),
  });
});

try {
  const p1 = session
    .prompt(
      `First turn: say "first done", then stop. Do not mention ${UNIQUE}.`,
    )
    .then(() => {
      observations.push({ at_ms: Date.now() - startedAt, kind: "prompt_resolved" });
    })
    .catch((error) => {
      observations.push({
        at_ms: Date.now() - startedAt,
        kind: "prompt_threw",
        text: String((error as Error)?.message ?? error),
      });
    });

  await waitUntil(() => running, "first turn running");
  await session.followUp(
    `Second queued turn: reply with exactly this token and nothing else: ${UNIQUE}`,
  );
  observations.push({ at_ms: Date.now() - startedAt, kind: "followup_accepted" });

  await p1;
  await waitUntil(
    () => observations.some((o) => o.text?.includes(UNIQUE) === true),
    "queued follow-up assistant text",
  );

  const promptResolvedAt = observations.find((o) => o.kind === "prompt_resolved")?.at_ms;
  const followupTextAt = observations.find((o) => o.text?.includes(UNIQUE) === true)?.at_ms;
  const verdict =
    promptResolvedAt !== undefined &&
    followupTextAt !== undefined &&
    promptResolvedAt >= followupTextAt
      ? "SAFE: prompt() resolved after queued followUp() output was emitted."
      : "UNSAFE: prompt() resolved before queued followUp() output was emitted.";

  const summary = {
    generated_at: new Date().toISOString(),
    model: `${PROVIDER}/${MODEL_ID}`,
    unique_token: UNIQUE,
    prompt_resolved_at_ms: promptResolvedAt,
    followup_text_at_ms: followupTextAt,
    verdict,
    observations,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, "_followup-resolution-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  stop();
  session.dispose();
}

function readAssistantText(event: {
  type?: string;
  message?: { role?: string; content?: unknown };
}): string | undefined {
  if (event.type !== "message_end" || event.message?.role !== "assistant") {
    return undefined;
  }
  const blocks = Array.isArray(event.message.content) ? event.message.content : [];
  const text = blocks
    .filter((block): block is { type: string; text: string } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
  return text.length > 0 ? text : undefined;
}

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
