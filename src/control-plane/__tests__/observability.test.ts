// Plan 0121 C2: /health, /metrics exposure matrix, HTTP metrics middleware
// placement, the post-commit turn observer, gauges, and admission counters.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeploymentControlPlane,
  type DeploymentControlPlane,
  type DeploymentControlPlaneEnv,
} from "../app.ts";
import { InFlightGauge } from "../admission.ts";
import { EventStore } from "../events/store.ts";
import type { EventStoreRuntimeChanges } from "../events/types.ts";
import { MANAGED_AGENTS_BETA } from "./helpers.ts";

const WORKSPACE_ID = "wrk_default";
const V1_HEADERS = {
  "content-type": "application/json",
  "anthropic-beta": MANAGED_AGENTS_BETA,
};

const tempRoots: string[] = [];
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); // auth_mode_disabled boot warning
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makePlane(env: DeploymentControlPlaneEnv = {}): DeploymentControlPlane {
  return createDeploymentControlPlane(env);
}

function makeDurablePlane(
  env: DeploymentControlPlaneEnv = {},
): DeploymentControlPlane & { root: string } {
  const root = mkdtempSync(join(tmpdir(), "oma-observability-"));
  tempRoots.push(root);
  const plane = createDeploymentControlPlane({
    OMA_SQLITE_PATH: join(root, "oma.sqlite"),
    OMA_FILE_STORAGE_ROOT: join(root, "objects"),
    ...env,
  });
  return { ...plane, root };
}

// Extract one sample value from the exposition; labels must all be present.
function sampleValue(
  exposition: string,
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  for (const line of exposition.split("\n")) {
    if (!line.startsWith(name)) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})? (.+)$/);
    if (!match || match[1] !== name) continue;
    const pairs = match[3] ?? "";
    if (
      Object.entries(labels).every(([k, v]) => pairs.includes(`${k}="${v}"`)) &&
      (pairs === "" ? Object.keys(labels).length === 0 : true)
    ) {
      return Number(match[4]);
    }
  }
  return undefined;
}

describe("event store runtime-changes observer (post-commit chokepoint)", () => {
  const now = new Date().toISOString();
  const accepted = (turnId: string): EventStoreRuntimeChanges => ({
    acceptedTurns: [
      {
        workspaceId: WORKSPACE_ID,
        sessionId: "sesn_obs",
        turnId,
        ownerId: "owner_obs",
        ownerGeneration: 1,
        leaseExpiresAt: now,
        triggerEventIds: ["sevt_trigger"],
        now,
      },
    ],
  });
  const closed = (turnId: string): EventStoreRuntimeChanges => ({
    closedTurns: [
      {
        workspaceId: WORKSPACE_ID,
        sessionId: "sesn_obs",
        turnId,
        reason: "completed",
        state: "completed",
        now,
      },
    ],
  });

  it("fires after the transaction commits, with the applied changes", () => {
    const store = EventStore.open(":memory:");
    const seen: EventStoreRuntimeChanges[] = [];
    store.setRuntimeChangesObserver((changes) => seen.push(changes));
    store.appendBatchWithRuntimeChanges([], accepted("rtun_obs_1"));
    store.appendBatchWithRuntimeChanges([], closed("rtun_obs_1"));
    expect(seen).toHaveLength(2);
    expect(seen[0]?.acceptedTurns?.[0]?.turnId).toBe("rtun_obs_1");
    expect(seen[1]?.closedTurns?.[0]?.reason).toBe("completed");
  });

  it("does not fire when the transaction rolls back", () => {
    const store = EventStore.open(":memory:");
    const seen: EventStoreRuntimeChanges[] = [];
    store.setRuntimeChangesObserver((changes) => seen.push(changes));
    expect(() =>
      store.withTransaction(() => {
        store.appendBatchWithRuntimeChangesInTransaction([], accepted("rtun_obs_2"));
        throw new Error("forced rollback");
      }),
    ).toThrow("forced rollback");
    expect(seen).toHaveLength(0);
    // The rolled-back turn really is absent.
    expect(store.countAllPendingRuntimeTurns()).toBe(0);
  });

  it("fires once, after the OUTERMOST transaction, when nested", () => {
    const store = EventStore.open(":memory:");
    const seen: Array<{ pendingAtFire: number }> = [];
    store.setRuntimeChangesObserver(() => {
      seen.push({ pendingAtFire: store.countAllPendingRuntimeTurns() });
    });
    store.withTransaction(() => {
      store.appendBatchWithRuntimeChanges([], accepted("rtun_obs_3"));
      expect(seen).toHaveLength(0); // inner append done, outer still open
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pendingAtFire).toBe(1);
  });

  it("a throwing observer does not fail the append", () => {
    const store = EventStore.open(":memory:");
    store.setRuntimeChangesObserver(() => {
      throw new Error("observer exploded");
    });
    expect(() =>
      store.appendBatchWithRuntimeChanges([], accepted("rtun_obs_4")),
    ).not.toThrow();
    expect(store.countAllPendingRuntimeTurns()).toBe(1);
  });
});

describe("GET /health", () => {
  it("answers unauthenticated on a durable auth-enabled deployment", async () => {
    const plane = makeDurablePlane({ OMA_AUTH_MODE: "api-key" });
    const res = await plane.app.request("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      status: string;
      version: string;
      uptime_seconds: number;
      checks: {
        storage: { status: string; free_bytes?: number };
        runtime: { status: string };
      };
    };
    expect(body.status).toBe("ok");
    expect(body.version).not.toBe("");
    expect(body.version).not.toBe("unknown");
    expect(typeof body.uptime_seconds).toBe("number");
    expect(body.checks.storage.status).toBe("ok");
    expect(typeof body.checks.storage.free_bytes).toBe("number");
    expect(body.checks.runtime.status).toBe("ok");
    plane.stores.close();
  });

  it("reports in-memory mode instead of claiming durability", async () => {
    const plane = makePlane();
    const res = await plane.app.request("/health");
    const body = (await res.json()) as {
      checks: { storage: { mode?: string } };
    };
    expect(body.checks.storage.mode).toBe("in-memory");
    plane.stores.close();
  });

  it("degrades to 503 when storage is unusable", async () => {
    const plane = makeDurablePlane();
    plane.stores.close(); // storage probe now throws on the closed handle
    const res = await plane.app.request("/health");
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      checks: { storage: { status: string } };
    };
    expect(body.status).toBe("degraded");
    expect(body.checks.storage.status).toBe("failed");
  });
});

