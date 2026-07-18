import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeploymentControlPlane,
  MAX_REQUEST_BODY_BYTES,
  type DeploymentControlPlane,
} from "../app.ts";
import { generateAdminKey } from "../admin/auth.ts";
import { generateMasterKey } from "../secrets/master-key.ts";
import type { ApiErrorBody } from "../errors.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import { MANAGED_AGENTS_BETA } from "./helpers.ts";

const ADMIN_KEY = generateAdminKey();

const tempRoots: string[] = [];
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("admin API", () => {
  it("is disabled by default", async () => {
    const plane = makePlane({ admin: false });
    const res = await adminRequest(plane.app, "/admin/workspaces");
    expect(res.status).toBe(404);
    plane.stores.close();
  });

  it("requires the admin key and rejects workspace keys", async () => {
    const plane = makePlane();
    const workspaceKey = plane.stores.workspaces.mintKey("wrk_default", "test")
      .plaintextKey;

    for (const [name, key] of [
      ["missing", undefined],
      ["wrong", "wrong-key"],
      ["workspace", workspaceKey],
    ] as const) {
      const res = await adminRequest(plane.app, "/admin/workspaces", {
        adminKey: key,
      });
      expect(res.status, name).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as ApiErrorBody;
      expect(body.error.message).toBe("Authentication failed");
    }

    const ok = await adminRequest(plane.app, "/admin/workspaces", {
      adminKey: ADMIN_KEY,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    plane.stores.close();
  });

  it("does not let the admin key authenticate as a workspace key", async () => {
    const plane = makePlane();
    const res = await managedRequest(plane.app, "/v1/agents", {
      key: ADMIN_KEY,
    });
    expect(res.status).toBe(401);
    plane.stores.close();
  });

  it("creates, lists, and retrieves workspaces", async () => {
    const plane = makePlane();
    const created = await adminRequest(plane.app, "/admin/workspaces", {
      method: "POST",
      adminKey: ADMIN_KEY,
      body: { name: "tenant-a" },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const workspace = (await created.json()) as { id: string; name: string };
    expect(workspace.id).toMatch(/^wrk_/);
    expect(workspace.name).toBe("tenant-a");

    const listed = await adminRequest(plane.app, "/admin/workspaces", {
      adminKey: ADMIN_KEY,
    });
    expect(await listed.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: workspace.id })]),
    );

    const retrieved = await adminRequest(
      plane.app,
      `/admin/workspaces/${workspace.id}`,
      { adminKey: ADMIN_KEY },
    );
    expect(await retrieved.json()).toMatchObject(workspace);

    const missing = await adminRequest(plane.app, "/admin/workspaces/wrk_missing", {
      adminKey: ADMIN_KEY,
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('"action":"create_workspace"'),
    );
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
      ADMIN_KEY,
    );
    plane.stores.close();
  });

  it("mints a key once and never re-reveals plaintext from list-keys", async () => {
    const plane = makePlane();
    const workspace = plane.stores.workspaces.createWorkspace("tenant-a");

    const minted = await adminRequest(
      plane.app,
      `/admin/workspaces/${workspace.workspace_id}/keys`,
      {
        method: "POST",
        adminKey: ADMIN_KEY,
        body: { label: "ci" },
      },
    );
    expect(minted.status).toBe(201);
    const body = (await minted.json()) as {
      workspace_id: string;
      label: string;
      key_sha256: string;
      api_key: string;
    };
    expect(body.workspace_id).toBe(workspace.workspace_id);
    expect(body.label).toBe("ci");
    expect(body.api_key).toMatch(/^oma_/);
    expect(minted.headers.get("cache-control")).toBe("no-store");

    const list = await adminRequest(
      plane.app,
      `/admin/workspaces/${workspace.workspace_id}/keys`,
      { adminKey: ADMIN_KEY },
    );
    const listText = await list.text();
    expect(listText).toContain(body.key_sha256);
    expect(listText).not.toContain(body.api_key);
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining(`"key_sha256":"${body.key_sha256}"`),
    );
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
      body.api_key,
    );
    plane.stores.close();
  });

  it("returns 404 for key operations on nonexistent workspaces", async () => {
    const plane = makePlane();
    const minted = await adminRequest(
      plane.app,
      "/admin/workspaces/wrk_missing/keys",
      { method: "POST", adminKey: ADMIN_KEY },
    );
    expect(minted.status).toBe(404);

    const listed = await adminRequest(
      plane.app,
      "/admin/workspaces/wrk_missing/keys",
      { adminKey: ADMIN_KEY },
    );
    expect(listed.status).toBe(404);
    plane.stores.close();
  });

  it("lists token-free credential health through the paginated admin endpoint", async () => {
    const plane = makePlane({ masterKey: true });
    const workspace = plane.stores.workspaces.createWorkspace("tenant-health");
    plane.stores.vaults.createVault({ row: {
      id: "vlt_health", workspace_id: workspace.workspace_id, type: "vault",
      display_name: "Health vault", metadata: {}, created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z", archived_at: null,
    } });
    plane.stores.vaults.createCredential({
      row: {
        id: "vcrd_health", workspace_id: workspace.workspace_id, vault_id: "vlt_health",
        type: "vault_credential", display_name: "Health credential", metadata: {},
        auth: { type: "static_bearer", mcp_server_url: "https://mcp.example.test/mcp" },
        auth_version: 1, created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z", archived_at: null,
      }, token: "admin-health-secret",
    });
    const path = `/admin/workspaces/${workspace.workspace_id}/mcp-credentials?limit=1`;
    const denied = await adminRequest(plane.app, path);
    expect(denied.status).toBe(401);
    const ok = await adminRequest(plane.app, path, { adminKey: ADMIN_KEY });
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(text).not.toContain("admin-health-secret");
    expect(JSON.parse(text)).toMatchObject({
      data: [expect.objectContaining({
        vaultId: "vlt_health", credentialId: "vcrd_health", hasRefresh: false,
        refreshStatus: null, mcpServerUrl: "https://mcp.example.test/mcp",
      })],
      has_more: false,
      next_page: null,
    });
    const missing = await adminRequest(plane.app, "/admin/workspaces/wrk_missing/mcp-credentials", { adminKey: ADMIN_KEY });
    expect(missing.status).toBe(404);
    plane.stores.close();
  });

  it("paginates deterministically, includes archived rows, and isolates workspaces", async () => {
    // MCP execution deliberately left disabled: this admin read is metadata
    // only and must work (and cause no egress) with OMA_ENABLE_MCP unset.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const plane = makePlane({ masterKey: true });
    const workspace = plane.stores.workspaces.createWorkspace("tenant-page");
    const other = plane.stores.workspaces.createWorkspace("tenant-other");
    const mkVault = (ws: string, id: string) => plane.stores.vaults.createVault({ row: {
      id, workspace_id: ws, type: "vault", display_name: `Vault ${id}`, metadata: {},
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", archived_at: null,
    } });
    const mkCred = (ws: string, vault: string, id: string) => plane.stores.vaults.createCredential({ row: {
      id, workspace_id: ws, vault_id: vault, type: "vault_credential", display_name: id, metadata: {},
      auth: { type: "static_bearer", mcp_server_url: `https://mcp.example.test/${id}` },
      auth_version: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", archived_at: null,
    }, token: "secret-token" });
    mkVault(workspace.workspace_id, "vlt_a");
    mkCred(workspace.workspace_id, "vlt_a", "vcrd_1");
    mkCred(workspace.workspace_id, "vlt_a", "vcrd_2");
    mkCred(workspace.workspace_id, "vlt_a", "vcrd_3");
    plane.stores.vaults.archiveCredential(workspace.workspace_id, "vlt_a", "vcrd_3", "2026-02-01T00:00:00Z");
    mkVault(other.workspace_id, "vlt_x");
    mkCred(other.workspace_id, "vlt_x", "vcrd_other");

    type HealthPage = {
      data: Array<{ credentialId: string; credentialArchivedAt: string | null }>;
      has_more: boolean;
      next_page: string | null;
    };
    const base = `/admin/workspaces/${workspace.workspace_id}/mcp-credentials`;
    const first = (await (await adminRequest(plane.app, `${base}?limit=2`, { adminKey: ADMIN_KEY })).json()) as HealthPage;
    // ORDER BY id DESC → vcrd_3 (archived), vcrd_2; page 2 → vcrd_1.
    expect(first.data.map((r) => r.credentialId)).toEqual(["vcrd_3", "vcrd_2"]);
    expect(first).toMatchObject({ has_more: true, next_page: "vcrd_2" });
    expect(first.data[0]).toMatchObject({ credentialId: "vcrd_3", credentialArchivedAt: "2026-02-01T00:00:00Z" });

    const second = (await (await adminRequest(plane.app, `${base}?limit=2&page=${first.next_page}`, { adminKey: ADMIN_KEY })).json()) as HealthPage;
    expect(second.data.map((r) => r.credentialId)).toEqual(["vcrd_1"]);
    expect(second).toMatchObject({ has_more: false, next_page: null });
    // No other tenant's credential ever appears in this workspace's listing.
    const allIds = [...first.data, ...second.data].map((r) => r.credentialId);
    expect(allIds).not.toContain("vcrd_other");

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    plane.stores.close();
  });

  it("rejects an admin credential-health read carrying only a workspace key", async () => {
    const plane = makePlane({ masterKey: true });
    const workspace = plane.stores.workspaces.createWorkspace("tenant-tier");
    const minted = plane.stores.workspaces.mintKey(workspace.workspace_id, "browse");
    const res = await plane.app.request(
      `/admin/workspaces/${workspace.workspace_id}/mcp-credentials`,
      { headers: { "x-api-key": minted.plaintextKey } },
    );
    expect(res.status).toBe(401);
    plane.stores.close();
  });

  it("rejects malformed admin payloads", async () => {
    const plane = makePlane();
    const workspace = plane.stores.workspaces.createWorkspace("tenant-a");

    for (const body of [
      [],
      {},
      { name: "" },
      { name: 123 },
    ]) {
      const res = await adminRequest(plane.app, "/admin/workspaces", {
        method: "POST",
        adminKey: ADMIN_KEY,
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }

    for (const body of [
      [],
      { label: "" },
      { label: 123 },
    ]) {
      const res = await adminRequest(
        plane.app,
        `/admin/workspaces/${workspace.workspace_id}/keys`,
        { method: "POST", adminKey: ADMIN_KEY, body },
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }

    const invalidJson = await Promise.resolve(
      plane.app.request(`/admin/workspaces/${workspace.workspace_id}/keys`, {
        method: "POST",
        headers: {
          "x-admin-key": ADMIN_KEY,
          "content-type": "application/json",
        },
        body: "{",
      }),
    );
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.headers.get("cache-control")).toBe("no-store");

    const unknownRoute = await adminRequest(plane.app, "/admin/nope", {
      adminKey: ADMIN_KEY,
    });
    expect(unknownRoute.status).toBe(404);
    expect(unknownRoute.headers.get("cache-control")).toBe("no-store");

    const tooLargeBody = JSON.stringify({ name: "x".repeat(MAX_REQUEST_BODY_BYTES) });
    const tooLarge = await Promise.resolve(
      plane.app.request("/admin/workspaces", {
        method: "POST",
        headers: {
          "x-admin-key": ADMIN_KEY,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(tooLargeBody)),
        },
        body: tooLargeBody,
      }),
    );
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers.get("cache-control")).toBe("no-store");
    plane.stores.close();
  });

  it("minted keys authenticate against managed-agents routes", async () => {
    const plane = makePlane();
    const workspace = plane.stores.workspaces.createWorkspace("tenant-a");
    const minted = await adminRequest(
      plane.app,
      `/admin/workspaces/${workspace.workspace_id}/keys`,
      { method: "POST", adminKey: ADMIN_KEY },
    );
    const { api_key: apiKey } = (await minted.json()) as { api_key: string };

    const created = await managedRequest(plane.app, "/v1/agents", {
      method: "POST",
      key: apiKey,
      body: { name: "agent", model: "claude-opus-4-7" },
    });
    expect(created.status).toBe(200);
    const agent = (await created.json()) as ManagedAgentsAgent;
    expect(agent.name).toBe("agent");
    plane.stores.close();
  });

  it("revokes keys and makes revoked keys fail workspace auth", async () => {
    const plane = makePlane();
    const workspace = plane.stores.workspaces.createWorkspace("tenant-a");
    const { plaintextKey, keySha256 } = plane.stores.workspaces.mintKey(
      workspace.workspace_id,
      "ci",
    );

    const revoked = await adminRequest(plane.app, `/admin/keys/${keySha256}`, {
      method: "DELETE",
      adminKey: ADMIN_KEY,
    });
    expect(revoked.status).toBe(200);
    const revokedBody = (await revoked.json()) as { revoked_at: string | null };
    expect(revokedBody.revoked_at).toEqual(expect.any(String));

    const again = await adminRequest(plane.app, `/admin/keys/${keySha256}`, {
      method: "DELETE",
      adminKey: ADMIN_KEY,
    });
    expect(await again.json()).toMatchObject({
      key_sha256: keySha256,
      revoked_at: revokedBody.revoked_at,
    });
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining(`"key_sha256":"${keySha256}"`),
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining(`"revoked_at":"${revokedBody.revoked_at}"`),
    );

    const managed = await managedRequest(plane.app, "/v1/agents", {
      key: plaintextKey,
    });
    expect(managed.status).toBe(401);

    const missing = await adminRequest(plane.app, "/admin/keys/nope", {
      method: "DELETE",
      adminKey: ADMIN_KEY,
    });
    expect(missing.status).toBe(404);
    plane.stores.close();
  });

  it("manages keys across workspaces as the operator tier", async () => {
    const plane = makePlane();
    const a = plane.stores.workspaces.createWorkspace("tenant-a");
    const b = plane.stores.workspaces.createWorkspace("tenant-b");
    const keyA = await adminRequest(
      plane.app,
      `/admin/workspaces/${a.workspace_id}/keys`,
      { method: "POST", adminKey: ADMIN_KEY, body: { label: "a" } },
    );
    const keyB = await adminRequest(
      plane.app,
      `/admin/workspaces/${b.workspace_id}/keys`,
      { method: "POST", adminKey: ADMIN_KEY, body: { label: "b" } },
    );
    expect(keyA.status).toBe(201);
    expect(keyB.status).toBe(201);

    const listA = await adminRequest(
      plane.app,
      `/admin/workspaces/${a.workspace_id}/keys`,
      { adminKey: ADMIN_KEY },
    );
    const listB = await adminRequest(
      plane.app,
      `/admin/workspaces/${b.workspace_id}/keys`,
      { adminKey: ADMIN_KEY },
    );
    expect(await listA.json()).toEqual([expect.objectContaining({ label: "a" })]);
    expect(await listB.json()).toEqual([expect.objectContaining({ label: "b" })]);
    plane.stores.close();
  });

  it("fails closed at boot for weak or misleading admin configurations", () => {
    expect(() => makePlane({ adminKey: "not-a-canonical-256-bit-key" })).toThrow(
      "exactly 32 random bytes",
    );
    expect(() =>
      makePlane({ durable: false, authMode: "api-key" }),
    ).toThrow("requires durable deployment storage");
    expect(() =>
      makePlane({ admin: true, authMode: "disabled" }),
    ).toThrow("requires OMA_AUTH_MODE=api-key");
    expect(() =>
      makePlane({ admin: true, authMode: undefined }),
    ).toThrow("requires OMA_AUTH_MODE=api-key");
  });
});

