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
import { DefaultVaultService } from "../vaults/service.ts";
import { SqliteVaultStore, vaultSecretName } from "../vaults/store.ts";
import { SqliteWorkspaceStore } from "../workspaces/store.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";
import { createRawControlPlaneApp, MANAGED_AGENTS_BETA } from "./helpers.ts";

const TOKEN = "vault-token-0122";
const SERVER_URL = "https://mcp.example.com/mcp";

describe("vaults API", () => {
  it("is workspace-auth gated on every route shape", async () => {
    const fixture = makeVaultsFixture();
    for (const [method, path] of [
      ["POST", "/v1/vaults"],
      ["GET", "/v1/vaults"],
      ["GET", "/v1/vaults/vlt_missing"],
      ["POST", "/v1/vaults/vlt_missing/credentials"],
    ] as const) {
      const res = await request(fixture.app, path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    fixture.close();
  });

  it("creates static bearer credentials without returning token values", async () => {
    const fixture = makeVaultsFixture();
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);

    const created = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials`,
      {
        method: "POST",
        key,
        body: {
          display_name: "Linear",
          metadata: { env: "test" },
          auth: {
            type: "static_bearer",
            mcp_server_url: SERVER_URL,
            token: TOKEN,
          },
        },
      },
    );
    expect(created.status).toBe(200);
    const text = await created.text();
    expect(text).not.toContain(TOKEN);
    const credential = JSON.parse(text) as {
      id: string;
      vault_id: string;
      auth: { type: string; mcp_server_url: string; token?: string };
    };
    expect(credential).toMatchObject({
      type: "vault_credential",
      vault_id: vault.id,
      auth: { type: "static_bearer", mcp_server_url: SERVER_URL },
    });
    expect(credential.auth.token).toBeUndefined();
    expect(
      fixture.secrets?.reveal(
        "wrk_default",
        vaultSecretName(vault.id, credential.id),
      ),
    ).toBe(TOKEN);

    const secrets = await request(fixture.app, "/v1/secrets", { key });
    expect(await secrets.json()).toEqual([]);
    const reserved = await request(fixture.app, "/v1/secrets", {
      method: "POST",
      key,
      body: { name: "vault/user-visible", value: "nope" },
    });
    expect(reserved.status).toBe(400);
    fixture.close();
  });

  it("enforces active URL uniqueness and frees the URL on archive", async () => {
    const fixture = makeVaultsFixture();
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const firstRes = await createCredential(fixture.app, key, vault.id, {
      token: TOKEN,
    });
    expect(firstRes.status).toBe(200);
    const first = (await firstRes.json()) as { id: string };
    const duplicate = await createCredential(fixture.app, key, vault.id, {
      token: "other",
    });
    expect(duplicate.status).toBe(409);

    const archived = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials/${first.id}/archive`,
      { method: "POST", key },
    );
    expect(archived.status).toBe(200);
    expect(
      fixture.secrets?.reveal("wrk_default", vaultSecretName(vault.id, first.id)),
    ).toBeUndefined();

    const replacement = await createCredential(fixture.app, key, vault.id, {
      token: "replacement",
    });
    expect(replacement.status).toBe(200);
    fixture.close();
  });

  it("hard delete removes credential metadata and purges the secret", async () => {
    const fixture = makeVaultsFixture();
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const created = await createCredential(fixture.app, key, vault.id, {
      token: TOKEN,
    });
    expect(created.status).toBe(200);
    const credential = (await created.json()) as { id: string };

    const deleted = await request(fixture.app, `/v1/vaults/${vault.id}`, {
      method: "DELETE",
      key,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ id: vault.id, type: "vault_deleted" });
    expect(
      fixture.secrets?.reveal(
        "wrk_default",
        vaultSecretName(vault.id, credential.id),
      ),
    ).toBeUndefined();
    const retrievedCredential = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials/${credential.id}`,
      { key },
    );
    expect(retrievedCredential.status).toBe(404);
    fixture.close();
  });

  it("keeps vaults metadata usable but rejects credential writes without a master key", async () => {
    const fixture = makeVaultsFixture({ secretsStore: false });
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const res = await createCredential(fixture.app, key, vault.id, { token: TOKEN });
    expect(res.status).toBe(400);
    expect((await res.text())).toContain("OMA_MASTER_KEY");

    const listed = await request(fixture.app, "/v1/vaults", { key });
    expect((await listed.json()) as { data: unknown[] }).toMatchObject({
      data: [{ id: vault.id }],
    });
    fixture.close();
  });

  it("returns master-key guidance 400 when rotating an existing credential without a secrets store", () => {
    const db = new DatabaseSync(":memory:");
    const secrets = new SqliteSecretsStore(
      db,
      parseMasterKey(generateMasterKey(), "test"),
    );
    const seeded = new SqliteVaultStore(db, secrets);
    const serviceWithSecrets = new DefaultVaultService(seeded);
    const vault = serviceWithSecrets.createVault("wrk_default", {
      display_name: "Seeded vault",
    });
    const credential = serviceWithSecrets.createCredential("wrk_default", vault.id, {
      auth: {
        type: "static_bearer",
        mcp_server_url: SERVER_URL,
        token: TOKEN,
      },
    });

    const serviceWithoutSecrets = new DefaultVaultService(
      new SqliteVaultStore(db, undefined),
    );
    let thrown: unknown;
    try {
      serviceWithoutSecrets.updateCredential(
        "wrk_default",
        vault.id,
        credential.id,
        {
          auth: {
            type: "static_bearer",
            token: "rotated",
          },
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      status: 400,
      type: "invalid_request_error",
      message: expect.stringContaining("OMA_MASTER_KEY"),
    });
    db.close();
  });

  it("hides cross-workspace vaults and credentials as not found", async () => {
    const fixture = makeVaultsFixture();
    const workspaceA = fixture.workspaces.createWorkspace("tenant-a").workspace_id;
    const workspaceB = fixture.workspaces.createWorkspace("tenant-b").workspace_id;
    const keyA = fixture.mintKey(workspaceA);
    const keyB = fixture.mintKey(workspaceB);
    const vaultB = await createVault(fixture.app, keyB);
    const createdCredential = await createCredential(fixture.app, keyB, vaultB.id, {
      token: TOKEN,
    });
    const credentialB = await createdCredential.json() as { id: string };

    expect(
      (await request(fixture.app, `/v1/vaults/${vaultB.id}`, { key: keyA })).status,
    ).toBe(404);
    expect(
      (
        await request(
          fixture.app,
          `/v1/vaults/${vaultB.id}/credentials/${credentialB.id}`,
          { key: keyA },
        )
      ).status,
    ).toBe(404);
    fixture.close();
  });

  it("persists and echoes ordered session vault_ids", async () => {
    const fixture = makeVaultsFixture();
    const key = fixture.mintKey("wrk_default");
    const [a, b] = [
      await createVault(fixture.app, key, "A"),
      await createVault(fixture.app, key, "B"),
    ];
    const agent = await createAgent(fixture.app, key);
    const environment = await createEnvironment(fixture.app, key);
    const res = await request(fixture.app, "/v1/sessions", {
      method: "POST",
      key,
      body: {
        agent: agent.id,
        environment_id: environment.id,
        vault_ids: [b.id, a.id],
      },
    });
    expect(res.status).toBe(200);
    const session = (await res.json()) as ManagedAgentsSession;
    expect(session.vault_ids).toEqual([b.id, a.id]);
    expect(fixture.sessions.retrieveAny("wrk_default", session.id)?.vault_ids).toEqual(
      [b.id, a.id],
    );
    fixture.close();
  });
});

function makeVaultsFixture(opts: { secretsStore?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  const agentStore = new SqliteAgentStore(db);
  const environmentStore = new SqliteEnvironmentStore(db);
  const sessionStore = new SqliteSessionStore(db);
  const eventStore = new EventStore(db);
  const workspaces = new SqliteWorkspaceStore(db);
  const secrets =
    opts.secretsStore === false
      ? undefined
      : new SqliteSecretsStore(db, parseMasterKey(generateMasterKey(), "test"));
  const vaultStore = new SqliteVaultStore(db, secrets);
  const vaultService = new DefaultVaultService(vaultStore);
  const fileStorage = new InMemoryFileStorage();
  const broadcaster = new SessionEventBroadcaster(eventStore);
  const app = createRawControlPlaneApp({
    agents: new DefaultAgentService(agentStore),
    environments: new DefaultEnvironmentService(environmentStore),
    files: new DefaultFileService(fileStorage),
    secrets: new DefaultSecretsService(secrets),
    vaults: vaultService,
    sessions: new DefaultSessionService(
      sessionStore,
      agentStore,
      environmentStore,
      fileStorage,
      { vaults: vaultService },
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
    sessions: sessionStore,
    secrets,
    mintKey: (workspaceId: string) =>
      workspaces.mintKey(workspaceId, "test").plaintextKey,
    close: () => db.close(),
  };
}

async function createVault(
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
  key: string,
  name = "Example vault",
): Promise<{ id: string }> {
  const res = await request(app, "/v1/vaults", {
    method: "POST",
    key,
    body: { display_name: name, metadata: { purpose: "test" } },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

function createCredential(
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
  key: string,
  vaultId: string,
  opts: { token: string },
): Promise<Response> {
  return request(app, `/v1/vaults/${vaultId}/credentials`, {
    method: "POST",
    key,
    body: {
      auth: {
        type: "static_bearer",
        mcp_server_url: SERVER_URL,
        token: opts.token,
      },
    },
  });
}

async function createAgent(
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
  key: string,
): Promise<{ id: string }> {
  const res = await request(app, "/v1/agents", {
    method: "POST",
    key,
    body: {
      name: "Vault Agent",
      model: "claude-opus-4-7",
      tools: [{ type: "agent_toolset_20260401" }],
    },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function createEnvironment(
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
  key: string,
): Promise<{ id: string }> {
  const res = await request(app, "/v1/environments", {
    method: "POST",
    key,
    body: {
      name: "Vault Environment",
      config: { type: "cloud", networking: { type: "unrestricted" } },
    },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
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
