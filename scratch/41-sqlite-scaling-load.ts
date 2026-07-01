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
 */

import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDeploymentStoresFromEnv } from "../src/control-plane/deployment-storage.ts";
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

const runRoot = join(tmpdir(), `${RUN_ID}-`);
const sqlitePath = join(runRoot, "oma.sqlite");
const objectRoot = join(runRoot, "objects");

await mkdir(runRoot, { recursive: true });
await mkdir(OUT_DIR, { recursive: true });

const stores = createDeploymentStoresFromEnv({
  OMA_SQLITE_PATH: sqlitePath,
  OMA_FILE_STORAGE_ROOT: objectRoot,
});

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
    bursts.push(await runTurnCompletionBurst(sessionIds, burst));
  }

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
      "Session listing exercises SqliteSessionStore.deserialize, including the known #52 per-session resources query.",
      "This probe intentionally excludes model and sandbox compute.",
    ],
  };
  const summaryPath = join(OUT_DIR, `${RUN_ID}.json`);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  delayMonitor.disable();
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
  queue_lag_ms: Stats;
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
        new Promise<{ lagMs: number; durationMs: number }>((resolve, reject) => {
          setImmediate(() => {
            const start = performance.now();
            try {
              completeTurn(sessionId, index, burst);
              const end = performance.now();
              resolve({
                lagMs: start - scheduledAt,
                durationMs: end - start,
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
    commit_duration_ms: stats(results.map((result) => result.durationMs)),
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

function completeTurn(sessionId: string, index: number, burst: number): void {
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
