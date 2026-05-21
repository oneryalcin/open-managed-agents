/**
 * Probe 01 — smoke-test Pi boot + auth
 *
 * Goal: confirm that with only `ANTHROPIC_API_KEY` in env (no `pi login` needed),
 * we can boot an AgentSession, send a prompt, and observe events.
 *
 * Also captures the full event taxonomy emitted by Pi for one trivial prompt —
 * useful baseline for ADRs 0001/0005 and for designing our event translation layer.
 *
 * Run: ANTHROPIC_API_KEY=... npx tsx scratch/01-smoke.ts
 */

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const start = Date.now();
const eventCounts = new Map<string, number>();

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// Inspect what auth Pi believes it has.
const available = await modelRegistry.getAvailable();
console.log(
  `Available models (per Pi): ${available.map((m) => `${m.provider}/${m.id}`).join(", ") || "(none)"}`,
);

// Force Haiku 4.5 — cheapest model that's good enough for behavioral probes.
const model = modelRegistry.find("anthropic", "claude-haiku-4-5");
if (!model) {
  console.error("FAIL: modelRegistry.find returned null for anthropic/claude-haiku-4-5");
  process.exit(1);
}
console.log(`Model: ${model.provider}/${model.id}`);

console.log("---");
console.log("Booting AgentSession...");

const { session } = await createAgentSession({
  model,
  thinkingLevel: "off",
  authStorage,
  modelRegistry,
  sessionManager: SessionManager.inMemory(),
});

console.log(`Session booted. sessionId=${session.sessionId}`);
console.log(`Tools registered on session: ${session.state.tools.length}`);
for (const t of session.state.tools) {
  // AgentTool exposes .name; other fields vary by implementation
  // deno-lint-ignore no-explicit-any
  console.log(`  - tool: ${(t as any).name}`);
}

try {
  session.subscribe((event) => {
    const type = event.type;
    eventCounts.set(type, (eventCounts.get(type) ?? 0) + 1);

    // Mirror assistant text deltas to stdout so we see the model response live.
    if (type === "message_update") {
      // deno-lint-ignore no-explicit-any
      const inner = (event as any).assistantMessageEvent;
      if (inner?.type === "text_delta") {
        process.stdout.write(inner.delta);
      }
    }
  });

  console.log("\n--- prompt ---");
  await session.prompt("Reply with exactly the words: hello from pi");
  console.log("\n--- /prompt ---\n");

  console.log("Event taxonomy:");
  for (const [type, count] of [...eventCounts.entries()].sort()) {
    console.log(`  ${type}: ${count}`);
  }
  console.log(`Messages in session.state: ${session.state.messages.length}`);
  console.log(`Total duration: ${Date.now() - start}ms`);
} finally {
  session.dispose();
}
