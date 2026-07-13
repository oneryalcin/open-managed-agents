import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeploymentStoresFromEnv,
  openWorkspaceStoreForProvisioning,
} from "../deployment-storage.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";
import { parseDeploymentAuthMode } from "../app.ts";
import { DefaultAgentService } from "../agents/service.ts";
import { SqliteAgentStore } from "../agents/store.ts";
import { DefaultEnvironmentService } from "../environments/service.ts";
import { SqliteEnvironmentStore } from "../environments/store.ts";
import { SessionEventBroadcaster } from "../events/broadcaster.ts";
import { DefaultSessionEventsService } from "../events/service.ts";
import { EventStore } from "../events/store.ts";
import { DefaultFileService } from "../files/service.ts";
import { InMemoryFileStorage } from "../files/store.ts";
import { DefaultSessionService } from "../sessions/service.ts";
import { SqliteSessionStore } from "../sessions/store.ts";
import { SqliteWorkspaceStore, hashWorkspaceApiKey } from "../workspaces/store.ts";
import type { ApiErrorBody } from "../errors.ts";
import {
  createRawControlPlaneApp,
  createRawDeploymentControlPlaneApp,
  MANAGED_AGENTS_BETA,
} from "./helpers.ts";

// 0113 slice 2: middleware envelope/ordering parity is asserted against the
// recorded hosted probe (scratch/0113-hosted-auth-wire-probe.md).
const PROBED_401_ERROR = {
  type: "authentication_error",
  message: "Authentication failed",
} as const;

const VALID_AGENT = {
  name: "Auth Test Agent",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
};

const VALID_ENVIRONMENT = {
  name: "Auth Test Environment",
  config: {
    type: "cloud",
  },
};

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("workspace auth middleware", () => {
  it("returns the probed hosted 401 envelope for a missing key", async () => {
    const fixture = makeAuthFixture();
    const res = await request(fixture.app, "/v1/agents");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as ApiErrorBody;
    expect(body).toEqual({
      type: "error",
      error: PROBED_401_ERROR,
      request_id: res.headers.get("request-id"),
    });
    fixture.close();
  });

  it("is indistinguishable between missing and invalid keys", async () => {
    const fixture = makeAuthFixture();
    const missing = await errorOf(await request(fixture.app, "/v1/agents"));
    const invalid = await errorOf(
      await request(fixture.app, "/v1/agents", { key: "oma_definitely-not-a-key" }),
    );
    expect(invalid).toEqual(missing);
    expect(missing).toEqual(PROBED_401_ERROR);
    fixture.close();
  });

  it("returns 404 for unknown paths before auth runs", async () => {
    const fixture = makeAuthFixture();
    const res = await request(fixture.app, "/v1/definitely-not-a-route", {
      beta: false,
    });
    expect(res.status).toBe(404);
    fixture.close();
  });

  it("returns 401 before the beta gate on known routes", async () => {
    const fixture = makeAuthFixture();
    const res = await request(fixture.app, "/v1/agents", { beta: false });
    expect(res.status).toBe(401);
    fixture.close();
  });

  it("returns the beta-gate 404 for a valid key without the beta header", async () => {
    const fixture = makeAuthFixture();
    const { plaintextKey } = fixture.workspaces.mintKey("wrk_default", "test");
    const res = await request(fixture.app, "/v1/agents", {
      key: plaintextKey,
      beta: false,
    });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({
      type: "not_found_error",
      message: "not found",
    });
    fixture.close();
  });

  it("admits a valid key and scopes the request to its workspace", async () => {
    const fixture = makeAuthFixture();
    const workspace = fixture.workspaces.createWorkspace("tenant-a");
    const { plaintextKey } = fixture.workspaces.mintKey(
      workspace.workspace_id,
      "test",
    );
    const created = await createAgent(fixture.app, plaintextKey);
    const listed = await request(fixture.app, "/v1/agents", { key: plaintextKey });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { data: ManagedAgentsAgent[] };
    expect(body.data.map((agent) => agent.id)).toEqual([created.id]);
    fixture.close();
  });

  it("fails closed when auth is enabled with zero provisioned keys", async () => {
    const fixture = makeAuthFixture();
    const res = await request(fixture.app, "/v1/agents", {
      key: "oma_plausible-looking-key-with-no-row",
    });
    expect(res.status).toBe(401);
    fixture.close();
  });

  it("rejects a revoked key on the next request", async () => {
    const fixture = makeAuthFixture();
    const { plaintextKey, keySha256 } = fixture.workspaces.mintKey(
      "wrk_default",
      "test",
    );
    expect(
      (await request(fixture.app, "/v1/agents", { key: plaintextKey })).status,
    ).toBe(200);
    expect(fixture.workspaces.revokeKey(keySha256)).toBe(true);
    expect(
      (await request(fixture.app, "/v1/agents", { key: plaintextKey })).status,
    ).toBe(401);
    fixture.close();
  });

  it("keeps keyless requests working when auth is not configured", async () => {
    const fixture = makeAuthFixture({ auth: false });
    const res = await request(fixture.app, "/v1/agents");
    expect(res.status).toBe(200);
    fixture.close();
  });
});

