/**
 * Probe 16 — Cycle D live custom-tool round trip through the public events API.
 *
 * Verifies the Managed Agents custom-tool path end to end:
 * user.message -> agent.custom_tool_use + requires_action -> user.custom_tool_result
 * -> resumed Pi run -> agent.message + final end_turn idle.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx scratch/16-d-custom-tool-roundtrip.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createControlPlaneApp } from "../src/control-plane/app.ts";
import { DefaultAgentService } from "../src/control-plane/agents/service.ts";
import { SqliteAgentStore } from "../src/control-plane/agents/store.ts";
import { DefaultEnvironmentService } from "../src/control-plane/environments/service.ts";
import { SqliteEnvironmentStore } from "../src/control-plane/environments/store.ts";
import { SessionEventBroadcaster } from "../src/control-plane/events/broadcaster.ts";
import { DefaultSessionEventsService } from "../src/control-plane/events/service.ts";
import { EventStore } from "../src/control-plane/events/store.ts";
import { DefaultSessionService } from "../src/control-plane/sessions/service.ts";
import { PiSessionRunner } from "../src/control-plane/sessions/pi/runner.ts";
import { translatePiEvent } from "../src/control-plane/sessions/pi/translator.ts";
import { SqliteSessionStore } from "../src/control-plane/sessions/store.ts";

const UNIQUE = `D_CUSTOM_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const STREAM_TIMEOUT_MS = 120_000;
const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "pi-custom-tools");
const CUSTOM_TOOL = {
  type: "custom" as const,
  name: "ask_external",
  description: "Ask the API caller for external information.",
  input_schema: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  },
};

const agentStore = SqliteAgentStore.open(":memory:");
const environmentStore = SqliteEnvironmentStore.open(":memory:");
const sessionStore = SqliteSessionStore.open(":memory:");
const eventStore = EventStore.open(":memory:");
const broadcaster = new SessionEventBroadcaster(eventStore);
const runner = new PiSessionRunner({
  customTools: () => [CUSTOM_TOOL],
});
const app = createControlPlaneApp({
  agents: new DefaultAgentService(agentStore),
  environments: new DefaultEnvironmentService(environmentStore),
  sessions: new DefaultSessionService(sessionStore, agentStore, environmentStore),
  sessionEvents: new DefaultSessionEventsService(eventStore, sessionStore, broadcaster, {
    runner,
    translate: translatePiEvent,
  }),
});

const agent = (await create("/v1/agents", {
  name: "Probe Agent D Custom Tool",
  model: "claude-haiku-4-5",
  tools: [CUSTOM_TOOL],
})) as { id: string };
const environment = (await create("/v1/environments", {
  name: "Probe Environment D Custom Tool",
  config: { type: "cloud", networking: { type: "unrestricted" } },
})) as { id: string };
const session = (await create("/v1/sessions", {
  agent: agent.id,
  environment_id: environment.id,
})) as { id: string };

console.log(`session=${session.id}`);
console.log(`unique=${UNIQUE}`);

const stream = await openStream(session.id);
const reader = sseReader(stream);
await waitUntil(() => broadcaster.subscriberCount(session.id) > 0);

await sendMessage(
  session.id,
  [
    "Call ask_external exactly once with question='probe-16'.",
    `After the tool returns, reply with exactly this token and no other text: ${UNIQUE}`,
  ].join(" "),
);

const untilRequiresAction = await readUntil(
  reader,
  (event) =>
    event.data.type === "session.status_idle" &&
    (event.data.stop_reason as { type?: unknown } | undefined)?.type ===
      "requires_action",
);
const customUse = untilRequiresAction.find(
  (event) => event.data.type === "agent.custom_tool_use",
);
if (!customUse) throw new Error("Missing agent.custom_tool_use before requires_action");
const requiresAction = untilRequiresAction.at(-1);
const eventIds = (requiresAction?.data.stop_reason as { event_ids?: unknown })
  .event_ids;
if (!Array.isArray(eventIds) || eventIds[0] !== customUse.id) {
  throw new Error(
    `requires_action did not point at custom use id: ${JSON.stringify(eventIds)}`,
  );
}

await sendCustomToolResult(session.id, customUse.id, UNIQUE);
const afterResult = await readUntil(
  reader,
  (event) =>
    event.data.type === "session.status_idle" &&
    (event.data.stop_reason as { type?: unknown } | undefined)?.type === "end_turn",
);
const streamEvents = [...untilRequiresAction, ...afterResult];
const list = await getEvents(`/v1/sessions/${session.id}/events?order=asc`);
const streamIds = streamEvents.map((event) => event.id);
const listIds = list.data.map((event) => event.id);
const duplicateStreamIds = streamIds.filter(
  (id, index) => streamIds.indexOf(id) !== index,
);
const streamSawToken = streamEvents.some(
  (event) => event.data.type === "agent.message" && JSON.stringify(event.data).includes(UNIQUE),
);
const listSawToken = list.data.some(
  (event) => event.type === "agent.message" && JSON.stringify(event).includes(UNIQUE),
);

if (duplicateStreamIds.length > 0) {
  throw new Error(`stream had duplicate IDs: ${duplicateStreamIds.join(", ")}`);
}
if (JSON.stringify(streamIds) !== JSON.stringify(listIds)) {
  throw new Error(
    `stream/list mismatch\nstream=${JSON.stringify(streamIds)}\nlist=${JSON.stringify(listIds)}`,
  );
}
if (!streamSawToken || !listSawToken) {
  throw new Error(`missing token in stream/list: stream=${streamSawToken} list=${listSawToken}`);
}

await reader.cancel();
runner.close();
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, "_d-live-custom-tool-roundtrip-summary.json"),
  `${JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      session_id: session.id,
      unique_token: UNIQUE,
      custom_tool_use_id: customUse.id,
      stream_ids_match_list: true,
      duplicate_stream_ids: [],
      stream_saw_token: streamSawToken,
      list_saw_token: listSawToken,
      event_types: list.data.map((event) => event.type),
      verdict: "PASS",
    },
    null,
    2,
  )}\n`,
);
console.log(`event.types=${list.data.map((event) => event.type).join(",")}`);
console.log("verdict=PASS D custom tool round trip completed through stream and list");

async function create(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await app.request(path, {
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
  const res = await app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    }),
  });
  if (res.status !== 200) {
    throw new Error(`send message failed: ${res.status} ${await res.text()}`);
  }
}

async function sendCustomToolResult(
  sessionId: string,
  customToolUseId: string,
  result: string,
): Promise<void> {
  const res = await app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [
        {
          type: "user.custom_tool_result",
          custom_tool_use_id: customToolUseId,
          content: [{ type: "text", text: result }],
          is_error: false,
        },
      ],
    }),
  });
  if (res.status !== 200) {
    throw new Error(`send custom tool result failed: ${res.status} ${await res.text()}`);
  }
}

async function openStream(sessionId: string): Promise<Response> {
  const res = await app.request(`/v1/sessions/${sessionId}/events/stream`, {
    headers: { accept: "text/event-stream" },
  });
  if (res.status !== 200) {
    throw new Error(`stream failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

async function getEvents(path: string): Promise<{
  data: Array<Record<string, unknown>>;
  next_page: string | null;
}> {
  const res = await app.request(path);
  if (res.status !== 200) {
    throw new Error(`list failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as {
    data: Array<Record<string, unknown>>;
    next_page: string | null;
  };
}

function sseReader(response: Response): {
  nextEvent(): Promise<{ id: string; event: string; data: Record<string, unknown> }>;
  cancel(): Promise<void>;
} {
  if (!response.body) throw new Error("Expected streaming body");
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

async function readUntil(
  reader: ReturnType<typeof sseReader>,
  predicate: (event: { id: string; event: string; data: Record<string, unknown> }) => boolean,
): Promise<Array<{ id: string; event: string; data: Record<string, unknown> }>> {
  const events: Array<{ id: string; event: string; data: Record<string, unknown> }> = [];
  while (true) {
    const event = await reader.nextEvent();
    events.push(event);
    if (predicate(event)) return events;
  }
}

function parseFrame(frame: string): {
  id: string;
  event: string;
  data: Record<string, unknown>;
} | null {
  if (frame.trim().length === 0) return null;
  let id = "";
  let event = "";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data = line.slice(6);
  }
  if (!id || !event || !data) return null;
  return { id, event, data: JSON.parse(data) as Record<string, unknown> };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + STREAM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for predicate");
}
