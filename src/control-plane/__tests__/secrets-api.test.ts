// Plan 0117e-2: the minimal workspace-scoped secrets API. The properties
// under test are the authz-explicit ones from the plan: workspace keys are
// the (single) auth tier, cross-workspace access is impossible, secret
// VALUES never appear in any response body, and a deployment without a
// master key gets a clear 400 instead of a phantom resource.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DefaultAgentService } from "../agents/service.ts";
import { SqliteAgentStore } from "../agents/store.ts";
import { DefaultEnvironmentService } from "../environments/service.ts";
import { SqliteEnvironmentStore } from "../environments/store.ts";
import { SessionEventBroadcaster } from "../events/broadcaster.ts";
import { DefaultSessionEventsService } from "../events/service.ts";
import { EventStore } from "../events/store.ts";
import { DefaultFileService } from "../files/service.ts";
import { InMemoryFileStorage } from "../files/store.ts";
import { generateMasterKey, parseMasterKey } from "../secrets/master-key.ts";
import { DefaultSecretsService } from "../secrets/service.ts";
import { SqliteSecretsStore } from "../secrets/store.ts";
import { DefaultSessionService } from "../sessions/service.ts";
import { SqliteSessionStore } from "../sessions/store.ts";
import { SqliteWorkspaceStore } from "../workspaces/store.ts";
import type { ApiErrorBody } from "../errors.ts";
import { createRawControlPlaneApp, MANAGED_AGENTS_BETA } from "./helpers.ts";

const SECRET_VALUE = "SUPER-SECRET-VALUE-0117e";