describe("workspace store", () => {
  it("stores only SHA-256 digests, never the plaintext key", () => {
    const store = SqliteWorkspaceStore.open(":memory:");
    const minted = store.mintKey("wrk_default", "ci");
    expect(minted.plaintextKey).toMatch(/^oma_[A-Za-z0-9_-]{43}$/);
    const rows = store.listKeys("wrk_default");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.key_sha256).toBe(hashWorkspaceApiKey(minted.plaintextKey));
    expect(rows[0]?.key_sha256).not.toContain(minted.plaintextKey);
    expect(rows[0]?.label).toBe("ci");
    expect(rows[0]?.revoked_at).toBeNull();
    store.close();
  });

  it("seeds wrk_default idempotently", () => {
    const db = new DatabaseSync(":memory:");
    const first = new SqliteWorkspaceStore(db);
    expect(first.getWorkspace("wrk_default")?.name).toBe("Default workspace");
    // Re-running initialization on the same database must not throw or
    // duplicate the seed row.
    new SqliteWorkspaceStore(db);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM workspaces").get(),
    ).toMatchObject({ n: 1 });
    db.close();
  });

  it("refuses to mint a key for a missing workspace", () => {
    const store = SqliteWorkspaceStore.open(":memory:");
    expect(() => store.mintKey("wrk_ghost", "nope")).toThrow(
      "Workspace not found: wrk_ghost",
    );
    store.close();
  });
});

