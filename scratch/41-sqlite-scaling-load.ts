/**
 * Probe 41 — SQLite single-node scaling load harness.
 *
 * Goal:
 *   Produce baseline evidence for issue #107 without model calls or sandbox
 *   compute. This exercises the durable file-backed deployment stores directly:
 *
 *   1. Create N sessions with pending runtime turns.
 *   2. Schedule synchronized turn-completion bursts where each session commits
 *      ~M runtime transcript rows plus an owner-fenced closed turn.
 *   3. Measure sync transaction duration, queue lag, event-loop delay, event
 *      throughput, WAL growth, and session-list page latency.
 *
 * Run:
 *   fnm exec --using 24.18.0 -- npx tsx scratch/41-sqlite-scaling-load.ts
 *
 * Tunables:
 *   OMA_SQLITE_LOAD_SESSIONS=200
 *   OMA_SQLITE_LOAD_EVENTS_PER_TURN=50
 *   OMA_SQLITE_LOAD_BURSTS=1
 *   OMA_SQLITE_LOAD_RESOURCES_PER_SESSION=0
 *   OMA_SQLITE_LOAD_LIST_LIMIT=100
 *   OMA_SQLITE_LOAD_SUBSCRIBERS_PER_SESSION=0
 */

import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDeploymentStoresFromEnv } from "../src/control-plane/deployment-storage.ts";
import { SessionEventBroadcaster } from "../src/control-plane/events/broadcaster.ts";
import type { PersistedSessionEvent } from "../src/control-plane/events/types.ts";
import type {
  SessionFileMountSnapshotRow,
  SessionRow,
} from "../src/control-plane/sessions/types.ts";
import { newEventId } from "../src/types/events.ts";