function makePlane(opts: {
  admin?: boolean;
  adminKey?: string;
  durable?: boolean;
  authMode?: "api-key" | "disabled" | undefined;
  masterKey?: boolean;
} = {}): DeploymentControlPlane {
  const root = mkdtempSync(join(tmpdir(), "oma-admin-api-"));
  tempRoots.push(root);
  const durable = opts.durable ?? true;
  const admin = opts.admin ?? true;
  const authMode = Object.hasOwn(opts, "authMode") ? opts.authMode : "api-key";
  return createDeploymentControlPlane({
    OMA_HOME: root,
    ...(durable
      ? {
          OMA_SQLITE_PATH: join(root, "oma.sqlite"),
          OMA_FILE_STORAGE_ROOT: join(root, "objects"),
        }
      : {}),
    ...(authMode === undefined ? {} : { OMA_AUTH_MODE: authMode }),
    ...(admin ? { OMA_ADMIN_KEY: opts.adminKey ?? ADMIN_KEY } : {}),
    ...(opts.masterKey ? { OMA_MASTER_KEY: generateMasterKey() } : {}),
  });
}

function adminRequest(
  app: {
    request: (path: string, init?: RequestInit) => Response | Promise<Response>;
  },
  path: string,
  opts: {
    adminKey?: string;
    method?: string;
    body?: unknown;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.adminKey !== undefined) headers["x-admin-key"] = opts.adminKey;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(
    app.request(path, {
      method: opts.method ?? "GET",
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
  );
}

function managedRequest(
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