describe("cross-workspace denial", () => {
  it("denies agent access across workspaces without leaking existence", async () => {
    const fixture = makeAuthFixture();
    const { keyA, keyB } = twoTenants(fixture);
    const agent = await createAgent(fixture.app, keyA);

    const crossRes = await request(fixture.app, `/v1/agents/${agent.id}`, {
      key: keyB,
    });
    expect(crossRes.status).toBe(404);
    // No existence leak: the cross-workspace response is byte-identical to
    // what this caller would get for an ID that exists nowhere — the message
    // only echoes the requested ID back.
    const ghostRes = await request(fixture.app, "/v1/agents/agent_ghost", {
      key: keyB,
    });
    expect(await errorOf(crossRes)).toEqual({
      type: "not_found_error",
      message: `Agent ${agent.id} not found`,
    });
    expect(await errorOf(ghostRes)).toEqual({
      type: "not_found_error",
      message: "Agent agent_ghost not found",
    });

    const crossList = await request(fixture.app, "/v1/agents", { key: keyB });
    expect(
      ((await crossList.json()) as { data: ManagedAgentsAgent[] }).data,
    ).toEqual([]);
    expect(
      (await request(fixture.app, `/v1/agents/${agent.id}`, { key: keyA })).status,
    ).toBe(200);
    fixture.close();
  });

  it("denies file metadata access across workspaces", async () => {
    const fixture = makeAuthFixture();
    const { keyA, keyB } = twoTenants(fixture);
    const form = new FormData();
    form.append("file", new File(["cross-tenant"], "a.txt", { type: "text/plain" }));
    const uploaded = await fixture.app.request("/v1/files", {
      method: "POST",
      headers: { "anthropic-beta": MANAGED_AGENTS_BETA, "x-api-key": keyA },
      body: form,
    });
    expect(uploaded.status).toBe(200);
    const file = (await uploaded.json()) as { id: string };

    expect(
      (await request(fixture.app, `/v1/files/${file.id}`, { key: keyB })).status,
    ).toBe(404);
    expect(
      (await request(fixture.app, `/v1/files/${file.id}/content`, { key: keyB }))
        .status,
    ).toBe(404);
    expect(
      (await request(fixture.app, `/v1/files/${file.id}`, { key: keyA })).status,
    ).toBe(200);
    fixture.close();
  });

  it("denies session and event access across workspaces by guessed IDs", async () => {
    const fixture = makeAuthFixture();
    const { keyA, keyB } = twoTenants(fixture);
    const session = await createSession(fixture.app, keyA);

    expect(
      (await request(fixture.app, `/v1/sessions/${session.id}`, { key: keyB }))
        .status,
    ).toBe(404);
    expect(
      (
        await request(fixture.app, `/v1/sessions/${session.id}/events`, {
          key: keyB,
        })
      ).status,
    ).toBe(404);
    const crossSend = await request(
      fixture.app,
      `/v1/sessions/${session.id}/events`,
      {
        key: keyB,
        method: "POST",
        body: messageBody("hello from the wrong tenant"),
      },
    );
    expect(crossSend.status).toBe(404);
    expect(
      (await request(fixture.app, `/v1/sessions/${session.id}`, { key: keyA }))
        .status,
    ).toBe(200);
    fixture.close();
  });

  it("does not collide idempotency keys across workspaces", async () => {
    const fixture = makeAuthFixture();
    const { keyA, keyB } = twoTenants(fixture);
    const bodyA = await sessionCreateBody(fixture.app, keyA);
    const bodyB = await sessionCreateBody(fixture.app, keyB);

    const first = await request(fixture.app, "/v1/sessions", {
      key: keyA,
      method: "POST",
      body: bodyA,
      headers: { "idempotency-key": "shared-key" },
    });
    expect(first.status).toBe(200);
    // Same Idempotency-Key + same concrete path + different workspace and
    // body: without workspace scoping this would be a fingerprint-mismatch
    // rejection or a replay of workspace A's session.
    const second = await request(fixture.app, "/v1/sessions", {
      key: keyB,
      method: "POST",
      body: bodyB,
      headers: { "idempotency-key": "shared-key" },
    });
    expect(second.status).toBe(200);
    const sessionA = (await first.json()) as ManagedAgentsSession;
    const sessionB = (await second.json()) as ManagedAgentsSession;
    expect(sessionB.id).not.toBe(sessionA.id);
    fixture.close();
  });
});

