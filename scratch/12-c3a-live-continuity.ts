/**
 * Probe 12 — Cycle C.3a live continuity through events.list + events.stream.
 *
 * Verifies the ADR 0012 gate against the control-plane surface:
 *   1. one sesn_* keeps one Pi AgentSession across two user.message turns
 *   2. translated runtime events land in events.stream
 *   3. the same events are replayable via events.list
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx scratch/12-c3a-live-continuity.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createControlPlaneApp } from "../src/control-plane/app.ts";
import { requestWithManagedAgentsBeta } from "./managed-agents-beta.ts";
import { DefaultAgentService } from "../src/control-plane/agents/service.ts";
import { SqliteAgentStore } from "../src/control-plane/agents/store.ts";
import { DefaultEnvironmentService } from "../src/control-plane/environments/service.ts";
import { SqliteEnvironmentStore } from "../src/control-plane/environments/store.ts";
import { createBestEffortRuntimeEventCoordinator } from "../src/control-plane/deployment-runtime-event-coordinator.ts";
import { SessionEventBroadcaster } from "../src/control-plane/events/broadcaster.ts";
import { DefaultSessionEventsService } from "../src/control-plane/events/service.ts";
import { EventStore } from "../src/control-plane/events/store.ts";
import { DefaultSessionService } from "../src/control-plane/sessions/service.ts";
import { PiSessionRunner } from "../src/control-plane/sessions/pi/runner.ts";
import { translatePiEvent } from "../src/control-plane/sessions/pi/translator.ts";
import { SqliteSessionStore } from "../src/control-plane/sessions/store.ts";

const UNIQUE = `c3a-${Math.random().toString(36).slice(2, 8)}`;
const STREAM_TIMEOUT_MS = 90_000;
const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "pi-session-probe");

const agentStore = SqliteAgentStore.open(":memory:");
const environmentStore = SqliteEnvironmentStore.open(":memory:");
const sessionStore = SqliteSessionStore.open(":memory:");
const eventStore = EventStore.open(":memory:");
const broadcaster = new SessionEventBroadcaster(eventStore);
const runner = new PiSessionRunner();
const app = createControlPlaneApp({
  agents: new DefaultAgentService(agentStore, undefined),
  environments: new DefaultEnvironmentService(environmentStore),
  sessions: new DefaultSessionService(sessionStore, agentStore, environmentStore, undefined, { assertDeletable: () => {} }),
  sessionEvents: new DefaultSessionEventsService(eventStore, sessionStore, broadcaster, {
    runner,
    translate: translatePiEvent,
    runtimeEventCoordinator: createBestEffortRuntimeEventCoordinator({
      sessions: sessionStore,
      events: eventStore,
    }),
  }),
});

const agent = (await create("/v1/agents", {
  name: "Probe Agent C3a",
  model: "claude-haiku-4-5",
  tools: [{ type: "agent_toolset_20260401" }],
})) as { id: string };
const environment = (await create("/v1/environments", {
  name: "Probe Environment C3a",
  config: { type: "cloud", networking: { type: "unrestricted" } },
})) as { id: string };
const session = (await create("/v1/sessions", {
  agent: agent.id,
  environment_id: environment.id,
})) as { id: string };

console.log(`session=${session.id}`);
console.log(`unique=${UNIQUE}`);

const streamRes = await requestWithManagedAgentsBeta(app, `/v1/sessions/${session.id}/events/stream`, {
  headers: { accept: "text/event-stream" },
});
const stream = sseReader(streamRes);
await waitUntil(() => broadcaster.subscriberCount(session.id) > 0);

await sendMessage(
  session.id,
  `Remember this exact phrase for the next turn. Reply with only "ok": ${UNIQUE}`,
);
await waitForStreamEvent(stream, (event) => event.type === "session.status_idle");

await sendMessage(
  session.id,
  "What exact phrase did I ask you to remember? Reply with only the phrase.",
);
const recalled = await waitForStreamEvent(
  stream,
  (event) =>
    event.type === "agent.message" &&
    JSON.stringify(event).includes(UNIQUE),
);
await waitForStreamEvent(stream, (event) => event.type === "session.status_idle");

const list = await getEvents(`/v1/sessions/${session.id}/events?order=asc`);
const listedRecall = list.data.some(
  (event) => event.type === "agent.message" && JSON.stringify(event).includes(UNIQUE),
);
if (!listedRecall) {
  throw new Error("events.list did not contain the recalled phrase");
}

await stream.cancel();
runner.close();
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, "_c3a-live-continuity-summary.json"),
  `${JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      session_id: session.id,
      unique_phrase: UNIQUE,
      stream_recalled_event_id: recalled.id,
      stream_recalled_type: recalled.type,
      list_count: list.data.length,
      listed_recall: listedRecall,
      verdict: "PASS",
    },
    null,
    2,
  )}\n`,
);
console.log(`stream.recalled=${recalled.id} ${recalled.type}`);
console.log(`list.count=${list.data.length} listedRecall=${listedRecall}`);
console.log("verdict=PASS C.3a live continuity works through events.stream and events.list");

async function create(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await requestWithManagedAgentsBeta(app, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    throw new Error(`create ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function sendMessage(sessionId: string, text: string): Promise<void> {
  const res = await requestWithManagedAgentsBeta(app, `/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    }),
  });
  if (res.status !== 200) {
    throw new Error(`send failed: ${res.status} ${await res.text()}`);
  }
}

async function getEvents(path: string): Promise<{
  data: Array<Record<string, unknown>>;
  next_page: string | null;
}> {
  const res = await requestWithManagedAgentsBeta(app, path);
  if (res.status !== 200) {
    throw new Error(`list failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as {
    data: Array<Record<string, unknown>>;
    next_page: string | null;
  };
}

async function waitForStreamEvent(
  reader: ReturnType<typeof sseReader>,
  predicate: (event: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + STREAM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const frame = await reader.nextEvent();
    if (predicate(frame.data)) return frame.data;
  }
  throw new Error("Timed out waiting for matching stream event");
}

function sseReader(response: Response): {
  nextEvent(): Promise<{ id: string; event: string; data: Record<string, unknown> }>;
  cancel(): Promise<void>;
} {
  if (!response.body) {
    throw new Error("Expected streaming body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async nextEvent() {
      const deadline = Date.now() + STREAM_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const idx = buffer.indexOf("\n\n");
        if (idx !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseFrame(frame);
          if (parsed) return parsed;
          continue;
        }
        const next = await reader.read();
        if (next.done) throw new Error("SSE stream ended");
        buffer += decoder.decode(next.value, { stream: true });
      }
      throw new Error("Timed out waiting for SSE frame");
    },
    async cancel() {
      await reader.cancel();
    },
  };
}

function parseFrame(
  frame: string,
): { id: string; event: string; data: Record<string, unknown> } | undefined {
  const parsed: { id?: string; event?: string; data?: string } = {};
  for (const line of frame.split("\n")) {
    if (line.startsWith("id: ")) parsed.id = line.slice(4);
    else if (line.startsWith("event: ")) parsed.event = line.slice(7);
    else if (line.startsWith("data: ")) parsed.data = line.slice(6);
  }
  if (!parsed.id || !parsed.event || !parsed.data) return undefined;
  return {
    id: parsed.id,
    event: parsed.event,
    data: JSON.parse(parsed.data) as Record<string, unknown>,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
