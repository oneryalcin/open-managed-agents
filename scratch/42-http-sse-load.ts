/**
 * Probe 42 — HTTP/SSE streaming load harness for #107.
 *
 * Probe 41 clears the direct SQLite commit path and in-memory broadcaster
 * fan-out. Probe 42 measures the HTTP/SSE layer with the load driver and server
 * in separate Node processes, so client fetch/read work does not share the
 * server event loop.
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

import { fork, type ChildProcess } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { serve, type ServerType } from "@hono/node-server";
import { createControlPlaneApp } from "../src/control-plane/app.ts";
import { DefaultAgentService } from "../src/control-plane/agents/service.ts";
import { DefaultEnvironmentService } from "../src/control-plane/environments/service.ts";
import { createDeploymentStoresFromEnv } from "../src/control-plane/deployment-storage.ts";
import { SessionEventBroadcaster } from "../src/control-plane/events/broadcaster.ts";
import { DefaultSessionEventsService } from "../src/control-plane/events/service.ts";
import { DefaultFileService } from "../src/control-plane/files/service.ts";
import { DefaultSessionService } from "../src/control-plane/sessions/service.ts";
import type { SessionRow } from "../src/control-plane/sessions/types.ts";
import { withManagedAgentsBeta } from "./managed-agents-beta.ts";

const WORKSPACE_ID = "wrk_default";
const ROLE = process.env.OMA_HTTP_SSE_ROLE ?? "driver";
const RUN_ID =
  process.env.OMA_HTTP_SSE_RUN_ID ??
  `probe42_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

let nextRequestId = 1;

await (ROLE === "server" ? runServer() : runDriver());

async function runDriver(): Promise<void> {
  const runRoot = join(tmpdir(), `${RUN_ID}-`);
  const sqlitePath = join(runRoot, "oma.sqlite");
  const objectRoot = join(runRoot, "objects");
  await mkdir(runRoot, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const serverProcess = fork(process.argv[1]!, [], {
    execArgv: process.execArgv,
    env: {
      ...process.env,
      OMA_HTTP_SSE_ROLE: "server",
      OMA_HTTP_SSE_RUN_ID: RUN_ID,
      OMA_HTTP_SSE_SQLITE_PATH: sqlitePath,
      OMA_HTTP_SSE_OBJECT_ROOT: objectRoot,
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  const fastClients: FastSseClient[] = [];
  const stalledClients: StalledSseClient[] = [];
  const memoryBefore = memorySnapshot();
  const startedAt = new Date().toISOString();

  try {
    const ready = await waitForServerReady(serverProcess);
    const baseUrl = ready.base_url;
    const sessionIds = ready.session_ids;

    await startFastClients(baseUrl, sessionIds, fastClients);
    await startStalledClients(baseUrl, sessionIds, stalledClients);
    await waitForServerSubscribers(
      serverProcess,
      fastClients.length + stalledClients.length,
      5_000,
    );

    const burstSummaries: HttpBurstSummary[] = [];
    for (let burst = 0; burst < burstCount; burst += 1) {
      burstSummaries.push(await sendHttpBurst(baseUrl, sessionIds, burst));
    }

    const expectedFastEvents =
      fastClients.length * eventsPerRequest * burstCount;
    const drain = await waitForFastClients(
      fastClients,
      expectedFastEvents,
      drainTimeoutMs,
    );
    const driverAfterDrain = memorySnapshot();
    const serverAfterDrain = await requestServerMemory(serverProcess);

    await closeClients(fastClients, stalledClients);
    await waitForServerSubscribers(serverProcess, 0, 5_000);
    const driverAfterClose = memorySnapshot();
    const serverAfterClose = await requestServerMemory(serverProcess);

    const summary = {
      generated_at: new Date().toISOString(),
      started_at: startedAt,
      run_id: RUN_ID,
      verdict:
        drain.delivered_events === expectedFastEvents ? "PASS" : "PARTIAL_DELIVERY",
      topology: {
        server_process_id: ready.pid,
        driver_process_id: process.pid,
        shared_event_loop: false,
      },
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
        pragmas: ready.pragmas,
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
        driver: {
          before: memoryBefore,
          after_drain: driverAfterDrain,
          after_close: driverAfterClose,
        },
        server: {
          ready: ready.memory,
          after_drain: serverAfterDrain,
          after_close: serverAfterClose,
        },
      },
      notes: [
        "The Hono server and load driver run in separate Node processes.",
        "Fast clients parse SSE frames and count real delivered events.",
        "Stalled clients open SSE responses and deliberately do not read response bodies until cleanup.",
        "The server has no runtime runner; POST /events persists user.message rows and publishes them.",
      ],
    };
    const summaryPath = join(OUT_DIR, `${RUN_ID}.json`);
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await closeClients(fastClients, stalledClients).catch(() => undefined);
    await shutdownServer(serverProcess).catch(() => undefined);
    if (process.env.OMA_HTTP_SSE_KEEP_ARTIFACTS !== "1") {
      await rm(runRoot, { recursive: true, force: true });
    }
  }
}

async function runServer(): Promise<void> {
  const sqlitePath = requiredEnv("OMA_HTTP_SSE_SQLITE_PATH");
  const objectRoot = requiredEnv("OMA_HTTP_SSE_OBJECT_ROOT");
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

  const sessionIds = Array.from(
    { length: sessionCount },
    (_, index) => `sesn_http_${RUN_ID}_${index.toString().padStart(4, "0")}`,
  );
  for (const [index, sessionId] of sessionIds.entries()) {
    stores.sessions.create({
      row: sessionRow(sessionId, index),
      snapshots: [],
    });
  }

  const server = serve({ fetch: app.fetch, port: 0 });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }

  process.send?.({
    type: "ready",
    pid: process.pid,
    base_url: `http://127.0.0.1:${address.port}`,
    session_ids: sessionIds,
    pragmas: stores.sqlitePragmas?.(),
    memory: memorySnapshot(),
  } satisfies ReadyMessage);

  await waitForServerShutdown(server, stores.close.bind(stores), () =>
    totalSubscriberCount(broadcaster, sessionIds),
  );
  process.disconnect?.();
  process.exit(0);
}

async function waitForServerShutdown(
  server: ServerType,
  closeStores: () => void,
  subscriberCount: () => number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    process.on("message", (message: unknown) => {
      if (!isControlMessage(message)) return;
      if (message.type === "memory") {
        process.send?.({
          id: message.id,
          type: "memory",
          memory: memorySnapshot(),
        } satisfies MemoryResponse);
        return;
      }
      if (message.type === "subscribers") {
        process.send?.({
          id: message.id,
          type: "subscribers",
          count: subscriberCount(),
        } satisfies SubscribersResponse);
        return;
      }
      if (message.type === "shutdown") {
        server.close();
        closeStores();
        process.send?.({ id: message.id, type: "shutdown-complete" });
        resolve();
      }
    });
  });
}

interface ReadyMessage {
  type: "ready";
  pid: number;
  base_url: string;
  session_ids: string[];
  pragmas: unknown;
  memory: MemorySnapshot;
}

interface ControlMessage {
  id: number;
  type: "memory" | "subscribers" | "shutdown";
}

interface MemoryResponse {
  id: number;
  type: "memory";
  memory: MemorySnapshot;
}

interface SubscribersResponse {
  id: number;
  type: "subscribers";
  count: number;
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

interface MemorySnapshot {
  rss: number;
  heap_total: number;
  heap_used: number;
  external: number;
  array_buffers: number;
}

interface Stats {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

function waitForServerReady(child: ChildProcess): Promise<ReadyMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for server ready")),
      10_000,
    );
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      reject(new Error(`server exited before ready: code=${code} signal=${signal}`));
    };
    const onMessage = (message: unknown) => {
      if (!isReadyMessage(message)) return;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("message", onMessage);
      resolve(message);
    };
    child.once("exit", onExit);
    child.on("message", onMessage);
  });
}

function requestServerMemory(child: ChildProcess): Promise<MemorySnapshot> {
  return requestServer<MemoryResponse>(child, "memory").then(
    (response) => response.memory,
  );
}

function requestServerSubscriberCount(child: ChildProcess): Promise<number> {
  return requestServer<SubscribersResponse>(child, "subscribers").then(
    (response) => response.count,
  );
}

async function shutdownServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await requestServer(child, "shutdown");
}

function requestServer<T extends { id: number; type: string }>(
  child: ChildProcess,
  type: ControlMessage["type"],
): Promise<T> {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for server ${type} response`)),
      10_000,
    );
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      reject(new Error(`server exited during ${type}: code=${code} signal=${signal}`));
    };
    const onMessage = (message: unknown) => {
      if (!isResponseFor(message, id)) return;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("message", onMessage);
      resolve(message as T);
    };
    child.once("exit", onExit);
    child.on("message", onMessage);
    child.send?.({ id, type } satisfies ControlMessage);
  });
}

async function startFastClients(
  baseUrl: string,
  sessionIds: readonly string[],
  fastClients: FastSseClient[],
): Promise<void> {
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

async function startStalledClients(
  baseUrl: string,
  sessionIds: readonly string[],
  stalledClients: StalledSseClient[],
): Promise<void> {
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

async function sendHttpBurst(
  baseUrl: string,
  sessionIds: readonly string[],
  burst: number,
): Promise<HttpBurstSummary> {
  const scheduledAt = performance.now();
  const results = await Promise.all(
    sessionIds.map(
      (sessionId, sessionIndex) =>
        new Promise<{ lagMs: number; latencyMs: number; status: number }>(
          (resolve, reject) => {
            setImmediate(() => {
              const start = performance.now();
              postEvents(baseUrl, sessionId, sessionIndex, burst)
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
  baseUrl: string,
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
  fastClients: readonly FastSseClient[],
  expectedEvents: number,
  timeoutMs: number,
): Promise<{ delivered_events: number; wait_ms: number }> {
  const start = performance.now();
  const deadline = start + timeoutMs;
  while (
    totalFastDelivered(fastClients) < expectedEvents &&
    performance.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return {
    delivered_events: totalFastDelivered(fastClients),
    wait_ms: round(performance.now() - start),
  };
}

async function closeClients(
  fastClients: readonly FastSseClient[],
  stalledClients: readonly StalledSseClient[],
): Promise<void> {
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

async function waitForServerSubscribers(
  child: ChildProcess,
  expectedCount: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while ((await requestServerSubscriberCount(child)) !== expectedCount) {
    if (performance.now() > deadline) {
      throw new Error(
        `Timed out waiting for server subscriber count ${expectedCount}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function totalSubscriberCount(
  broadcaster: SessionEventBroadcaster,
  sessionIds: readonly string[],
): number {
  return sessionIds.reduce(
    (sum, sessionId) =>
      sum + broadcaster.subscriberCount(sessionId, WORKSPACE_ID),
    0,
  );
}

function totalFastDelivered(fastClients: readonly FastSseClient[]): number {
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

function memorySnapshot(): MemorySnapshot {
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
  const sum = sorted.reduce((total, value) => value + total, 0);
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

function isReadyMessage(value: unknown): value is ReadyMessage {
  return (
    isRecord(value) &&
    value.type === "ready" &&
    typeof value.pid === "number" &&
    typeof value.base_url === "string" &&
    Array.isArray(value.session_ids)
  );
}

function isControlMessage(value: unknown): value is ControlMessage {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    (value.type === "memory" ||
      value.type === "subscribers" ||
      value.type === "shutdown")
  );
}

function isResponseFor(value: unknown, id: number): value is { id: number } {
  return isRecord(value) && value.id === id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
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
