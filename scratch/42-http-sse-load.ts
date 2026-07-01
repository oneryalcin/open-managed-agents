/**
 * Probe 42 — HTTP/SSE streaming load harness for #107.
 *
 * This picks up where Probe 41 stops. Probe 41 clears the direct SQLite commit
 * path and in-memory broadcaster fan-out. Probe 42 runs a real Hono Node server
 * and real HTTP clients so SSE frame serialization, response streaming, and
 * stalled readers are in the measurement.
 *
 * Run:
 *   fnm exec --using 24.18.0 -- npx tsx scratch/42-http-sse-load.ts
 *
 * Tunables:
 *   OMA_HTTP_SSE_SESSIONS=200
 *   OMA_HTTP_SSE_EVENTS_PER_REQUEST=5
 *   OMA_HTTP_SSE_BURSTS=1
 *   OMA_HTTP_SSE_FAST_CLIENTS_PER_SESSION=1
 *   OMA_HTTP_SSE_STALLED_CLIENTS=1
 *   OMA_HTTP_SSE_DRAIN_TIMEOUT_MS=10000
 */

import { serve } from "@hono/node-server";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createControlPlaneApp } from "../src/control-plane/app.ts";
import { DefaultAgentService } from "../src/control-plane/agents/service.ts";
import { DefaultEnvironmentService } from "../src/control-plane/environments/service.ts";
import { SessionEventBroadcaster } from "../src/control-plane/events/broadcaster.ts";
import { DefaultSessionEventsService } from "../src/control-plane/events/service.ts";
import { DefaultFileService } from "../src/control-plane/files/service.ts";
import { DefaultSessionService } from "../src/control-plane/sessions/service.ts";
import type { SessionRow } from "../src/control-plane/sessions/types.ts";
import { createDeploymentStoresFromEnv } from "../src/control-plane/deployment-storage.ts";
import { withManagedAgentsBeta } from "./managed-agents-beta.ts";

const WORKSPACE_ID = "wrk_default";
const RUN_ID = `probe42_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "http-sse-load");

const sessionCount = parsePositiveEnv("OMA_HTTP_SSE_SESSIONS", 200);
const eventsPerRequest = parsePositiveEnv("OMA_HTTP_SSE_EVENTS_PER_REQUEST", 5);
const burstCount = parsePositiveEnv("OMA_HTTP_SSE_BURSTS", 1);
const fastClientsPerSession = parseNonNegativeEnv(
  "OMA_HTTP_SSE_FAST_CLIENTS_PER_SESSION",
  1,
);
const stalledClientCount = parseNonNegativeEnv("OMA_HTTP_SSE_STALLED_CLIENTS", 1);
const drainTimeoutMs = parsePositiveEnv("OMA_HTTP_SSE_DRAIN_TIMEOUT_MS", 10_000);

const runRoot = join(tmpdir(), `${RUN_ID}-`);
const sqlitePath = join(runRoot, "oma.sqlite");
const objectRoot = join(runRoot, "objects");

await mkdir(runRoot, { recursive: true });
await mkdir(OUT_DIR, { recursive: true });

const stores = createDeploymentStoresFromEnv({
  OMA_SQLITE_PATH: sqlitePath,
  OMA_FILE_STORAGE_ROOT: objectRoot,
});
const broadcaster = new SessionEventBroadcaster(stores.events);
const app = createControlPlaneApp({
  agents: new DefaultAgentService(stores.agents),
  environments: new DefaultEnvironmentService(stores.environments),
  files: new DefaultFileService(stores.files),
  sessions: new DefaultSessionService(
    stores.sessions,
    stores.agents,
    stores.environments,
    stores.files,
    {
      idempotencyLedger: stores.events,
      createSessionRowsWithIdempotency:
        stores.sessions.createAndCompleteIdempotency.bind(stores.sessions),
    },
  ),
  sessionEvents: new DefaultSessionEventsService(
    stores.events,
    stores.sessions,
    broadcaster,
  ),
});

const server = serve({ fetch: app.fetch, port: 0 });
const address = server.address();
if (address === null || typeof address === "string") {
  throw new Error("Expected TCP server address");
}
const baseUrl = `http://127.0.0.1:${address.port}`;

const sessionIds = Array.from(
  { length: sessionCount },
  (_, index) => `sesn_http_${RUN_ID}_${index.toString().padStart(4, "0")}`,
);

const fastClients: FastSseClient[] = [];
const stalledClients: StalledSseClient[] = [];
const startedAt = new Date().toISOString();
const memoryBefore = memorySnapshot();