describe("GET /metrics exposure matrix", () => {
  it("serves openly on the default loopback bind (polarity: unset flag is ON)", async () => {
    const plane = makePlane();
    const res = await plane.app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/plain; version=0.0.4; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("# TYPE oma_http_requests_total counter");
    plane.stores.close();
  });

  it("fails closed (404) on a non-loopback bind without a token", async () => {
    const plane = makePlane({ OMA_HOST: "0.0.0.0" });
    const res = await plane.app.request("/metrics");
    expect(res.status).toBe(404);
    plane.stores.close();
  });

  it("requires the bearer token when configured, constant-time compared", async () => {
    const plane = makePlane({
      OMA_HOST: "0.0.0.0",
      OMA_METRICS_TOKEN: "scrape-me-7",
    });
    expect((await plane.app.request("/metrics")).status).toBe(401);
    expect(
      (
        await plane.app.request("/metrics", {
          headers: { authorization: "Bearer wrong-token" },
        })
      ).status,
    ).toBe(401);
    const ok = await plane.app.request("/metrics", {
      headers: { authorization: "Bearer scrape-me-7" },
    });
    expect(ok.status).toBe(200);
    plane.stores.close();
  });

  it("a token also gates loopback binds", async () => {
    const plane = makePlane({ OMA_METRICS_TOKEN: "scrape-me-8" });
    expect((await plane.app.request("/metrics")).status).toBe(401);
    plane.stores.close();
  });

  it("OMA_METRICS=0 disables the endpoint everywhere", async () => {
    const plane = makePlane({ OMA_METRICS: "0" });
    expect((await plane.app.request("/metrics")).status).toBe(404);
    plane.stores.close();
  });

  it("refuses to boot on an unknown OMA_METRICS value", () => {
    expect(() => makePlane({ OMA_METRICS: "yes" })).toThrow(
      /Unsupported OMA_METRICS/,
    );
  });

  it("refuses both token variants set together", () => {
    expect(() =>
      makePlane({
        OMA_METRICS_TOKEN: "a",
        OMA_METRICS_TOKEN_FILE: "/nonexistent",
      }),
    ).toThrow(/exactly one of/);
  });
});

