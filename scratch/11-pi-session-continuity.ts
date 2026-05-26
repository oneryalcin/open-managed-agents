/**
 * C.3a.0 — Pi capability probe (front-loaded, evidence-first).
 *
 * Answers the three unknowns that gate the C.3a continuity design BEFORE we
 * build any per-session cache or serialization. Do not design the cache from
 * the .d.ts; run this and design from what Pi actually does.
 *
 *   1. CONTINUITY        — does one AgentSession remember turn 1 in turn 2?
 *   2. BUSY-SESSION       — what do prompt/followUp/steer do mid-turn?
 *                           (maps user.message -> followUp, user.interrupt -> steer/abort)
 *   3. ABORT SURVIVABILITY — after abort(), is the same session still usable,
 *                           or must we evict + recreate it?
 *
 * This is an OBSERVATION probe (like scratch/10). It records what happens and
 * prints verdicts; it does not hard-assert behavior we don't yet know.
 *
 * Cost note: makes ~6-8 real model calls. Uses haiku. Requires ANTHROPIC_API_KEY.
 *   ANTHROPIC_API_KEY=... npx tsx scratch/11-pi-session-continuity.ts
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
const RUN_TIMEOUT_MS = 60_000;

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

/** A live AgentSession plus observation state captured from its event stream. */
interface Probe {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  /** true between agent_start and agent_end. */
  running: () => boolean;
  /** assistant text assembled per completed assistant message_end, in order. */
  assistantTexts: () => string[];
  /** every raw event type seen, in order (for ordering analysis). */
  eventTypes: () => string[];
  dispose: () => void;
}

async function makeProbe(): Promise<Probe> {
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

  let running = false;
  const assistantTexts: string[] = [];
  const eventTypes: string[] = [];

  const stop = session.subscribe((event: unknown) => {
    const e = event as { type?: string; message?: { role?: string; content?: unknown } };
    if (typeof e.type !== "string") return;
    eventTypes.push(e.type);
    if (e.type === "agent_start") running = true;
    if (e.type === "agent_end") running = false;
    if (e.type === "message_end" && e.message?.role === "assistant") {
      const blocks = Array.isArray(e.message.content) ? e.message.content : [];
      const text = blocks
        .filter((b): b is { type: string; text: string } =>
          typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text",
        )
        .map((b) => b.text)
        .join("");
      if (text.length > 0) assistantTexts.push(text);
    }
  });

  return {
    session,
    running: () => running,
    assistantTexts: () => [...assistantTexts],
    eventTypes: () => [...eventTypes],
    dispose: () => {
      stop();
      session.dispose();
    },
  };
}