const WORKSPACE_ID = "wrk_default";
const RUN_ID = `probe41_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const OUT_DIR = join(process.cwd(), "scratch", "artifacts", "sqlite-scaling-load");

const sessionCount = parsePositiveEnv("OMA_SQLITE_LOAD_SESSIONS", 200);
const eventsPerTurn = parsePositiveEnv("OMA_SQLITE_LOAD_EVENTS_PER_TURN", 50);
const burstCount = parsePositiveEnv("OMA_SQLITE_LOAD_BURSTS", 1);
const resourcesPerSession = parseNonNegativeEnv(
  "OMA_SQLITE_LOAD_RESOURCES_PER_SESSION",
  0,
);
const listLimit = parsePositiveEnv("OMA_SQLITE_LOAD_LIST_LIMIT", 100);
const subscribersPerSession = parseNonNegativeEnv(
  "OMA_SQLITE_LOAD_SUBSCRIBERS_PER_SESSION",
  0,
);

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
const subscriberControllers: AbortController[] = [];
const subscriberPromises: Promise<void>[] = [];
const subscriberResults: SubscriberResult[] = [];

const delayMonitor = monitorEventLoopDelay({ resolution: 10 });
delayMonitor.enable();

const startedAt = new Date().toISOString();
const setupStart = performance.now();
const sessionIds = Array.from(
  { length: sessionCount },
  (_, index) => `sesn_load_${RUN_ID}_${index.toString().padStart(4, "0")}`,
);

try {
  for (const [index, sessionId] of sessionIds.entries()) {
    stores.sessions.create({
      row: sessionRow(sessionId, index),
      snapshots: snapshotRows(sessionId, index),
    });
  }
  const sessionCreateMs = performance.now() - setupStart;

  const bursts: BurstSummary[] = [];
  for (let burst = 0; burst < burstCount; burst += 1) {
    seedAcceptedTurns(sessionIds, burst);
    if (burst === 0 && subscribersPerSession > 0) {
      await startLiveSubscribers(sessionIds);
    }
    bursts.push(await runTurnCompletionBurst(sessionIds, burst));
  }

  const subscriberSummary = await stopLiveSubscribers();
  const listSummary = measureSessionList();
  const fileSizes = await storageFileSizes(sqlitePath);
  delayMonitor.disable();

  const summary = {
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    run_id: RUN_ID,
    verdict: "PASS",
    config: {
      session_count: sessionCount,
      events_per_turn: eventsPerTurn,
      burst_count: burstCount,
      resources_per_session: resourcesPerSession,
      list_limit: listLimit,
      subscribers_per_session: subscribersPerSession,
    },
    storage: {
      sqlite_path: sqlitePath,
      object_root: objectRoot,
      pragmas: stores.sqlitePragmas?.(),
      file_sizes_bytes: fileSizes,
    },
    setup: {
      session_create_ms: round(sessionCreateMs),
      sessions_per_second: round((sessionCount / sessionCreateMs) * 1000),
    },
    bursts,
    subscribers: subscriberSummary,
    session_list: listSummary,
    event_loop_delay_ms: {
      min: nsToMs(delayMonitor.min),
      mean: nsToMs(delayMonitor.mean),
      max: nsToMs(delayMonitor.max),
      p50: nsToMs(delayMonitor.percentile(50)),
      p95: nsToMs(delayMonitor.percentile(95)),
      p99: nsToMs(delayMonitor.percentile(99)),
    },
    notes: [
      "Queue lag is measured from scheduling each setImmediate task to when its synchronous SQLite work starts.",
      "Commit duration measures only the synchronous appendBatchWithRuntimeChanges call.",
      "Publish duration measures SessionEventBroadcaster.publishPersisted after commit.",
      "Session listing exercises SqliteSessionStore.deserialize, including the known #52 per-session resources query.",
      "This probe intentionally excludes model and sandbox compute.",
    ],
  };
  const summaryPath = join(OUT_DIR, `${RUN_ID}.json`);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  delayMonitor.disable();
  for (const controller of subscriberControllers) {
    controller.abort();
  }
  stores.close();
  if (process.env.OMA_SQLITE_LOAD_KEEP_ARTIFACTS !== "1") {
    await rm(runRoot, { recursive: true, force: true });
  }
}

interface BurstSummary {
  burst_index: number;
  scheduled_sessions: number;
  events_committed: number;
  total_wall_ms: number;
  throughput_events_per_second: number;
  commit_duration_ms: Stats;
  publish_duration_ms: Stats;
  commit_plus_publish_duration_ms: Stats;
  queue_lag_ms: Stats;
}

interface SubscriberResult {
  sessionId: string;
  subscriberIndex: number;
  delivered: number;
}

interface Stats {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

async function runTurnCompletionBurst(
  ids: readonly string[],
  burst: number,
): Promise<BurstSummary> {
  const scheduledAt = performance.now();
  const results = await Promise.all(
    ids.map(
      (sessionId, index) =>
        new Promise<{
          lagMs: number;
          commitMs: number;
          publishMs: number;
          totalMs: number;
        }>((resolve, reject) => {
          setImmediate(() => {
            const start = performance.now();
            try {
              const result = completeTurn(sessionId, index, burst);
              resolve({
                lagMs: start - scheduledAt,
                commitMs: result.commitMs,
                publishMs: result.publishMs,
                totalMs: performance.now() - start,
              });
            } catch (error) {
              reject(error);
            }
          });
        }),
    ),
  );
  const totalWallMs = performance.now() - scheduledAt;
  const eventsCommitted = ids.length * eventsPerTurn;
  return {
    burst_index: burst,
    scheduled_sessions: ids.length,
    events_committed: eventsCommitted,
    total_wall_ms: round(totalWallMs),
    throughput_events_per_second: round((eventsCommitted / totalWallMs) * 1000),
    commit_duration_ms: stats(results.map((result) => result.commitMs)),
    publish_duration_ms: stats(results.map((result) => result.publishMs)),
    commit_plus_publish_duration_ms: stats(
      results.map((result) => result.totalMs),
    ),
    queue_lag_ms: stats(results.map((result) => result.lagMs)),
  };
}

function seedAcceptedTurns(ids: readonly string[], burst: number): void {
  const now = new Date().toISOString();
  for (const [index, sessionId] of ids.entries()) {
    const triggerEventId = newEventId();
    stores.events.appendBatchWithRuntimeChanges(
      [
        eventRow(sessionId, triggerEventId, "user.message", now, {
          content: [{ type: "text", text: `load prompt ${burst}/${index}` }],
        }),
      ],
      {
        acceptedTurns: [
          {
            workspaceId: WORKSPACE_ID,
            sessionId,
            turnId: turnId(sessionId, burst),
            ownerId: "owner_load",
            ownerGeneration: 1,
            leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
            triggerEventIds: [triggerEventId],
            now,
          },
        ],
      },
    );
  }
}

function completeTurn(
  sessionId: string,
  index: number,
  burst: number,
): { commitMs: number; publishMs: number } {
  const now = new Date().toISOString();
  const events = Array.from({ length: eventsPerTurn }, (_, eventIndex) =>
    eventRow(sessionId, newEventId(), "agent.message", now, {
      content: [
        {
          type: "text",
          text: `load output session=${index} burst=${burst} event=${eventIndex}`,
        },
      ],
    }),
  );
  const commitStart = performance.now();
  stores.events.appendBatchWithRuntimeChanges(events, {
    closedTurns: [
      {
        workspaceId: WORKSPACE_ID,
        sessionId,
        turnId: turnId(sessionId, burst),
        ownerId: "owner_load",
        ownerGeneration: 1,
        reason: "completed",
        state: "completed",
        now,
      },
    ],
  });
  const commitMs = performance.now() - commitStart;
  const publishStart = performance.now();
  broadcaster.publishPersisted(events);
  return {
    commitMs,
    publishMs: performance.now() - publishStart,
  };
}

async function startLiveSubscribers(ids: readonly string[]): Promise<void> {
  const expectedCount = ids.length * subscribersPerSession;
  if (expectedCount === 0) return;

  for (const sessionId of ids) {
    for (
      let subscriberIndex = 0;
      subscriberIndex < subscribersPerSession;
      subscriberIndex += 1
    ) {
      const controller = new AbortController();
      subscriberControllers.push(controller);
      const result: SubscriberResult = {
        sessionId,
        subscriberIndex,
        delivered: 0,
      };
      subscriberResults.push(result);
      subscriberPromises.push(
        consumeSubscriber(sessionId, controller.signal, result),
      );
    }
  }

  const deadline = performance.now() + 5_000;
  while (totalSubscriberCount(ids) < expectedCount) {
    if (performance.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${expectedCount} subscribers; registered ${totalSubscriberCount(ids)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function consumeSubscriber(
  sessionId: string,
  signal: AbortSignal,
  result: SubscriberResult,
): Promise<void> {
  try {
    for await (const _event of broadcaster.subscribe(WORKSPACE_ID, sessionId, {
      signal,
    })) {
      result.delivered += 1;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

async function stopLiveSubscribers(): Promise<{
  configured_per_session: number;
  total_configured: number;
  expected_events: number;
  delivered_events: number;
  drain_wait_ms: number;
  min_delivered_per_subscriber: number;
  max_delivered_per_subscriber: number;
}> {
  const drainStart = performance.now();
  const expectedEvents =
    subscribersPerSession === 0
      ? 0
      : sessionCount * subscribersPerSession * (1 + eventsPerTurn * burstCount);
  const deadline = performance.now() + 5_000;
  while (
    expectedEvents > 0 &&
    totalDeliveredEvents() < expectedEvents &&
    performance.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const drainWaitMs = performance.now() - drainStart;
  for (const controller of subscriberControllers) {
    controller.abort();
  }
  await Promise.all(subscriberPromises);
  const delivered = subscriberResults.map((result) => result.delivered);
  return {
    configured_per_session: subscribersPerSession,
    total_configured: subscriberResults.length,
    expected_events: expectedEvents,
    delivered_events: delivered.reduce((sum, value) => sum + value, 0),
    drain_wait_ms: round(drainWaitMs),
    min_delivered_per_subscriber:
      delivered.length === 0 ? 0 : Math.min(...delivered),
    max_delivered_per_subscriber:
      delivered.length === 0 ? 0 : Math.max(...delivered),
  };
}

function totalSubscriberCount(ids: readonly string[]): number {
  return ids.reduce(
    (sum, sessionId) =>
      sum + broadcaster.subscriberCount(sessionId, WORKSPACE_ID),
    0,
  );
}

function totalDeliveredEvents(): number {
  return subscriberResults.reduce((sum, result) => sum + result.delivered, 0);
}

function measureSessionList(): {
  pages: number;
  rows: number;
  total_ms: number;
  page_latency_ms: Stats;
} {
  const latencies: number[] = [];
  let page: string | undefined;
  let rows = 0;
  let pages = 0;
  const startAll = performance.now();
  do {
    const start = performance.now();
    const result = stores.sessions.list(WORKSPACE_ID, {
      includeArchived: true,
      limit: listLimit,
      order: "asc",
      page,
    });
    latencies.push(performance.now() - start);
    rows += result.data.length;
    pages += 1;
    page = result.next_page ?? undefined;
  } while (page !== undefined);
  return {
    pages,
    rows,
    total_ms: round(performance.now() - startAll),
    page_latency_ms: stats(latencies),
  };
}

function sessionRow(sessionId: string, index: number): SessionRow {
  const now = new Date().toISOString();
  return {
    id: sessionId,
    workspace_id: WORKSPACE_ID,
    type: "session",
    agent: { type: "agent", id: `agent_load_${index % 8}`, version: 1 },
    environment_id: "env_load",
    status: "idle",
    title: null,
    metadata: { load_index: String(index) },
    created_at: now,
    updated_at: now,
    archived_at: null,
    usage: null,
    resources: Array.from({ length: resourcesPerSession }, (_, resourceIndex) => ({
      id: `sesrsc_load_${index}_${resourceIndex}`,
      type: "file",
      file_id: `file_load_${index}_${resourceIndex}`,
      mount_path: `/mnt/session/uploads/input-${resourceIndex}.txt`,
      created_at: now,
      updated_at: now,
    })),
  };
}

function snapshotRows(
  sessionId: string,
  sessionIndex: number,
): SessionFileMountSnapshotRow[] {
  return Array.from({ length: resourcesPerSession }, (_, resourceIndex) => ({
    workspace_id: WORKSPACE_ID,
    session_id: sessionId,
    resource_id: `sesrsc_load_${sessionIndex}_${resourceIndex}`,
    file_id: `file_load_${sessionIndex}_${resourceIndex}`,
    mount_path: `/mnt/session/uploads/input-${resourceIndex}.txt`,
    snapshot_file_id: `file_snapshot_load_${sessionIndex}_${resourceIndex}`,
    sha256: "0".repeat(64),
    size_bytes: 0,
    kind: "upload",
    skill_snapshot_id: null,
  }));
}

function eventRow(
  sessionId: string,
  id: string,
  type: PersistedSessionEvent["type"],
  now: string,
  payload: PersistedSessionEvent["payload"],
): PersistedSessionEvent {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    session_id: sessionId,
    type,
    processed_at: now,
    payload,
    created_at: now,
  };
}

function turnId(sessionId: string, burst: number): string {
  return `rtun_${sessionId}_${burst}`;
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

function nsToMs(value: number): number {
  if (!Number.isFinite(value) || value > 1_000_000_000_000_000) return 0;
  return round(value / 1_000_000);
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
