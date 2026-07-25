import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeploymentControlPlane, MANAGED_AGENTS_BETA } from "../app.ts";
import type { McpFetch } from "../sessions/pi/mcp/fetch.ts";
import { generateAdminKey } from "../admin/auth.ts";
import { ConsoleBootstrapService } from "../console/bootstrap.ts";

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
    await plane.close();
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

  it("exchanges a single-use bootstrap nonce without exposing workspace authority", async () => {
    const bootstrap = new ConsoleBootstrapService();
    const plane = makePlane({ bootstrap });
    const key = plane.stores.workspaces.mintKey("wrk_default", "onboarding-console");
    const nonce = bootstrap.issue(key.plaintextKey);

    const unrelated = await request(plane.app, "/v1/agents", {
      beta: true,
      apiKey: nonce,
    });
    expect(unrelated.status).toBe(401);

    const login = await request(plane.app, "/console/auth/bootstrap", {
      method: "POST",
      body: { nonce },
    });
    expect(login.status).toBe(200);
    expect(await login.text()).not.toContain(nonce);
    const cookie = cookieFrom(login);
    expect(await request(plane.app, "/v1/agents", { cookie, beta: true }).then((response) => response.status)).toBe(200);

    const replay = await request(plane.app, "/console/auth/bootstrap", {
      method: "POST",
      body: { nonce },
    });
    expect(replay.status).toBe(401);
    plane.stores.close();
  });

  it("issues a fresh bootstrap nonce only to the onboarding lifecycle token", async () => {
    const bootstrap = new ConsoleBootstrapService();
    const plane = makePlane({ bootstrap });
    const key = plane.stores.workspaces.mintKey("wrk_default", "onboarding-console");
    bootstrap.bindResumeAuthority(key.plaintextKey, "oct_control");

    expect(await request(plane.app, "/v1/agents", {
      beta: true,
      apiKey: "oct_control",
    }).then((response) => response.status)).toBe(401);

    const denied = await request(plane.app, "/console/auth/bootstrap/renew", {
      method: "POST",
      onboardingToken: "oct_wrong",
    });
    expect(denied.status).toBe(401);

    const renewed = await request(plane.app, "/console/auth/bootstrap/renew", {
      method: "POST",
      onboardingToken: "oct_control",
    });
    expect(renewed.status).toBe(200);
    const { nonce } = await renewed.json() as { nonce: string };
    expect(nonce).toMatch(/^ocb_/);
    expect(await request(plane.app, "/console/auth/bootstrap", {
      method: "POST",
      body: { nonce },
    }).then((response) => response.status)).toBe(200);
    plane.stores.close();
  });

  it("expires bootstrap nonces and rejects cross-origin consumption", async () => {
    let now = 1_000;
    const bootstrap = new ConsoleBootstrapService(() => now, 10);
    const plane = makePlane({ bootstrap });
    const key = plane.stores.workspaces.mintKey("wrk_default", "onboarding-console");
    const crossOriginNonce = bootstrap.issue(key.plaintextKey);
    const foreign = await request(plane.app, "/console/auth/bootstrap", {
      method: "POST",
      body: { nonce: crossOriginNonce },
      origin: "https://attacker.example",
    });
    expect(foreign.status).toBe(403);

    const expiredNonce = bootstrap.issue(key.plaintextKey);
    now += 11;
    const expired = await request(plane.app, "/console/auth/bootstrap", {
      method: "POST",
      body: { nonce: expiredNonce },
    });
    expect(expired.status).toBe(401);
    plane.stores.close();
  });

  it("keeps the default bootstrap nonce valid for ten minutes only", () => {
    let now = 1_000;
    const bootstrap = new ConsoleBootstrapService(() => now);
    const beforeBoundary = bootstrap.issue("oma_workspace_key");
    now += 10 * 60 * 1_000 - 1;
    expect(bootstrap.consume(beforeBoundary)).toBe("oma_workspace_key");

    const atBoundary = bootstrap.issue("oma_workspace_key");
    now += 10 * 60 * 1_000;
    expect(bootstrap.consume(atBoundary)).toBeUndefined();
  });

  it("refuses to register console bootstrap on a non-loopback bind", () => {
    expect(() => makePlane({
      bootstrap: new ConsoleBootstrapService(),
      host: "0.0.0.0",
    })).toThrow(/only on a loopback appliance bind/);
  });

  it("refuses to register local console bootstrap behind TLS termination", () => {
    expect(() => makePlane({
      bootstrap: new ConsoleBootstrapService(),
      tls: true,
    })).toThrow(/not available behind TLS termination/);
  });

  it("completes guided MCP OAuth without putting tokens in the browser or requiring the console cookie on callback", async () => {
    const plane = makePlane({ mcpFetch: oauthConsoleFetch() });
    const key = plane.stores.workspaces.mintKey("wrk_default", "console");
    const login = await request(plane.app, "/console/auth/workspace", {
      method: "POST",
      body: { api_key: key.plaintextKey },
    });
    const cookie = cookieFrom(login);
    const vaultResponse = await request(plane.app, "/v1/vaults", {
      method: "POST",
      cookie,
      beta: true,
      body: { display_name: "Notion" },
    });
    const vault = await vaultResponse.json() as { id: string };

    const foreign = await request(plane.app, "/console/mcp-oauth/flows", {
      method: "POST",
      cookie,
      origin: "https://attacker.example",
      body: { vault_id: vault.id, mcp_server_url: "https://mcp.example.test/mcp" },
    });
    expect(foreign.status).toBe(403);

    const startedResponse = await request(plane.app, "/console/mcp-oauth/flows", {
      method: "POST",
      cookie,
      body: { vault_id: vault.id, display_name: "Notion", mcp_server_url: "https://mcp.example.test/mcp" },
    });
    expect(startedResponse.status, await startedResponse.clone().text()).toBe(200);
    const started = await startedResponse.json() as {
      flow_id: string;
      authorization_url: string;
    };
    const state = new URL(started.authorization_url).searchParams.get("state")!;

    const callback = await request(
      plane.app,
      `/console/mcp-oauth/callback?state=${encodeURIComponent(state)}&code=browser-authorization-code`,
    );
    expect(callback.status).toBe(200);
    expect(callback.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/);
    expect(callback.headers.get("content-security-policy")).not.toContain("script-src 'unsafe-inline'");
    const callbackHtml = await callback.text();
    expect(callbackHtml).toContain("MCP connected");
    expect(callbackHtml).toMatch(/<script nonce="[A-Za-z0-9_-]+">/);
    expect(callbackHtml).not.toContain("access-secret");
    expect(callbackHtml).not.toContain("refresh-secret");

    const status = await request(plane.app, `/console/mcp-oauth/flows/${started.flow_id}`, { cookie });
    expect(await status.json()).toMatchObject({ status: "connected", refreshable: true });
    await plane.close();
  });
});

