/**
 * Probe 14 — Cycle C live reconnect validation through a real Pi run.
 *
 * Verifies the C.3-specific reconnect case: the SSE client disconnects after
 * runtime execution has started, while Pi is still producing events
 * asynchronously in the background. Reconnect uses Last-Event-ID, then the
 * probe confirms the final event set is recoverable through both stream and
 * list without loss or duplicate IDs.
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx tsx scratch/14-c3-live-reconnect.ts
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

const UNIQUE = `C3_RECONNECT_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const STREAM_TIMEOUT_MS = 90_000;
const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "pi-session-probe");

const agentStore = SqliteAgentStore.open(":memory:");
const environmentStore = SqliteEnvironmentStore.open(":memory:");
const sessionStore = SqliteSessionStore.open(":memory:");
const eventStore = EventStore.open(":memory:");
const broadcaster = new SessionEventBroadcaster(eventStore);
const runner = new PiSessionRunner();
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
  name: "Probe Agent C3 Reconnect",
  model: "claude-haiku-4-5",
  tools: [{ type: "agent_toolset_20260401" }],
})) as { id: string };
const environment = (await create("/v1/environments", {
  name: "Probe Environment C3 Reconnect",
  config: { type: "cloud", networking: { type: "unrestricted" } },
})) as { id: string };
const session = (await create("/v1/sessions", {
  agent: agent.id,
  environment_id: environment.id,
})) as { id: string };

console.log(`session=${session.id}`);
console.log(`unique=${UNIQUE}`);

const firstStream = await openStream(session.id);
const firstReader = sseReader(firstStream);
await waitUntil(() => broadcaster.subscriberCount(session.id) > 0);

await sendMessage(
  session.id,
  `Reply with exactly this token and no other text: ${UNIQUE}`,
);
const beforeDisconnect = await readUntil(
  firstReader,
  (event) => event.data.type === "session.status_running",
);
const lastSeenId = beforeDisconnect.at(-1)?.id;
if (!lastSeenId) throw new Error("Missing Last-Event-ID from first stream");
console.log(`disconnect.after=${lastSeenId}`);
await firstReader.cancel();
await waitUntil(() => broadcaster.subscriberCount(session.id) === 0);

const secondStream = await openStream(session.id, lastSeenId);
const secondReader = sseReader(secondStream);
await waitUntil(() => broadcaster.subscriberCount(session.id) > 0);

const replayAndLive = await readUntil(
  secondReader,
  (event) => event.data.type === "session.status_idle",
);
const consolidated = [...beforeDisconnect, ...replayAndLive];
const list = await getEvents(`/v1/sessions/${session.id}/events?order=asc`);
const streamIds = consolidated.map((event) => event.id);
const listIds = list.data.map((event) => event.id);
const duplicateStreamIds = streamIds.filter(
  (id, index) => id !== undefined && streamIds.indexOf(id) !== index,
);
const streamSawToken = consolidated.some(
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

await secondReader.cancel();
runner.close();
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, "_c3-live-reconnect-summary.json"),
  `${JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      session_id: session.id,
      unique_token: UNIQUE,
      disconnected_after_id: lastSeenId,
      stream_event_count: consolidated.length,
      list_event_count: list.data.length,
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
console.log(`stream.count=${consolidated.length} list.count=${list.data.length}`);
console.log(`event.types=${list.data.map((event) => event.type).join(",")}`);
console.log("verdict=PASS C.3 live reconnect recovered the runtime event log");

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
    throw new Error(`send failed: ${res.status} ${await res.text()}`);
  }
}

async function openStream(sessionId: string, lastEventId?: string): Promise<Response> {
  const res = await app.request(`/v1/sessions/${sessionId}/events/stream`, {
    headers: {
      accept: "text/event-stream",
      ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
    },
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
