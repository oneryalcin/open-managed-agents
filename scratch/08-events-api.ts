/**
 * Probe 08 — Cycle B.2 events.send + events.list smoke
 *
 * Run: npx tsx scratch/08-events-api.ts
 */

import { createInMemoryControlPlaneApp } from "../src/control-plane/app.ts";

const app = createInMemoryControlPlaneApp();

const agent = (await create("/v1/agents", {
  name: "Probe Agent",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
})) as { id: string };
const environment = (await create("/v1/environments", {
  name: "Probe Environment",
  config: { type: "cloud", networking: { type: "unrestricted" } },
})) as { id: string };
const session = (await create("/v1/sessions", {
  agent: agent.id,
  environment_id: environment.id,
})) as { id: string };

console.log(`session=${session.id}`);

await sendEvents(session.id, [
  { type: "user.message", content: [{ type: "text", text: "hello" }] },
]);
await sendEvents(session.id, [
  {
    type: "user.custom_tool_result",
    custom_tool_use_id: "ctu_1",
    content: [{ type: "text", text: "result" }],
  },
]);
await sendEvents(session.id, [
  { type: "user.tool_confirmation", tool_use_id: "tu_1", result: "allow" },
]);

const page1 = await getJson(`/v1/sessions/${session.id}/events?order=asc&limit=2`);
console.log(`page1.count=${page1.data.length} next=${page1.next_page}`);
const page2 = await getJson(
  `/v1/sessions/${session.id}/events?order=asc&limit=2&page=${page1.next_page}`,
);
console.log(`page2.count=${page2.data.length} next=${page2.next_page}`);

const filtered = await getJson(
  `/v1/sessions/${session.id}/events?types[]=user.message`,
);
console.log(`filtered.user.message=${filtered.data.length}`);

const missing = await app.request("/v1/sessions/sesn_missing/events");
const missingBody = (await missing.json()) as {
  error: { type: string; message: string };
};
console.log(
  `missing.status=${missing.status} type=${missingBody.error.type} message=${missingBody.error.message}`,
);

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

async function sendEvents(sessionId: string, events: unknown[]): Promise<void> {
  const res = await app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });
  if (res.status !== 200) {
    throw new Error(`send events failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data: Array<{ type: string }>;
  };
  console.log(`sent ${body.data.length} event(s): ${body.data.map((e) => e.type).join(", ")}`);
}

async function getJson(path: string): Promise<{
  data: Array<{ id: string; type: string }>;
  next_page: string | null;
}> {
  const res = await app.request(path);
  if (res.status !== 200) {
    throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as {
    data: Array<{ id: string; type: string }>;
    next_page: string | null;
  };
}