try {
  for (const [index, sessionId] of sessionIds.entries()) {
    stores.sessions.create({
      row: sessionRow(sessionId, index),
      snapshots: [],
    });
  }

  await startFastClients();
  await startStalledClients();
  await waitForSubscribers(
    sessionIds,
    fastClients.length + stalledClients.length,
    5_000,
  );

  const burstSummaries: HttpBurstSummary[] = [];
  for (let burst = 0; burst < burstCount; burst += 1) {
    burstSummaries.push(await sendHttpBurst(burst));
  }

  const expectedFastEvents =
    fastClients.length * eventsPerRequest * burstCount;
  const drain = await waitForFastClients(expectedFastEvents, drainTimeoutMs);
  const memoryAfterDrain = memorySnapshot();

  await closeClients();
  await waitForSubscribers(sessionIds, 0, 5_000);
  const memoryAfterClose = memorySnapshot();

  const summary = {
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    run_id: RUN_ID,
    verdict:
      drain.delivered_events === expectedFastEvents ? "PASS" : "PARTIAL_DELIVERY",
    config: {
      session_count: sessionCount,
      events_per_request: eventsPerRequest,
      burst_count: burstCount,
      fast_clients_per_session: fastClientsPerSession,
      stalled_clients: stalledClientCount,
      drain_timeout_ms: drainTimeoutMs,
    },
    server: {
      base_url: baseUrl,
    },
    storage: {
      sqlite_path: sqlitePath,
      object_root: objectRoot,
      pragmas: stores.sqlitePragmas?.(),
      file_sizes_bytes: await storageFileSizes(sqlitePath),
    },
    clients: {
      fast: {
        count: fastClients.length,
        expected_events: expectedFastEvents,
        delivered_events: drain.delivered_events,
        min_delivered_per_client: minDelivered(fastClients),
        max_delivered_per_client: maxDelivered(fastClients),
        drain_wait_ms: drain.wait_ms,
      },
      stalled: {
        count: stalledClients.length,
        session_ids: stalledClients.map((client) => client.sessionId),
      },
    },
    bursts: burstSummaries,
    memory_bytes: {
      before: memoryBefore,
      after_drain: memoryAfterDrain,
      after_close: memoryAfterClose,
    },
    notes: [
      "This harness uses real HTTP fetch clients against a real @hono/node-server listener.",
      "Fast clients parse SSE frames and count real delivered events.",
      "Stalled clients open SSE responses and deliberately do not read response bodies until cleanup.",
      "The harness has no runtime runner; POST /events persists user.message rows and publishes them.",
    ],
  };
  const summaryPath = join(OUT_DIR, `${RUN_ID}.json`);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await closeClients().catch(() => undefined);
  stores.close();
  server.close();
  if (process.env.OMA_HTTP_SSE_KEEP_ARTIFACTS !== "1") {
    await rm(runRoot, { recursive: true, force: true });
  }
}

interface HttpBurstSummary {
  burst_index: number;
  requests: number;
  events_sent: number;
  total_wall_ms: number;
  request_latency_ms: Stats;
  queue_lag_ms: Stats;
  status_counts: Record<string, number>;
}

interface FastSseClient {
  sessionId: string;
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  delivered: number;
  done: Promise<void>;
}

interface StalledSseClient {
  sessionId: string;
  controller: AbortController;
  response: Response;
}

interface Stats {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

async function startFastClients(): Promise<void> {
  for (const sessionId of sessionIds) {
    for (let i = 0; i < fastClientsPerSession; i += 1) {
      const controller = new AbortController();
      const response = await fetch(
        `${baseUrl}/v1/sessions/${sessionId}/events/stream`,
        withManagedAgentsBeta({ signal: controller.signal }),
      );
      assertStatus(response, 200, "open fast SSE stream");
      if (!response.body) throw new Error("fast SSE response missing body");
      const client: FastSseClient = {
        sessionId,
        controller,
        reader: response.body.getReader(),
        delivered: 0,
        done: Promise.resolve(),
      };
      client.done = consumeFastClient(client);
      fastClients.push(client);
    }
  }
}

async function startStalledClients(): Promise<void> {
  for (let index = 0; index < stalledClientCount; index += 1) {
    const sessionId = sessionIds[index % sessionIds.length];
    const controller = new AbortController();
    const response = await fetch(
      `${baseUrl}/v1/sessions/${sessionId}/events/stream`,
      withManagedAgentsBeta({ signal: controller.signal }),
    );
    assertStatus(response, 200, "open stalled SSE stream");
    stalledClients.push({ sessionId, controller, response });
  }
}

async function consumeFastClient(client: FastSseClient): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const next = await client.reader.read();
      if (next.done) return;
      buffer += decoder.decode(next.value, { stream: true });
      while (true) {
        const frameIndex = buffer.indexOf("\n\n");
        if (frameIndex === -1) break;
        const frame = buffer.slice(0, frameIndex);
        buffer = buffer.slice(frameIndex + 2);
        if (
          frame.includes("\nevent: user.message\n") ||
          frame.startsWith("event: user.message\n")
        ) {
          client.delivered += 1;
        }
      }
    }
  } catch (error) {
    if (!client.controller.signal.aborted) throw error;
  }
}