describe("HTTP metrics middleware placement", () => {
  it("counts 200, 404, 413, and onError 500 with correct route_class/status", async () => {
    const plane = makePlane();
    plane.app.get("/test-boom", () => {
      throw new Error("forced");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await plane.app.request("/health");
    await plane.app.request("/no-such-route");
    const tooBig = await plane.app.request("/v1/agents", {
      method: "POST",
      // bodyLimit gates on the declared length (MAX_REQUEST_BODY_BYTES + 1).
      headers: { ...V1_HEADERS, "content-length": "1048577" },
      body: "{}",
    });
    expect(tooBig.status).toBe(413);
    expect((await plane.app.request("/test-boom")).status).toBe(500);
    errorSpy.mockRestore();

    const exposition = await (await plane.app.request("/metrics")).text();
    expect(
      sampleValue(exposition, "oma_http_requests_total", {
        route_class: "health",
        method: "GET",
        status: "200",
      }),
    ).toBe(1);
    expect(
      sampleValue(exposition, "oma_http_requests_total", {
        route_class: "other",
        method: "GET",
        status: "404",
      }),
    ).toBe(1);
    expect(
      sampleValue(exposition, "oma_http_requests_total", {
        route_class: "v1",
        method: "POST",
        status: "413",
      }),
    ).toBe(1);
    expect(
      sampleValue(exposition, "oma_http_requests_total", {
        route_class: "other",
        method: "GET",
        status: "500",
      }),
    ).toBe(1);
    // Durations landed in the same route classes.
    expect(
      sampleValue(exposition, "oma_http_request_duration_seconds_count", {
        route_class: "health",
      }),
    ).toBe(1);
    plane.stores.close();
  });
});

describe("gauges and admission counters", () => {
  it("oma_sessions_active reflects a created session at scrape time", async () => {
    const plane = makePlane();
    const agentRes = await plane.app.request("/v1/agents", {
      method: "POST",
      headers: V1_HEADERS,
      body: JSON.stringify({
        name: "Obs Agent",
        model: "claude-opus-4-7",
        tools: [{ type: "agent_toolset_20260401" }],
      }),
    });
    expect(agentRes.status).toBe(200);
    const agent = (await agentRes.json()) as { id: string };
    const envRes = await plane.app.request("/v1/environments", {
      method: "POST",
      headers: V1_HEADERS,
      body: JSON.stringify({
        name: "Obs Environment",
        config: { type: "cloud" },
      }),
    });
    expect(envRes.status).toBe(200);
    const environment = (await envRes.json()) as { id: string };

    const before = await (await plane.app.request("/metrics")).text();
    expect(sampleValue(before, "oma_sessions_active")).toBe(0);

    const sessionRes = await plane.app.request("/v1/sessions", {
      method: "POST",
      headers: V1_HEADERS,
      body: JSON.stringify({ agent: agent.id, environment_id: environment.id }),
    });
    expect(sessionRes.status).toBe(200);

    const after = await (await plane.app.request("/metrics")).text();
    expect(sampleValue(after, "oma_sessions_active")).toBe(1);
    expect(sampleValue(after, "oma_runtime_turns_pending")).toBe(0);
    expect(sampleValue(after, "oma_sse_streams_active")).toBe(0);
    expect(sampleValue(after, "oma_process_uptime_seconds")).toBeGreaterThan(0);
    plane.stores.close();
  });

  it("counts a session-cap 429 as an admission rejection", async () => {
    const plane = makePlane({ OMA_MAX_ACTIVE_SESSIONS_PER_WORKSPACE: "1" });
    const agentRes = await plane.app.request("/v1/agents", {
      method: "POST",
      headers: V1_HEADERS,
      body: JSON.stringify({
        name: "Cap Agent",
        model: "claude-opus-4-7",
        tools: [{ type: "agent_toolset_20260401" }],
      }),
    });
    const agent = (await agentRes.json()) as { id: string };
    const envRes = await plane.app.request("/v1/environments", {
      method: "POST",
      headers: V1_HEADERS,
      body: JSON.stringify({
        name: "Cap Environment",
        config: { type: "cloud" },
      }),
    });
    const environment = (await envRes.json()) as { id: string };
    const create = () =>
      plane.app.request("/v1/sessions", {
        method: "POST",
        headers: V1_HEADERS,
        body: JSON.stringify({ agent: agent.id, environment_id: environment.id }),
      });
    expect((await create()).status).toBe(200);
    expect((await create()).status).toBe(429);

    const exposition = await (await plane.app.request("/metrics")).text();
    expect(
      sampleValue(exposition, "oma_admission_rejections_total", {
        limit: "sessions",
        status: "429",
      }),
    ).toBe(1);
    plane.stores.close();
  });
});

describe("turn outcome metrics (post-commit chokepoint, end-to-end)", () => {
  const now = new Date().toISOString();
  const acceptTurn = (turnId: string): EventStoreRuntimeChanges => ({
    acceptedTurns: [
      {
        workspaceId: WORKSPACE_ID,
        sessionId: "sesn_outcomes",
        turnId,
        ownerId: "owner_outcomes",
        ownerGeneration: 1,
        leaseExpiresAt: now,
        triggerEventIds: ["sevt_trigger"],
        now,
      },
    ],
  });
  const closeTurn = (
    turnId: string,
    reason: "completed" | "interrupted" | "terminalized" | "archived" | "deleted",
  ): EventStoreRuntimeChanges => ({
    closedTurns: [
      {
        workspaceId: WORKSPACE_ID,
        sessionId: "sesn_outcomes",
        turnId,
        reason,
        state: reason === "completed" ? "completed" : "terminalized",
        now,
      },
    ],
  });

  it("maps close reasons to outcomes; archived/deleted are not counted", async () => {
    const plane = makePlane();
    const reasons = [
      "completed",
      "interrupted",
      "terminalized",
      "archived",
      "deleted",
    ] as const;
    for (const [index] of reasons.entries()) {
      plane.stores.events.appendBatchWithRuntimeChanges([], acceptTurn(`rtun_o_${index}`));
    }

    // All five accepted and none closed: the pending gauge shows real state
    // (kills a constant-returning-collector mutant).
    const pending = await (await plane.app.request("/metrics")).text();
    expect(sampleValue(pending, "oma_runtime_turns_pending")).toBe(5);

    for (const [index, reason] of reasons.entries()) {
      plane.stores.events.appendBatchWithRuntimeChanges(
        [],
        closeTurn(`rtun_o_${index}`, reason),
      );
    }
    const exposition = await (await plane.app.request("/metrics")).text();
    expect(
      sampleValue(exposition, "oma_runtime_turns_total", { outcome: "completed" }),
    ).toBe(1);
    expect(
      sampleValue(exposition, "oma_runtime_turns_total", { outcome: "interrupted" }),
    ).toBe(1);
    expect(
      sampleValue(exposition, "oma_runtime_turns_total", { outcome: "abandoned" }),
    ).toBe(1);
    // archived/deleted must not count as any outcome — 3 closures total.
    expect(
      sampleValue(exposition, "oma_runtime_turns_total", { outcome: "other" }),
    ).toBeUndefined();
    // Duration observed for the completed turn only.
    expect(
      sampleValue(exposition, "oma_runtime_turn_duration_seconds_count"),
    ).toBe(1);
    expect(sampleValue(exposition, "oma_runtime_turns_pending")).toBe(0);
    plane.stores.close();
  });
});

describe("in-flight gauge total", () => {
  it("tracks acquire/release (feeds oma_sse_streams_active)", () => {
    const gauge = new InFlightGauge("SSE stream");
    const releaseA = gauge.acquire(WORKSPACE_ID);
    const releaseB = gauge.acquire("wrk_other");
    expect(gauge.totalInFlight).toBe(2);
    releaseA();
    releaseA(); // idempotent
    expect(gauge.totalInFlight).toBe(1);
    releaseB();
    expect(gauge.totalInFlight).toBe(0);
  });
});

describe("health degradation and kill-switch recovery", () => {
  it("fails the storage check when the object root cannot be statfs'd", async () => {
    const plane = makeDurablePlane();
    rmSync(join(plane.root, "objects"), { recursive: true, force: true });
    const res = await plane.app.request("/health");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { checks: { storage: { status: string } } };
    expect(body.checks.storage.status).toBe("failed");
    plane.stores.close();
  });

  it("OMA_METRICS=0 boots despite broken token config (kill-switch recovery)", async () => {
    const plane = makePlane({
      OMA_METRICS: "0",
      OMA_METRICS_TOKEN_FILE: "/nonexistent/metrics-token",
    });
    expect((await plane.app.request("/metrics")).status).toBe(404);
    expect((await plane.app.request("/health")).status).toBe(200);
    plane.stores.close();
  });
});

describe("schema", () => {
  it("creates the partial live-sessions index", () => {
    const plane = makeDurablePlane();
    plane.stores.close();
    const db = new DatabaseSync(join(plane.root, "oma.sqlite"));
    const row = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_live'`,
      )
      .get() as { sql: string } | undefined;
    db.close();
    expect(row?.sql).toContain("WHERE archived_at IS NULL");
  });

  it("serves both live-turn counts from the partial index, not a table scan", () => {
    // Turns are closed by UPDATE and retained as history; without the
    // partial index every /metrics scrape and /health check is O(history)
    // (C2 review, Codex-adv HIGH — EXPLAIN-verified SCAN before the fix).
    const plane = makeDurablePlane();
    plane.stores.close();
    const db = new DatabaseSync(join(plane.root, "oma.sqlite"));
    const plan = (sql: string): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join(" | ");
    const unscoped = plan(
      `SELECT COUNT(*) FROM pending_runtime_turns WHERE state NOT IN ('completed', 'terminalized')`,
    );
    const scoped = plan(
      `SELECT COUNT(*) FROM pending_runtime_turns WHERE workspace_id = 'wrk_x' AND state NOT IN ('completed', 'terminalized')`,
    );
    db.close();
    expect(unscoped).toContain("idx_runtime_turns_live");
    expect(scoped).toContain("idx_runtime_turns_live");
  });
});