function makePlane(opts: { tls?: boolean; bootstrap?: ConsoleBootstrapService; host?: string; mcpFetch?: McpFetch } = {}) {
  const root = mkdtempSync(join(tmpdir(), "oma-console-session-"));
  roots.push(root);
  return createDeploymentControlPlane({
    OMA_HOME: root,
    OMA_SQLITE_PATH: join(root, "oma.sqlite"),
    OMA_FILE_STORAGE_ROOT: join(root, "objects"),
    OMA_AUTH_MODE: "api-key",
    OMA_ADMIN_KEY: ADMIN_KEY,
    ...(opts.mcpFetch === undefined
      ? {}
      : {
          OMA_ENABLE_MCP: "true",
          OMA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
        }),
    ...(opts.host === undefined ? {} : { OMA_HOST: opts.host }),
    ...(opts.tls ? { OMA_TLS_TERMINATED: "1" } : {}),
  }, {
    ...(opts.bootstrap === undefined ? {} : { consoleBootstrap: opts.bootstrap }),
    ...(opts.mcpFetch === undefined ? {} : { testMcp: { fetch: opts.mcpFetch } }),
  });
}

function oauthConsoleFetch(): McpFetch {
  return async (input, init) => {
    const url = new URL(input);
    if (url.hostname === "mcp.example.test" && url.pathname.includes(".well-known/oauth-protected-resource")) {
      return json({ resource:"https://mcp.example.test/mcp", authorization_servers:["https://auth.example.test"] });
    }
    if (url.href === "https://auth.example.test/.well-known/oauth-authorization-server") {
      return json({
        issuer:"https://auth.example.test",
        authorization_endpoint:"https://auth.example.test/authorize",
        token_endpoint:"https://auth.example.test/token",
        registration_endpoint:"https://auth.example.test/register",
        response_types_supported:["code"],
        grant_types_supported:["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported:["client_secret_basic", "none"],
        code_challenge_methods_supported:["S256"],
      });
    }
    if (url.href === "https://auth.example.test/register") {
      return json({
        client_id:"oma-console",
        client_secret:"client-secret",
        redirect_uris:["http://console.test/console/mcp-oauth/callback"],
        client_name:"Open Managed Agents",
        grant_types:["authorization_code", "refresh_token"],
        response_types:["code"],
        token_endpoint_auth_method:"client_secret_basic",
      });
    }
    if (url.href === "https://auth.example.test/token" && init?.method === "POST") {
      return json({ access_token:"access-secret", refresh_token:"refresh-secret", token_type:"Bearer", expires_in:3600 });
    }
    return new Response("not found", { status:404 });
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status:200, headers:{ "content-type":"application/json" } });
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
    apiKey?: string;
    onboardingToken?: string;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
  if (opts.beta) headers.set("anthropic-beta", MANAGED_AGENTS_BETA);
  if (opts.apiKey) headers.set("x-api-key", opts.apiKey);
  if (opts.onboardingToken) headers.set("x-oma-onboarding-token", opts.onboardingToken);
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
