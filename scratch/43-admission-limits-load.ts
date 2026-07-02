// 0113 D9 evidence probe (#129 slice 4): admission limits must reject
// visibly under concurrent load (429/529, fast) rather than queue silently.
// Shape follows scratch/42-http-sse-load.ts: real HTTP server, real sockets.
//
//   npx tsx scratch/43-admission-limits-load.ts
import { serve } from "@hono/node-server";
import { createDeploymentControlPlaneApp } from "../src/control-plane/app.ts";

const PORT = Number(process.env.OMA_PROBE_PORT ?? 40190);
const BASE = `http://127.0.0.1:${PORT}`;
const BETA = { "anthropic-beta": "managed-agents-2026-04-01" };
const JSON_HEADERS = { ...BETA, "content-type": "application/json" };

const app = createDeploymentControlPlaneApp({
  OMA_AUTH_MODE: "disabled",
  OMA_MAX_ACTIVE_SESSIONS_PER_WORKSPACE: "3",
  OMA_MAX_CONCURRENT_UPLOADS_PER_WORKSPACE: "2",
  OMA_MAX_CONCURRENT_SSE_STREAMS_PER_WORKSPACE: "5",
});
const server = serve({ fetch: app.fetch, port: PORT });
await new Promise((res) => setTimeout(res, 300));

function tally(statuses: number[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const s of statuses) out[s] = (out[s] ?? 0) + 1;
  return out;
}

// --- fixture: one agent + environment ---
const agent = (await (
  await fetch(`${BASE}/v1/agents`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      name: "probe",
      model: "claude-opus-4-7",
      tools: [{ type: "agent_toolset_20260401" }],
    }),
  })
).json()) as { id: string };
const environment = (await (
  await fetch(`${BASE}/v1/environments`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      name: "probe",
      config: { type: "cloud", networking: { type: "unrestricted" } },
    }),
  })
).json()) as { id: string };
const sessionBody = JSON.stringify({
  agent: agent.id,
  environment_id: environment.id,
});

// --- 1. sessions: cap 3, 20 concurrent creates ---
const sessionResults = await Promise.all(
  Array.from({ length: 20 }, async () => {
    const t0 = performance.now();
    const res = await fetch(`${BASE}/v1/sessions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: sessionBody,
    });
    await res.arrayBuffer();
    return { status: res.status, ms: performance.now() - t0 };
  }),
);
const rejected429 = sessionResults.filter((r) => r.status === 429);
console.log("[sessions] cap=3, 20 concurrent creates:", tally(sessionResults.map((r) => r.status)));
console.log(
  "[sessions] 429 latency ms: max",
  Math.max(...rejected429.map((r) => r.ms)).toFixed(1),
  "(fast = rejected, not queued)",
);

// --- 2. uploads: cap 2, 20 concurrent 4MiB uploads ---
const payload = new Uint8Array(4 * 1024 * 1024).fill(65);
const uploadResults = await Promise.all(
  Array.from({ length: 20 }, async () => {
    const form = new FormData();
    form.append("file", new File([payload], "blob.bin", { type: "application/octet-stream" }));
    const t0 = performance.now();
    const res = await fetch(`${BASE}/v1/files`, {
      method: "POST",
      headers: BETA,
      body: form,
    });
    const body = await res.text();
    return {
      status: res.status,
      ms: performance.now() - t0,
      retryAfter: res.headers.get("retry-after"),
      body,
    };
  }),
);
const upload429 = uploadResults.filter((r) => r.status === 429);
console.log("[uploads] cap=2, 20 concurrent 4MiB uploads:", tally(uploadResults.map((r) => r.status)));
if (upload429.length > 0) {
  console.log(
    "[uploads] 429 latency ms: max",
    Math.max(...upload429.map((r) => r.ms)).toFixed(1),
  );
}

const first429 = uploadResults.find((r) => r.status === 429);
console.log(
  "[uploads] first 429: retry-after =",
  first429?.retryAfter,
  "body =",
  first429?.body,
);

// --- 3. SSE streams: cap 5, 20 concurrent opens against one session ---
const sessionId = ((await (
  await fetch(`${BASE}/v1/sessions?limit=1`, { headers: BETA })
).json()) as { data: { id: string }[] }).data[0]!.id;
const streams = await Promise.all(
  Array.from({ length: 20 }, async () => {
    const res = await fetch(`${BASE}/v1/sessions/${sessionId}/events/stream`, {
      headers: BETA,
    });
    if (res.status !== 200) await res.arrayBuffer();
    return res;
  }),
);
console.log("[streams] cap=5, 20 concurrent opens:", tally(streams.map((r) => r.status)));
const open = streams.filter((r) => r.status === 200);
await open[0]!.body!.cancel();
await new Promise((res) => setTimeout(res, 100));
const reopened = await fetch(`${BASE}/v1/sessions/${sessionId}/events/stream`, {
  headers: BETA,
});
console.log("[streams] reopen after one disconnect:", reopened.status);
await reopened.body!.cancel();
for (const s of open.slice(1)) await s.body!.cancel();

server.close();
console.log("done");
