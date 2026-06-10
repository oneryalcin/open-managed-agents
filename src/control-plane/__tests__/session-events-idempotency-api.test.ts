import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";
import { DefaultAgentService } from "../agents/service.ts";
import { SqliteAgentStore } from "../agents/store.ts";
import { createControlPlaneApp } from "./helpers.ts";
import { DefaultEnvironmentService } from "../environments/service.ts";
import { SqliteEnvironmentStore } from "../environments/store.ts";
import { SessionEventBroadcaster } from "../events/broadcaster.ts";
import { DefaultSessionEventsService } from "../events/service.ts";
import { EventStore } from "../events/store.ts";
import { DefaultFileService } from "../files/service.ts";
import { InMemoryFileStorage } from "../files/store.ts";
import { DefaultSessionService } from "../sessions/service.ts";
import { SqliteSessionStore } from "../sessions/store.ts";
import type { ApiErrorBody } from "../errors.ts";

const VALID_AGENT = {
  name: "Idempotency Agent",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
};

const VALID_ENVIRONMENT = {
  name: "Idempotency Environment",
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
  },
};

const ROUTE_LABEL = "POST /v1/sessions/{session_id}/events";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Session events idempotency", () => {
  it("returns 409 for a fresh in-progress request with the same key and body", async () => {
    const fixture = makeFixture();
    const session = await setupSession(fixture.app);
    const body = messageBody("busy");
    const concretePath = `/v1/sessions/${session.id}/events`;
    reserve(fixture.eventStore, {
      sessionId: session.id,
      key: "fresh-in-progress",
      body,
      now: new Date(),
    });

    const res = await postEvents(fixture.app, session.id, body, "fresh-in-progress");

    await expectError(
      res,
      409,
      "invalid_request_error",
      "A request with this `Idempotency-Key` is already in progress; retry later",
    );
    expect(fixture.eventStore.list("wrk_default", session.id)).toEqual([]);
    expect(concretePath).toBe(`/v1/sessions/${session.id}/events`);
    fixture.close();
  });

  it("reacquires abandoned in-progress rows and executes the request", async () => {
    const fixture = makeFixture();
    const session = await setupSession(fixture.app);
    const body = messageBody("after abandon");
    reserve(fixture.eventStore, {
      sessionId: session.id,
      key: "abandoned",
      body,
      now: new Date(Date.now() - 10 * 60 * 1000),
    });

    const res = await postEvents(fixture.app, session.id, body, "abandoned");

    expect(res.status).toBe(200);
    const response = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(response.data).toHaveLength(1);
    expect(fixture.eventStore.list("wrk_default", session.id)).toHaveLength(1);
    fixture.close();
  });

  it("purges expired completed rows and treats the key as reusable", async () => {
    const fixture = makeFixture();
    const session = await setupSession(fixture.app);
    const body = messageBody("after expiry");
    const oldNow = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const method = "POST";
    const concretePath = `/v1/sessions/${session.id}/events`;
    reserve(fixture.eventStore, {
      sessionId: session.id,
      key: "expired",
      body,
      now: oldNow,
    });
    fixture.eventStore.completeIdempotency({
      workspaceId: "wrk_default",
      method,
      concretePath,
      key: "expired",
      routeLabel: ROUTE_LABEL,
      fingerprintSha256: requestFingerprint(method, concretePath, body),
      responseStatus: 200,
      responseBody: { data: [{ id: "stale" }] },
      now: oldNow.toISOString(),
      expiresAt: new Date(oldNow.getTime() + 1000).toISOString(),
    });

    const res = await postEvents(fixture.app, session.id, body, "expired");

    expect(res.status).toBe(200);
    const response = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(response.data[0].id).toEqual(expect.stringMatching(/^sevt_/));
    expect(response.data[0].id).not.toBe("stale");
    expect(fixture.eventStore.list("wrk_default", session.id)).toHaveLength(1);
    fixture.close();
  });

  it("purges idempotency responses when the session is deleted", async () => {
    const fixture = makeFixture();
    const session = await setupSession(fixture.app);
    const body = messageBody("delete me");
    const first = await postEvents(fixture.app, session.id, body, "delete-key");
    expect(first.status).toBe(200);

    const deleted = await fixture.app.request(`/v1/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);

    await expectError(
      await postEvents(fixture.app, session.id, body, "delete-key"),
      404,
      "not_found_error",
      `Session ${session.id} not found`,
    );
    fixture.close();
  });

  it("rolls back event rows when idempotency completion aborts in the transaction", async () => {
    const fixture = makeFixture();
    const session = await setupSession(fixture.app);
    fixture.db.exec(`
      CREATE TRIGGER abort_idempotency_completion
      BEFORE UPDATE OF status ON idempotency_keys
      WHEN NEW.status = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'abort idempotency completion');
      END;
    `);

    const res = await postEvents(fixture.app, session.id, messageBody("rollback"), "abort");

    expect(res.status).toBe(500);
    expect(fixture.eventStore.list("wrk_default", session.id)).toEqual([]);
    fixture.db.exec("DROP TRIGGER abort_idempotency_completion");
    await expectError(
      await postEvents(fixture.app, session.id, messageBody("rollback"), "abort"),
      409,
      "invalid_request_error",
      "A request with this `Idempotency-Key` is already in progress; retry later",
    );
    fixture.close();
  });

  it("replays completed responses after reopening the SQLite database", async () => {
    const root = mkdtempSync(join(tmpdir(), "oma-idempotency-"));
    tempRoots.push(root);
    const path = join(root, "oma.sqlite");
    const firstFixture = makeFixture(path);
    const session = await setupSession(firstFixture.app);
    const body = messageBody("restart");
    const first = await postEvents(firstFixture.app, session.id, body, "restart-key");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: Array<Record<string, unknown>> };
    firstFixture.close();

    const secondFixture = makeFixture(path);
    const second = await postEvents(secondFixture.app, session.id, body, "restart-key");
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual(firstBody);
    expect(secondFixture.eventStore.list("wrk_default", session.id)).toHaveLength(1);
    secondFixture.close();
  });
});

function makeFixture(path = ":memory:") {
  const db = new DatabaseSync(path);
  const agentStore = new SqliteAgentStore(db);
  const environmentStore = new SqliteEnvironmentStore(db);
  const sessionStore = new SqliteSessionStore(db);
  const eventStore = new EventStore(db);
  const fileStorage = new InMemoryFileStorage();
  const broadcaster = new SessionEventBroadcaster(eventStore);
  const app = createControlPlaneApp({
    agents: new DefaultAgentService(agentStore),
    environments: new DefaultEnvironmentService(environmentStore),
    files: new DefaultFileService(fileStorage),
    sessions: new DefaultSessionService(
      sessionStore,
      agentStore,
      environmentStore,
      fileStorage,
    ),
    sessionEvents: new DefaultSessionEventsService(
      eventStore,
      sessionStore,
      broadcaster,
    ),
  });
  return {
    app,
    db,
    eventStore,
    close: () => {
      db.close();
    },
  };
}

function reserve(
  store: EventStore,
  input: { sessionId: string; key: string; body: string; now: Date },
): void {
  const method = "POST";
  const concretePath = `/v1/sessions/${input.sessionId}/events`;
  const result = store.reserveIdempotencyKey({
    workspaceId: "wrk_default",
    method,
    concretePath,
    key: input.key,
    routeLabel: ROUTE_LABEL,
    fingerprintSha256: requestFingerprint(method, concretePath, input.body),
    now: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    abandonedBefore: new Date(input.now.getTime() - 5 * 60 * 1000).toISOString(),
  });
  expect(result).toEqual({ kind: "reserved" });
}

function requestFingerprint(
  method: string,
  concretePath: string,
  rawBody: string,
): string {
  const hash = createHash("sha256");
  hash.update(method);
  hash.update("\n");
  hash.update(concretePath);
  hash.update("\n");
  hash.update(rawBody);
  return hash.digest("hex");
}

function messageBody(text: string): string {
  return JSON.stringify({
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
}

async function setupSession(
  app: ReturnType<typeof createControlPlaneApp>,
): Promise<ManagedAgentsSession> {
  const agent = await createAgent(app);
  const environment = await createEnvironment(app);
  return createSession(app, {
    agent: agent.id,
    environment_id: environment.id,
  });
}

async function postEvents(
  app: ReturnType<typeof createControlPlaneApp>,
  sessionId: string,
  body: string,
  idempotencyKey: string,
): Promise<Response> {
  return app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body,
  });
}

async function createAgent(
  app: ReturnType<typeof createControlPlaneApp>,
): Promise<ManagedAgentsAgent> {
  const res = await app.request("/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(VALID_AGENT),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsAgent;
}

async function createEnvironment(
  app: ReturnType<typeof createControlPlaneApp>,
): Promise<ManagedAgentsEnvironment> {
  const res = await app.request("/v1/environments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(VALID_ENVIRONMENT),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsEnvironment;
}

async function createSession(
  app: ReturnType<typeof createControlPlaneApp>,
  body: unknown,
): Promise<ManagedAgentsSession> {
  const res = await app.request("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsSession;
}

async function expectError(
  res: Response,
  status: number,
  type: ApiErrorBody["error"]["type"],
  message: string,
): Promise<void> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as ApiErrorBody;
  expect(body).toEqual({
    type: "error",
    error: { type, message },
    request_id: expect.stringMatching(/^req_/),
  });
}