describe("deployment auth mode", () => {
  it("parses the two supported modes and trims whitespace", () => {
    expect(parseDeploymentAuthMode({ OMA_AUTH_MODE: "api-key" })).toBe("api-key");
    expect(parseDeploymentAuthMode({ OMA_AUTH_MODE: "disabled" })).toBe("disabled");
    expect(parseDeploymentAuthMode({ OMA_AUTH_MODE: " api-key " })).toBe("api-key");
  });

  it("warns loudly when unset and stays disabled", () => {
    const warn = vi.fn();
    expect(parseDeploymentAuthMode({}, { warn })).toBe("disabled");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("OMA_AUTH_MODE");
  });

  it("fails construction on unknown mode values", () => {
    expect(() => parseDeploymentAuthMode({ OMA_AUTH_MODE: "on" })).toThrow(
      /Unsupported OMA_AUTH_MODE/,
    );
    expect(() => parseDeploymentAuthMode({ OMA_AUTH_MODE: "" })).toThrow(
      /Unsupported OMA_AUTH_MODE/,
    );
  });

  it("rejects api-key mode without durable storage at construction", () => {
    expect(() =>
      createRawDeploymentControlPlaneApp({ OMA_AUTH_MODE: "api-key" }),
    ).toThrow(/OMA_SQLITE_PATH and OMA_FILE_STORAGE_ROOT/);
  });

  it("serves api-key mode from durable storage, honoring keys minted by a second connection", async () => {
    const root = mkdtempSync(join(tmpdir(), "oma-auth-"));
    tempRoots.push(root);
    const sqlitePath = join(root, "oma.db");
    const app = createRawDeploymentControlPlaneApp({
      OMA_AUTH_MODE: "api-key",
      OMA_SQLITE_PATH: sqlitePath,
      OMA_FILE_STORAGE_ROOT: join(root, "objects"),
    });

    expect((await request(app, "/v1/agents")).status).toBe(401);

    // The 0113 D8 provisioning shape: a short-lived direct connection to the
    // same WAL database, while the server stays up. Keys take effect without
    // a restart.
    const provisioning = openWorkspaceStoreForProvisioning(sqlitePath);
    const { plaintextKey } = provisioning.mintKey("wrk_default", "cli");
    provisioning.close();

    expect((await request(app, "/v1/agents", { key: plaintextKey })).status).toBe(
      200,
    );
  });

  it("refuses to provision against a database path that does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-auth-"));
    tempRoots.push(root);
    expect(() =>
      openWorkspaceStoreForProvisioning(join(root, "typo.db")),
    ).toThrow(/existing OMA database/);
  });

  it("mints keys while a concurrent writer holds the database write lock", async () => {
    // busy_timeout is per-connection: a raw unconfigured connection fails
    // instantly with SQLITE_BUSY under a held write lock (probed: 0ms), so
    // the provisioning opener must apply the durable pragmas itself.
    const root = mkdtempSync(join(tmpdir(), "oma-auth-"));
    tempRoots.push(root);
    const sqlitePath = join(root, "oma.db");
    const serverStores = createDeploymentStoresFromEnv({
      OMA_SQLITE_PATH: sqlitePath,
      OMA_FILE_STORAGE_ROOT: join(root, "objects"),
    });

    const worker = new Worker(
      `
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      const db = new DatabaseSync(workerData.path);
      db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE; INSERT INTO workspaces VALUES ('wrk_worker', 'held', 'now')");
      parentPort.postMessage("locked");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, workerData.holdMs);
      `,
      { eval: true, workerData: { path: sqlitePath, holdMs: 300 } },
    );
    await new Promise((res) => worker.on("message", res));

    // Time the whole provisioning operation (open + mint): the opener's
    // schema statements are themselves writes, so the held lock is waited
    // out wherever it bites first.
    const startedAt = Date.now();
    const provisioning = openWorkspaceStoreForProvisioning(sqlitePath);
    const { plaintextKey } = provisioning.mintKey("wrk_default", "contended");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(provisioning.authenticate(plaintextKey)).toBe("wrk_default");
    provisioning.close();
    await new Promise((res) => worker.on("exit", res));
    serverStores.close();
  });
});

describe("multi-workspace runtime recovery", () => {
  it("lists every workspace with pending runtime turns", () => {
    const eventStore = EventStore.open(":memory:");
    expect(eventStore.listWorkspaceIdsWithPendingRuntimeTurns()).toEqual([]);
    seedAcceptedTurn(eventStore, "wrk_a", "sesn_a", "rtun_a");
    seedAcceptedTurn(eventStore, "wrk_b", "sesn_b", "rtun_b");
    expect(eventStore.listWorkspaceIdsWithPendingRuntimeTurns()).toEqual([
      "wrk_a",
      "wrk_b",
    ]);
    eventStore.close();
  });

  it("recovers abandoned turns in every workspace, not just wrk_default", () => {
    const db = new DatabaseSync(":memory:");
    const eventStore = new EventStore(db);
    const sessionStore = new SqliteSessionStore(db);
    const broadcaster = new SessionEventBroadcaster(eventStore);
    const service = new DefaultSessionEventsService(
      eventStore,
      sessionStore,
      broadcaster,
    );
    seedAcceptedTurn(eventStore, "wrk_a", "sesn_a", "rtun_a");
    seedAcceptedTurn(eventStore, "wrk_b", "sesn_b", "rtun_b");
    const perWorkspace = vi.spyOn(service, "recoverAbandonedRuntimeTurns");

    service.recoverAllAbandonedRuntimeTurns();

    expect(perWorkspace.mock.calls.map(([workspaceId]) => workspaceId)).toEqual([
      "wrk_a",
      "wrk_b",
    ]);
    db.close();
  });
});

