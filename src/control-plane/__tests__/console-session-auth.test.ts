import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeploymentControlPlane, MANAGED_AGENTS_BETA } from "../app.ts";
import { generateAdminKey } from "../admin/auth.ts";

const ADMIN_KEY = generateAdminKey();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("console session authentication", () => {
  it("exchanges a workspace key for an opaque cookie and honors key revocation", async () => {
    const plane = makePlane();
    const key = plane.stores.workspaces.mintKey("wrk_default", "console");
    const login = await request(plane.app, "/console/auth/workspace", {
      method: "POST",
      body: { api_key: key.plaintextKey },
    });
    expect(login.status).toBe(200);
    expect(await login.text()).not.toContain(key.plaintextKey);
    const cookie = cookieFrom(login);
    expect(cookie).toMatch(/^oma_console_workspace=ocs_/);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(login.headers.get("set-cookie")).toContain("SameSite=Strict");

    const context = await request(plane.app, "/v1/agents", { cookie, beta: true });
    expect(context.status).toBe(200);

    plane.stores.workspaces.revokeKey(key.keySha256);
    const revoked = await request(plane.app, "/v1/agents", { cookie, beta: true });
    expect(revoked.status).toBe(401);
    plane.stores.close();
  });

  it("keeps admin and workspace authority separate while allowing admin selection", async () => {
    const plane = makePlane();
    const workspace = plane.stores.workspaces.createWorkspace("Tenant A");
    const adminLogin = await request(plane.app, "/console/auth/admin", {
      method: "POST",
      body: { admin_key: ADMIN_KEY },
    });
    const adminCookie = cookieFrom(adminLogin);
    expect(adminLogin.status).toBe(200);

    const adminOnlyWorkspaceCall = await request(plane.app, "/v1/agents", {
      cookie: adminCookie,
      beta: true,
    });
    expect(adminOnlyWorkspaceCall.status).toBe(401);

    const selected = await request(plane.app, "/console/auth/select-workspace", {
      method: "POST",
      body: { workspace_id: workspace.workspace_id },
      cookie: adminCookie,
    });
    expect(selected.status).toBe(200);
    const workspaceCookie = cookieFrom(selected);
    const context = await request(plane.app, "/v1/agents", { cookie: workspaceCookie, beta: true });
    expect(context.status).toBe(200);

    const foreignOrigin = await request(plane.app, "/v1/agents", {
      method: "POST",
      cookie: workspaceCookie,
      beta: true,
      origin: "https://attacker.example",
      body: {},
    });
    expect(foreignOrigin.status).toBe(403);
    plane.stores.close();
  });

  it("uses Secure cookies only when TLS termination is explicitly configured", async () => {
    const loopback = makePlane();
    const key = loopback.stores.workspaces.mintKey("wrk_default", "console");
    const plain = await request(loopback.app, "/console/auth/workspace", { method: "POST", body: { api_key: key.plaintextKey } });
    expect(plain.headers.get("set-cookie")).not.toContain("Secure");
    loopback.stores.close();

    const tls = makePlane({ tls: true });
    const tlsKey = tls.stores.workspaces.mintKey("wrk_default", "console");
    const secure = await request(tls.app, "/console/auth/workspace", { method: "POST", body: { api_key: tlsKey.plaintextKey } });
    expect(secure.headers.get("set-cookie")).toContain("Secure");
    tls.stores.close();
  });
});

function makePlane(opts: { tls?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "oma-console-session-"));
  roots.push(root);
  return createDeploymentControlPlane({
    OMA_HOME: root,
    OMA_SQLITE_PATH: join(root, "oma.sqlite"),
    OMA_FILE_STORAGE_ROOT: join(root, "objects"),
    OMA_AUTH_MODE: "api-key",
    OMA_ADMIN_KEY: ADMIN_KEY,
    ...(opts.tls ? { OMA_TLS_TERMINATED: "1" } : {}),
  });
}

function request(
  app: ReturnType<typeof createDeploymentControlPlane>["app"],
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    cookie?: string;
    beta?: boolean;
    origin?: string;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
  if (opts.beta) headers.set("anthropic-beta", MANAGED_AGENTS_BETA);
  if (opts.method && opts.method !== "GET") headers.set("origin", opts.origin ?? "http://console.test");
  return Promise.resolve(app.fetch(new Request(`http://console.test${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })));
}

function cookieFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  expect(cookie).not.toBeNull();
  return cookie!.split(";", 1)[0]!;
}