/** Resolve once `cond()` is true, or reject on timeout. Polls every 25ms. */
function waitUntil(cond: () => boolean, label: string, timeoutMs = RUN_TIMEOUT_MS): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error(`timeout: ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** Record the outcome of an interfering call made while the agent is mid-turn. */
async function recordOutcome(label: string, fn: () => Promise<void>): Promise<unknown> {
  const startedAt = Date.now();
  try {
    await fn();
    return { label, outcome: "resolved", ms: Date.now() - startedAt };
  } catch (error) {
    return { label, outcome: "threw", message: String((error as Error)?.message ?? error) };
  }
}

const UNIQUE = `lighthouse-${Math.random().toString(36).slice(2, 8)}`;

// ── Probe 1: continuity ───────────────────────────────────────────────────
async function probeContinuity(): Promise<unknown> {
  const p = await makeProbe();
  try {
    await p.session.prompt(`Remember this exact phrase, reply only "ok": ${UNIQUE}`);
    await p.session.prompt(
      "What exact phrase did I ask you to remember? Reply with only the phrase.",
    );
    const texts = p.assistantTexts();
    const turn2 = texts[texts.length - 1] ?? "";
    return {
      probe: "continuity",
      uniquePhrase: UNIQUE,
      assistantTurns: texts.length,
      turn2Text: turn2,
      remembered: turn2.includes(UNIQUE),
      verdict: turn2.includes(UNIQUE)
        ? "CONTINUITY WORKS: one AgentSession accumulates context across prompt() calls."
        : "NO CONTINUITY: turn 2 did not recall turn 1 — investigate before C.3a.",
    };
  } finally {
    p.dispose();
  }
}

// ── Probe 2: busy-session behavior ─────────────────────────────────────────
// Each sub-scenario: fresh session, start a long turn (do NOT await), wait
// until running, fire ONE interfering call, record what it does, then drain.
async function probeBusy(): Promise<unknown> {
  const longPrompt =
    "Count from 1 to 25. Put each number on its own line with a one-sentence note.";

  async function scenario(
    label: string,
    interfere: (p: Probe) => Promise<void>,
  ): Promise<unknown> {
    const p = await makeProbe();
    try {
      const firstTurn = p.session.prompt(longPrompt).catch((e) => ({ firstThrew: String(e) }));
      await waitUntil(() => p.running(), `${label}: first turn to start`);
      const outcome = await recordOutcome(label, () => interfere(p));
      await Promise.race([
        firstTurn,
        waitUntil(() => !p.running(), `${label}: first turn to finish`),
      ]);
      // brief settle for any queued follow-up to surface
      await new Promise((r) => setTimeout(r, 500));
      return { ...(outcome as object), assistantTurnsAfter: p.assistantTexts().length };
    } finally {
      p.dispose();
    }
  }

  return {
    probe: "busy-session",
    note: "Maps the right Pi mechanism for user.message-while-running vs user.interrupt.",
    scenarios: [
      await scenario("prompt() no streamingBehavior (expect throw per docstring)", (p) =>
        p.session.prompt("also, say hi"),
      ),
      await scenario("prompt({streamingBehavior:'followUp'})", (p) =>
        p.session.prompt("also, say hi", { streamingBehavior: "followUp" }),
      ),
      await scenario("prompt({streamingBehavior:'steer'})", (p) =>
        p.session.prompt("STOP counting and say DONE", { streamingBehavior: "steer" }),
      ),
      await scenario("followUp()", (p) => p.session.followUp("also, say hi")),
      await scenario("steer()", (p) => p.session.steer("STOP counting and say DONE")),
    ],
  };
}

// ── Probe 3: abort survivability ───────────────────────────────────────────
async function probeAbortSurvivability(): Promise<unknown> {
  const p = await makeProbe();
  try {
    const firstTurn = p.session
      .prompt("Count slowly from 1 to 50, one number per line.")
      .catch((e) => ({ firstThrew: String(e) }));
    await waitUntil(() => p.running(), "abort: first turn to start");
    await p.session.abort();
    await firstTurn; // findings say prompt() resolves rather than throws on abort

    // Now the critical question: is the SAME session still usable?
    const reuse = await recordOutcome("prompt-after-abort", async () => {
      await p.session.prompt('Reply with exactly: "alive"');
    });
    const texts = p.assistantTexts();
    const lastText = texts[texts.length - 1] ?? "";
    return {
      probe: "abort-survivability",
      reuse,
      sawAliveReply: lastText.toLowerCase().includes("alive"),
      verdict:
        (reuse as { outcome?: string }).outcome === "resolved" &&
        lastText.toLowerCase().includes("alive")
          ? "SURVIVES: same AgentSession is reusable after abort() — no forced eviction needed."
          : "POISONED/UNCLEAR: abort() leaves the session unusable — C.3a must evict + recreate on abort.",
    };
  } finally {
    p.dispose();
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const results: Record<string, unknown> = { model: `${PROVIDER}/${MODEL_ID}` };

  for (const [key, fn] of [
    ["continuity", probeContinuity],
    ["busy", probeBusy],
    ["abort", probeAbortSurvivability],
  ] as const) {
    try {
      results[key] = await fn();
    } catch (error) {
      results[key] = { probe: key, error: String((error as Error)?.message ?? error) };
    }
    console.log(`\n=== ${key} ===`);
    console.log(JSON.stringify(results[key], null, 2));
  }

  const summaryPath = join(OUT_DIR, "_capability-summary.json");
  writeFileSync(summaryPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nWrote ${summaryPath}`);
}

void main();