describe("secrets API", () => {
  it("requires a workspace key like every other managed-agents route", async () => {
    const fixture = makeSecretsFixture();
    for (const [method, path] of [
      ["POST", "/v1/secrets"],
      ["GET", "/v1/secrets"],
      ["DELETE", "/v1/secrets/github"],
    ] as const) {
      const res = await request(fixture.app, path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    fixture.close();
  });

  it("round-trips put/list/delete without ever returning the value", async () => {
    const fixture = makeSecretsFixture();
    const key = fixture.mintKey("wrk_default");

    const created = await request(fixture.app, "/v1/secrets", {
      method: "POST",
      key,
      body: { name: "github", value: SECRET_VALUE },
    });
    expect(created.status).toBe(201);
    const createdText = await created.text();
    expect(createdText).not.toContain(SECRET_VALUE);
    expect(JSON.parse(createdText)).toMatchObject({
      type: "secret",
      name: "github",
    });

    const listed = await request(fixture.app, "/v1/secrets", { key });
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(listedText).not.toContain(SECRET_VALUE);
    expect(JSON.parse(listedText)).toMatchObject([{ name: "github" }]);

    // The value IS stored — reveal (the egress boundary's accessor) sees it.
    expect(fixture.secrets.reveal("wrk_default", "github")).toBe(SECRET_VALUE);

    const deleted = await request(fixture.app, "/v1/secrets/github", {
      method: "DELETE",
      key,
    });
    expect(deleted.status).toBe(204);
    expect(fixture.secrets.reveal("wrk_default", "github")).toBeUndefined();

    const deletedAgain = await request(fixture.app, "/v1/secrets/github", {
      method: "DELETE",
      key,
    });
    expect(deletedAgain.status).toBe(404);
    fixture.close();
  });

  it("does not allow generic delete of reserved vault-backed secret names", async () => {
    const fixture = makeSecretsFixture();
    const key = fixture.mintKey("wrk_default");
    fixture.secrets.put("wrk_default", "vault/vlt_123/vcrd_456", SECRET_VALUE);

    const deleted = await request(
      fixture.app,
      "/v1/secrets/vault%2Fvlt_123%2Fvcrd_456",
      {
        method: "DELETE",
        key,
      },
    );

    expect(deleted.status).toBe(400);
    expect(
      fixture.secrets.reveal("wrk_default", "vault/vlt_123/vcrd_456"),
    ).toBe(SECRET_VALUE);
    fixture.close();
  });

  it("isolates secrets between workspaces", async () => {
    const fixture = makeSecretsFixture();
    const keyA = fixture.mintKey(
      fixture.workspaces.createWorkspace("tenant-a").workspace_id,
    );
    const b = fixture.workspaces.createWorkspace("tenant-b");
    const keyB = fixture.mintKey(b.workspace_id);

    const created = await request(fixture.app, "/v1/secrets", {
      method: "POST",
      key: keyB,
      body: { name: "github", value: SECRET_VALUE },
    });
    expect(created.status).toBe(201);

    // A's key sees nothing and cannot delete B's secret.
    const listedByA = await request(fixture.app, "/v1/secrets", { key: keyA });
    expect(await listedByA.json()).toEqual([]);
    const deletedByA = await request(fixture.app, "/v1/secrets/github", {
      method: "DELETE",
      key: keyA,
    });
    expect(deletedByA.status).toBe(404);
    expect(fixture.secrets.reveal(b.workspace_id, "github")).toBe(SECRET_VALUE);
    fixture.close();
  });

  it("returns the master-key guidance 400 when no secrets store is configured", async () => {
    const fixture = makeSecretsFixture({ secretsStore: false });
    const key = fixture.mintKey("wrk_default");
    for (const [method, path, body] of [
      ["POST", "/v1/secrets", { name: "github", value: SECRET_VALUE }],
      ["GET", "/v1/secrets", undefined],
      ["DELETE", "/v1/secrets/github", undefined],
    ] as const) {
      const res = await request(fixture.app, path, { method, key, body });
      expect(res.status, `${method} ${path}`).toBe(400);
      const errBody = (await res.json()) as ApiErrorBody;
      expect(errBody.error.message).toContain("OMA_MASTER_KEY");
    }
    fixture.close();
  });

  it("rejects malformed create payloads", async () => {
    const fixture = makeSecretsFixture();
    const key = fixture.mintKey("wrk_default");
    for (const body of [
      { value: SECRET_VALUE },
      { name: "github" },
      { name: "", value: SECRET_VALUE },
      { name: "github", value: "" },
      { name: "x".repeat(257), value: SECRET_VALUE },
      [],
    ]) {
      const res = await request(fixture.app, "/v1/secrets", {
        method: "POST",
        key,
        body,
      });
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    fixture.close();
  });
});

function makeSecretsFixture(opts: { secretsStore?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  const agentStore = new SqliteAgentStore(db);
  const environmentStore = new SqliteEnvironmentStore(db);
  const sessionStore = new SqliteSessionStore(db);
  const eventStore = new EventStore(db);
  const workspaces = new SqliteWorkspaceStore(db);
  const secrets = new SqliteSecretsStore(
    db,
    parseMasterKey(generateMasterKey(), "test"),
  );
  const fileStorage = new InMemoryFileStorage();
  const broadcaster = new SessionEventBroadcaster(eventStore);
  const app = createRawControlPlaneApp({
    agents: new DefaultAgentService(agentStore, undefined),
    environments: new DefaultEnvironmentService(environmentStore),
    files: new DefaultFileService(fileStorage),
    secrets: new DefaultSecretsService(
      opts.secretsStore === false ? undefined : secrets,
    ),
    sessions: new DefaultSessionService(
      sessionStore,
      agentStore,
      environmentStore,
      fileStorage,
      { assertDeletable: () => {} },
    ),
    sessionEvents: new DefaultSessionEventsService(
      eventStore,
      sessionStore,
      broadcaster,
    ),
    auth: { authenticate: (key: string) => workspaces.authenticate(key) },
  });
  return {
    app,
    workspaces,
    secrets,
    mintKey: (workspaceId: string) =>
      workspaces.mintKey(workspaceId, "test").plaintextKey,
    close: () => db.close(),
  };
}

function request(
  app: {
    request: (path: string, init?: RequestInit) => Response | Promise<Response>;
  },
  path: string,
  opts: {
    key?: string;
    method?: string;
    body?: unknown;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "anthropic-beta": MANAGED_AGENTS_BETA,
  };
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
