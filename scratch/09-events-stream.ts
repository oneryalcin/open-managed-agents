/**
 * Probe 09 — Cycle B.3 stream + reconnect consolidation smoke
 *
 * Run: npx tsx scratch/09-events-stream.ts
 */

import { createInMemoryControlPlaneApp } from "../src/control-plane/app.ts";
import { requestWithManagedAgentsBeta } from "./managed-agents-beta.ts";

const app = createInMemoryControlPlaneApp();

const agent = (await create("/v1/agents", {
  name: "Probe Agent B3",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
})) as { id: string };
const environment = (await create("/v1/environments", {
  name: "Probe Environment B3",
  config: { type: "cloud", networking: { type: "unrestricted" } },
})) as { id: string };
const session = (await create("/v1/sessions", {
  agent: agent.id,
  environment_id: environment.id,
})) as { id: string };

console.log(`session=${session.id}`);

await sendMessage(session.id, "sentinel");

const streamRes = await requestWithManagedAgentsBeta(app, `/v1/sessions/${session.id}/events/stream`, {
  headers: { accept: "text/event-stream" },
});
const reader = sseReader(streamRes);
const replayed = await reader.nextEvent();
console.log(`replay.first=${replayed?.id} ${replayed?.event}`);

await sendMessage(session.id, "live-1");
const live = await reader.nextEvent();
console.log(`live.next=${live?.id} ${live?.event}`);

// Reconnect-with-consolidation: drop stream, emit disconnect-window event,
// open fresh stream, list history, dedupe by event.id.
await reader.cancel();
await sendMessage(session.id, "disconnect-window");

const stream2 = await requestWithManagedAgentsBeta(app, `/v1/sessions/${session.id}/events/stream`, {
  headers: { accept: "text/event-stream" },
});
const reader2 = sseReader(stream2);
const history = await getEvents(`/v1/sessions/${session.id}/events?order=asc`);
const seen = new Set<string>(history.data.map((event) => String(event.id)));
let recovered = false;
for (let i = 0; i < 3; i += 1) {
  const next = await reader2.nextEvent();
  if (!next) break;
  if (!seen.has(next.id)) {
    seen.add(next.id);
  }
  if (next.data.content?.[0]?.text === "disconnect-window") {
    recovered = true;
  }
}
console.log(`reconnect.recovered=${recovered} ids=${seen.size}`);

// Last-Event-ID malformed is fail-open (stream still returns first history event).
const malformed = await requestWithManagedAgentsBeta(app, `/v1/sessions/${session.id}/events/stream`, {
  headers: { "last-event-id": "bad_cursor" },
});
const malformedFirst = await sseReader(malformed).nextEvent();
console.log(`malformed.first=${malformedFirst?.id}`);

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

function sseReader(response: Response): {
  nextEvent(): Promise<{ id: string; event: string; data: any } | null>;
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
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const idx = buffer.indexOf("\n\n");
        if (idx !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = frame.split("\n");
          const parsed: { id?: string; event?: string; data?: string } = {};
          for (const line of lines) {
            if (line.startsWith("id: ")) parsed.id = line.slice(4);
            else if (line.startsWith("event: ")) parsed.event = line.slice(7);
            else if (line.startsWith("data: ")) parsed.data = line.slice(6);
          }
          if (parsed.id && parsed.event && parsed.data) {
            return {
              id: parsed.id,
              event: parsed.event,
              data: JSON.parse(parsed.data),
            };
          }
          continue;
        }
        const next = await reader.read();
        if (next.done) return null;
        buffer += decoder.decode(next.value, { stream: true });
      }
      throw new Error("Timed out waiting for SSE frame");
    },
    async cancel() {
      await reader.cancel();
    },
  };
}