function makeAuthFixture(opts: { auth?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  const agentStore = new SqliteAgentStore(db);
  const environmentStore = new SqliteEnvironmentStore(db);
  const sessionStore = new SqliteSessionStore(db);
  const eventStore = new EventStore(db);
  const workspaces = new SqliteWorkspaceStore(db);
  const fileStorage = new InMemoryFileStorage();
  const broadcaster = new SessionEventBroadcaster(eventStore);
  const app = createRawControlPlaneApp({
    agents: new DefaultAgentService(agentStore, undefined),
    environments: new DefaultEnvironmentService(environmentStore),
    files: new DefaultFileService(fileStorage),
    sessions: new DefaultSessionService(
      sessionStore,
      agentStore,
      environmentStore,
      fileStorage,
      {
        assertDeletable: () => {},
        idempotencyLedger: eventStore,
        createSessionRowsWithIdempotency:
          sessionStore.createAndCompleteIdempotency.bind(sessionStore),
      },
    ),
    sessionEvents: new DefaultSessionEventsService(
      eventStore,
      sessionStore,
      broadcaster,
    ),
    ...(opts.auth === false
      ? {}
      : { auth: { authenticate: (key: string) => workspaces.authenticate(key) } }),
  });
  return {
    app,
    db,
    workspaces,
    eventStore,
    close: () => {
      db.close();
    },
  };
}

type AuthFixture = ReturnType<typeof makeAuthFixture>;

function twoTenants(fixture: AuthFixture): { keyA: string; keyB: string } {
  const a = fixture.workspaces.createWorkspace("tenant-a");
  const b = fixture.workspaces.createWorkspace("tenant-b");
  return {
    keyA: fixture.workspaces.mintKey(a.workspace_id, "a").plaintextKey,
    keyB: fixture.workspaces.mintKey(b.workspace_id, "b").plaintextKey,
  };
}

function request(
  app: {
    request: (path: string, init?: RequestInit) => Response | Promise<Response>;
  },
  path: string,
  opts: {
    key?: string;
    beta?: boolean;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.beta !== false) headers["anthropic-beta"] = MANAGED_AGENTS_BETA;
  if (opts.key !== undefined) headers["x-api-key"] = opts.key;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(
    app.request(path, {
      method: opts.method ?? "GET",
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
  );
}

async function errorOf(res: Response): Promise<ApiErrorBody["error"]> {
  return ((await res.json()) as ApiErrorBody).error;
}

async function createAgent(
  app: AuthFixture["app"],
  key: string,
): Promise<ManagedAgentsAgent> {
  const res = await request(app, "/v1/agents", {
    key,
    method: "POST",
    body: VALID_AGENT,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsAgent;
}

async function sessionCreateBody(
  app: AuthFixture["app"],
  key: string,
): Promise<{ agent: string; environment_id: string }> {
  const agent = await createAgent(app, key);
  const envRes = await request(app, "/v1/environments", {
    key,
    method: "POST",
    body: VALID_ENVIRONMENT,
  });
  expect(envRes.status).toBe(200);
  const environment = (await envRes.json()) as ManagedAgentsEnvironment;
  return { agent: agent.id, environment_id: environment.id };
}

async function createSession(
  app: AuthFixture["app"],
  key: string,
): Promise<ManagedAgentsSession> {
  const res = await request(app, "/v1/sessions", {
    key,
    method: "POST",
    body: await sessionCreateBody(app, key),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsSession;
}

function messageBody(text: string): unknown {
  return {
    events: [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text }] },
      },
    ],
  };
}

function seedAcceptedTurn(
  eventStore: EventStore,
  workspaceId: string,
  sessionId: string,
  turnId: string,
): void {
  const now = new Date().toISOString();
  eventStore.appendBatchWithRuntimeChanges([], {
    acceptedTurns: [
      {
        workspaceId,
        sessionId,
        turnId,
        ownerId: "owner-test",
        ownerGeneration: 1,
        leaseExpiresAt: now,
        triggerEventIds: [],
        now,
      },
    ],
  });
}