async function sendHttpBurst(burst: number): Promise<HttpBurstSummary> {
  const scheduledAt = performance.now();
  const results = await Promise.all(
    sessionIds.map(
      (sessionId, sessionIndex) =>
        new Promise<{ lagMs: number; latencyMs: number; status: number }>(
          (resolve, reject) => {
            setImmediate(() => {
              const start = performance.now();
              postEvents(sessionId, sessionIndex, burst)
                .then((status) => {
                  resolve({
                    lagMs: start - scheduledAt,
                    latencyMs: performance.now() - start,
                    status,
                  });
                })
                .catch(reject);
            });
          },
        ),
    ),
  );
  const totalWallMs = performance.now() - scheduledAt;
  const statusCounts: Record<string, number> = {};
  for (const result of results) {
    statusCounts[String(result.status)] =
      (statusCounts[String(result.status)] ?? 0) + 1;
  }
  return {
    burst_index: burst,
    requests: sessionIds.length,
    events_sent: sessionIds.length * eventsPerRequest,
    total_wall_ms: round(totalWallMs),
    request_latency_ms: stats(results.map((result) => result.latencyMs)),
    queue_lag_ms: stats(results.map((result) => result.lagMs)),
    status_counts: statusCounts,
  };
}

async function postEvents(
  sessionId: string,
  sessionIndex: number,
  burst: number,
): Promise<number> {
  const response = await fetch(
    `${baseUrl}/v1/sessions/${sessionId}/events`,
    withManagedAgentsBeta({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: Array.from({ length: eventsPerRequest }, (_, eventIndex) => ({
          type: "user.message",
          content: [
            {
              type: "text",
              text: `http-sse load session=${sessionIndex} burst=${burst} event=${eventIndex}`,
            },
          ],
        })),
      }),
    }),
  );
  await response.arrayBuffer();
  if (response.status !== 200) {
    throw new Error(`POST /events for ${sessionId} returned ${response.status}`);
  }
  return response.status;
}

async function waitForFastClients(
  expectedEvents: number,
  timeoutMs: number,
): Promise<{ delivered_events: number; wait_ms: number }> {
  const start = performance.now();
  const deadline = start + timeoutMs;
  while (totalFastDelivered() < expectedEvents && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return {
    delivered_events: totalFastDelivered(),
    wait_ms: round(performance.now() - start),
  };
}

async function closeClients(): Promise<void> {
  for (const client of fastClients) {
    client.controller.abort();
    await client.reader.cancel().catch(() => undefined);
  }
  for (const client of stalledClients) {
    client.controller.abort();
    await client.response.body?.cancel().catch(() => undefined);
  }
  await Promise.all(
    fastClients.map((client) => client.done.catch(() => undefined)),
  );
}

async function waitForSubscribers(
  ids: readonly string[],
  expectedCount: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (totalSubscriberCount(ids) !== expectedCount) {
    if (performance.now() > deadline) {
      throw new Error(
        `Timed out waiting for subscriber count ${expectedCount}; got ${totalSubscriberCount(ids)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function totalSubscriberCount(ids: readonly string[]): number {
  return ids.reduce(
    (sum, sessionId) =>
      sum + broadcaster.subscriberCount(sessionId, WORKSPACE_ID),
    0,
  );
}

function totalFastDelivered(): number {
  return fastClients.reduce((sum, client) => sum + client.delivered, 0);
}

function minDelivered(clients: readonly FastSseClient[]): number {
  if (clients.length === 0) return 0;
  return Math.min(...clients.map((client) => client.delivered));
}

function maxDelivered(clients: readonly FastSseClient[]): number {
  if (clients.length === 0) return 0;
  return Math.max(...clients.map((client) => client.delivered));
}

function sessionRow(sessionId: string, index: number): SessionRow {
  const now = new Date().toISOString();
  return {
    id: sessionId,
    workspace_id: WORKSPACE_ID,
    type: "session",
    agent: { type: "agent", id: `agent_http_${index % 8}`, version: 1 },
    environment_id: "env_http",
    status: "idle",
    title: null,
    metadata: { load_index: String(index) },
    created_at: now,
    updated_at: now,
    archived_at: null,
    usage: null,
    resources: [],
  };
}

async function storageFileSizes(sqlitePathValue: string): Promise<{
  sqlite: number;
  wal: number;
  shm: number;
}> {
  return {
    sqlite: await fileSize(sqlitePathValue),
    wal: await fileSize(`${sqlitePathValue}-wal`),
    shm: await fileSize(`${sqlitePathValue}-shm`),
  };
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return 0;
    throw error;
  }
}

function memorySnapshot(): {
  rss: number;
  heap_total: number;
  heap_used: number;
  external: number;
  array_buffers: number;
} {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heap_total: usage.heapTotal,
    heap_used: usage.heapUsed,
    external: usage.external,
    array_buffers: usage.arrayBuffers,
  };
}

function stats(values: readonly number[]): Stats {
  if (values.length === 0) {
    return { min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: round(sorted[0] ?? 0),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(sum / sorted.length),
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function assertStatus(response: Response, expected: number, label: string): void {
  if (response.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${response.status}`);
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parsePositiveEnv(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeEnv(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}
