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
import { RefreshCoordinator } from "../vaults/oauth-refresh.ts";
import { SqliteVaultStore, vaultSecretName } from "../vaults/store.ts";
import type { McpFetch } from "../sessions/pi/mcp/fetch.ts";
import { SqliteWorkspaceStore } from "../workspaces/store.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";
import { createRawControlPlaneApp, MANAGED_AGENTS_BETA } from "./helpers.ts";

const TOKEN = "vault-token-0122";
const OAUTH_ACCESS = "oauth-access-0122";
const OAUTH_REFRESH = "oauth-refresh-0122";
const OAUTH_CLIENT_SECRET = "oauth-client-secret-0122";
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

  it("creates mcp_oauth credentials without returning secret values", async () => {
    const fixture = makeVaultsFixture();
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);

    const created = await createOauthCredential(fixture.app, key, vault.id);
    expect(created.status).toBe(200);
    const text = await created.text();
    for (const secret of [OAUTH_ACCESS, OAUTH_REFRESH, OAUTH_CLIENT_SECRET]) {
      expect(text).not.toContain(secret);
    }
    const credential = JSON.parse(text) as {
      id: string;
      auth: {
        type: string;
        mcp_server_url: string;
        expires_at?: string;
        refresh?: {
          token_endpoint: string;
          client_id: string;
          scope: string;
          token_endpoint_auth: { type: string; client_secret?: string };
        };
        access_token?: string;
        refresh_token?: string;
      };
    };
    expect(credential).toMatchObject({
      type: "vault_credential",
      vault_id: vault.id,
      auth: {
        type: "mcp_oauth",
        mcp_server_url: SERVER_URL,
        expires_at: "2099-12-31T23:59:59Z",
        refresh: {
          token_endpoint: "https://oauth.example.com/token",
          client_id: "client-id",
          scope: "read write",
          token_endpoint_auth: { type: "client_secret_post" },
        },
      },
    });
    expect(credential.auth.access_token).toBeUndefined();
    expect(credential.auth.refresh_token).toBeUndefined();
    expect(credential.auth.refresh?.token_endpoint_auth.client_secret).toBeUndefined();
    expect(
      JSON.parse(
        fixture.secrets?.reveal(
          "wrk_default",
          vaultSecretName(vault.id, credential.id),
        ) ?? "{}",
      ),
    ).toEqual({
      access_token: OAUTH_ACCESS,
      refresh_token: OAUTH_REFRESH,
      client_secret: OAUTH_CLIENT_SECRET,
    });
    expect(
      fixture.vaultStore.readCredentialRuntimeMetadata(
        "wrk_default",
        vault.id,
        credential.id,
      )?.nextRefreshAt,
    ).toBe("2099-12-31T23:54:59.000Z");
    fixture.close();
  });

  it("gates mcp_oauth_validate before credential lookup or network", async () => {
    const fixture = makeVaultsFixture();
    const key = fixture.mintKey("wrk_default");
    const response = await request(
      fixture.app,
      "/v1/vaults/vlt_missing/credentials/vcrd_missing/mcp_oauth_validate",
      { method: "POST", key },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "MCP is disabled on this deployment",
      },
    });
    fixture.close();
  });

  it("returns the probe-52 no-refresh-token validation shape", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "invalid_token",
          error_description: `echo ${OAUTH_ACCESS}`,
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      )) as McpFetch;
    const fixture = makeVaultsFixture({ mcpFetch: fetch });
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const created = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials`,
      {
        method: "POST",
        key,
        body: {
          auth: {
            type: "mcp_oauth",
            mcp_server_url: SERVER_URL,
            access_token: OAUTH_ACCESS,
          },
        },
      },
    );
    const credential = await created.json() as { id: string };

    const response = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials/${credential.id}/mcp_oauth_validate`,
      { method: "POST", key },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      type: "vault_credential_validation",
      credential_id: credential.id,
      vault_id: vault.id,
      has_refresh_token: false,
      status: "invalid",
      mcp_probe: {
        method: "initialize",
        http_response: {
          status_code: 401,
          content_type: "application/json",
          body_truncated: false,
        },
      },
      refresh: { status: "no_refresh_token", http_response: null },
    });
    expect(JSON.stringify(body)).not.toContain(OAUTH_ACCESS);
    fixture.close();
  });

  it.each([
    {
      name: "reports a successful initial probe without refresh",
      fetch: async () => new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      expected: { status: "valid", refresh: { status: "not_attempted" }, probeStatus: 200 },
    },
    {
      name: "maps a non-auth HTTP failure to unknown without refresh",
      fetch: async () => new Response("upstream unavailable", {
        status: 503,
        headers: { "content-type": "text/plain" },
      }),
      expected: { status: "unknown", refresh: { status: "not_attempted" }, probeStatus: 503 },
    },
    {
      name: "maps a probe transport failure to unknown without refresh",
      fetch: async () => {
        throw new TypeError("network down");
      },
      expected: { status: "unknown", refresh: { status: "not_attempted" }, probeStatus: null },
    },
  ])("$name", async ({ fetch, expected }) => {
    const fixture = makeVaultsFixture({ mcpFetch: fetch as McpFetch });
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const credential = await (await createOauthCredential(fixture.app, key, vault.id)).json() as {
      id: string;
    };

    const response = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials/${credential.id}/mcp_oauth_validate`,
      { method: "POST", key },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      status: string;
      refresh: { status: string };
      mcp_probe: { http_response: { status_code: number } | null };
    };
    expect(body).toMatchObject({
      type: "vault_credential_validation",
      credential_id: credential.id,
      vault_id: vault.id,
      status: expected.status,
      refresh: expected.refresh,
    });
    expect(body.mcp_probe.http_response?.status_code ?? null).toBe(expected.probeStatus);
    fixture.close();
  });

  it.each([
    { name: "invalid", tokenStatus: 400, tokenBody: { error: "invalid_grant" }, status: "invalid" },
    { name: "transient", tokenStatus: 503, tokenBody: { error: "temporarily_unavailable" }, status: "unknown" },
  ])("maps a $name refresh failure at the route boundary", async ({ tokenStatus, tokenBody, status }) => {
    const fetch = (async (input) => {
      if (String(input).includes("oauth.example.com")) {
        return new Response(JSON.stringify(tokenBody), {
          status: tokenStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as McpFetch;
    const fixture = makeVaultsFixture({ mcpFetch: fetch });
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const credential = await (await createOauthCredential(fixture.app, key, vault.id)).json() as {
      id: string;
    };

    const response = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials/${credential.id}/mcp_oauth_validate`,
      { method: "POST", key },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: "vault_credential_validation",
      credential_id: credential.id,
      vault_id: vault.id,
      status,
      mcp_probe: { http_response: { status_code: 401 } },
      refresh: {
        status: "failed",
        http_response: { status_code: tokenStatus, content_type: "application/json" },
      },
    });
    fixture.close();
  });

  it("refreshes once, re-probes with the rotated token, and omits grant bodies", async () => {
    const calls: string[] = [];
    const fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("oauth.example.com")) {
        calls.push("refresh");
        return new Response(
          JSON.stringify({
            access_token: "oauth-rotated-0122",
            refresh_token: "oauth-refresh-rotated-0122",
            expires_in: 600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const authorization = new Headers(init?.headers).get("authorization");
      calls.push(authorization ?? "none");
      if (authorization === "Bearer oauth-rotated-0122") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as McpFetch;
    const fixture = makeVaultsFixture({ mcpFetch: fetch });
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const created = await createOauthCredential(fixture.app, key, vault.id);
    const credential = await created.json() as { id: string };

    const response = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials/${credential.id}/mcp_oauth_validate`,
      { method: "POST", key },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "valid",
      has_refresh_token: true,
      refresh: {
        status: "refreshed",
        http_response: { status_code: 200, content_type: "application/json" },
      },
      mcp_probe: { http_response: { status_code: 200 } },
    });
    expect(calls).toEqual([
      `Bearer ${OAUTH_ACCESS}`,
      "refresh",
      "Bearer oauth-rotated-0122",
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("oauth-rotated-0122");
    expect(serialized).not.toContain("oauth-refresh-rotated-0122");
    fixture.close();
  });

  it.each([
    { name: "an auth rejection", retry: "auth", status: "invalid", probeStatus: 401 },
    { name: "a non-auth HTTP failure", retry: "http", status: "unknown", probeStatus: 503 },
    { name: "a transport failure", retry: "transport", status: "unknown", probeStatus: null },
  ])("maps $name after a successful refresh", async ({ retry, status, probeStatus }) => {
    let probeCalls = 0;
    const fetch = (async (input) => {
      if (String(input).includes("oauth.example.com")) {
        return new Response(JSON.stringify({ access_token: "oauth-retry-0122" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      probeCalls += 1;
      if (probeCalls === 1) {
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (retry === "transport") throw new TypeError("retry transport failure");
      return new Response(
        JSON.stringify({ error: retry === "auth" ? "invalid_token" : "unavailable" }),
        {
          status: retry === "auth" ? 401 : 503,
          headers: { "content-type": "application/json" },
        },
      );
    }) as McpFetch;
    const fixture = makeVaultsFixture({ mcpFetch: fetch });
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const credential = await (await createOauthCredential(fixture.app, key, vault.id)).json() as {
      id: string;
    };

    const response = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials/${credential.id}/mcp_oauth_validate`,
      { method: "POST", key },
    );
    const body = await response.json() as {
      status: string;
      refresh: { status: string };
      mcp_probe: { http_response: { status_code: number } | null };
    };
    expect(body).toMatchObject({ status, refresh: { status: "refreshed" } });
    expect(body.mcp_probe.http_response?.status_code ?? null).toBe(probeStatus);
    fixture.close();
  });

  it("re-probes the CAS winner after a stale refresh failure", async () => {
    const winningAccess = "oauth-cas-winner-0122";
    let rotate: () => Promise<void> = async () => {
      throw new Error("rotation was not configured");
    };
    const fetch = (async (input, init) => {
      if (String(input).includes("oauth.example.com")) {
        await rotate();
        return new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === `Bearer ${winningAccess}`) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as McpFetch;
    const fixture = makeVaultsFixture({ mcpFetch: fetch });
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const credential = await (await createOauthCredential(fixture.app, key, vault.id)).json() as {
      id: string;
    };
    rotate = async () => {
      const response = await request(
        fixture.app,
        `/v1/vaults/${vault.id}/credentials/${credential.id}`,
        {
          method: "POST",
          key,
          body: {
            auth: {
              type: "mcp_oauth",
              access_token: winningAccess,
              expires_at: "2099-12-31T23:59:59Z",
              refresh: { refresh_token: "oauth-cas-refresh-0122" },
            },
          },
        },
      );
      expect(response.status).toBe(200);
    };

    const response = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials/${credential.id}/mcp_oauth_validate`,
      { method: "POST", key },
    );
    const body = await response.json();
    expect(body).toMatchObject({
      status: "valid",
      mcp_probe: { http_response: { status_code: 200 } },
      refresh: {
        status: "failed",
        http_response: { status_code: 503, content_type: "application/json" },
      },
    });
    expect(JSON.stringify(body)).not.toContain(winningAccess);
    fixture.close();
  });

  it("returns the ordinary archived 400 when an archive wins the validate refresh race", async () => {
    // Plan 0124 implementation-audit F3: the token endpoint responds only
    // after the credential is archived through the API, so the refresh
    // persist deterministically loses its fence (stale) and the current
    // snapshot is gone. Must NOT be misreported as a successful validate.
    let archive: () => Promise<void> = async () => {
      throw new Error("archive was not configured");
    };
    const fetch = (async (input) => {
      if (String(input).includes("oauth.example.com")) {
        await archive();
        return new Response(
          JSON.stringify({ access_token: "oauth-archive-race-0124" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as McpFetch;
    const fixture = makeVaultsFixture({ mcpFetch: fetch });
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const credential = await (await createOauthCredential(fixture.app, key, vault.id)).json() as {
      id: string;
    };
    archive = async () => {
      const response = await request(
        fixture.app,
        `/v1/vaults/${vault.id}/credentials/${credential.id}/archive`,
        { method: "POST", key },
      );
      expect(response.status).toBe(200);
    };

    const response = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials/${credential.id}/mcp_oauth_validate`,
      { method: "POST", key },
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("Credential is archived.");
    expect(text).not.toContain("oauth-archive-race-0124");
    fixture.close();
  });

  it("returns the ordinary 404 when a hard delete wins the validate refresh race", async () => {
    // Same F3 race through the refresh-FAILURE stale branch: the token
    // endpoint deletes the credential and then fails transiently, so the
    // fenced failure persist finds no row and the snapshot is gone.
    let remove: () => Promise<void> = async () => {
      throw new Error("delete was not configured");
    };
    const fetch = (async (input) => {
      if (String(input).includes("oauth.example.com")) {
        await remove();
        return new Response(
          JSON.stringify({ error: "temporarily_unavailable" }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as McpFetch;
    const fixture = makeVaultsFixture({ mcpFetch: fetch });
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const credential = await (await createOauthCredential(fixture.app, key, vault.id)).json() as {
      id: string;
    };
    remove = async () => {
      const response = await request(
        fixture.app,
        `/v1/vaults/${vault.id}/credentials/${credential.id}`,
        { method: "DELETE", key },
      );
      expect(response.status).toBe(200);
    };

    const response = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials/${credential.id}/mcp_oauth_validate`,
      { method: "POST", key },
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("not found");
    fixture.close();
  });

  it("accepts missing mcp_oauth expires_at but rejects past expires_at", async () => {
    const fixture = makeVaultsFixture();
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);

    const missing = await createOauthCredential(fixture.app, key, vault.id, {
      expiresAt: null,
      serverUrl: `${SERVER_URL}/no-expiry`,
    });
    expect(missing.status).toBe(200);
    const missingBody = await missing.json() as { auth: { expires_at?: string } };
    expect(missingBody.auth.expires_at).toBeUndefined();

    const past = await createOauthCredential(fixture.app, key, vault.id, {
      expiresAt: "2000-01-01T00:00:00Z",
      serverUrl: `${SERVER_URL}/past-expiry`,
    });
    expect(past.status).toBe(400);
    expect(await past.text()).toContain("expires_at must be in the future");
    fixture.close();
  });

  it("rejects unsafe mcp_oauth token endpoints", async () => {
    const fixture = makeVaultsFixture();
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);

    for (const [tokenEndpoint, expected] of [
      ["http://oauth.example.com/token", "https URL"],
      ["https://user:pass@oauth.example.com/token", "userinfo"],
      ["https://oauth.example.com/token#frag", "userinfo or fragments"],
      ["https://169.254.169.254/token", "not allowed"],
      ["https://100.64.0.1/token", "not allowed"],
      ["https://224.0.0.1/token", "not allowed"],
      ["https://[::ffff:127.0.0.1]/token", "not allowed"],
    ] as const) {
      const res = await createOauthCredential(fixture.app, key, vault.id, {
        serverUrl: `${SERVER_URL}/${encodeURIComponent(tokenEndpoint)}`,
        tokenEndpoint,
      });
      expect(res.status, tokenEndpoint).toBe(400);
      expect(await res.text()).toContain(expected);
    }
    fixture.close();
  });

  it("allows only an explicitly approved insecure token endpoint in tests", async () => {
    const endpoint = "http://127.0.0.1:43123/token";
    const fixture = makeVaultsFixture({
      allowInsecureTokenEndpoint: (url) => url.href === endpoint,
    });
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const allowed = await createOauthCredential(fixture.app, key, vault.id, {
      tokenEndpoint: endpoint,
    });
    expect(allowed.status).toBe(200);
    const denied = await createOauthCredential(fixture.app, key, vault.id, {
      serverUrl: `${SERVER_URL}/denied-local`,
      tokenEndpoint: "http://127.0.0.1:43124/token",
    });
    expect(denied.status).toBe(400);
    fixture.close();
  });

  it("rotates mcp_oauth tokens while preserving structural fields", async () => {
    const fixture = makeVaultsFixture();
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const created = await createOauthCredential(fixture.app, key, vault.id);
    const credential = await created.json() as { id: string };

    const rotated = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials/${credential.id}`,
      {
        method: "POST",
        key,
        body: {
          auth: {
            type: "mcp_oauth",
            access_token: "oauth-access-rotated",
            expires_at: "2099-12-31T23:59:59Z",
            refresh: { refresh_token: "oauth-refresh-rotated" },
          },
        },
      },
    );
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toMatchObject({
      auth: {
        type: "mcp_oauth",
        mcp_server_url: SERVER_URL,
        expires_at: "2099-12-31T23:59:59Z",
        refresh: {
          token_endpoint: "https://oauth.example.com/token",
          client_id: "client-id",
          scope: "read write",
          token_endpoint_auth: { type: "client_secret_post" },
        },
      },
    });
    expect(
      JSON.parse(
        fixture.secrets?.reveal(
          "wrk_default",
          vaultSecretName(vault.id, credential.id),
        ) ?? "{}",
      ),
    ).toEqual({
      access_token: "oauth-access-rotated",
      refresh_token: "oauth-refresh-rotated",
      client_secret: OAUTH_CLIENT_SECRET,
    });
    expect(
      fixture.vaultStore.readCredentialRuntimeMetadata(
        "wrk_default",
        vault.id,
        credential.id,
      )?.nextRefreshAt,
    ).toBe("2099-12-31T23:54:59.000Z");

    for (const body of [
      {
        auth: {
          type: "mcp_oauth",
          refresh: {
            token_endpoint: "https://oauth.changed.example/token",
            refresh_token: "oauth-refresh-rotated-2",
          },
        },
      },
      {
        auth: {
          type: "mcp_oauth",
          refresh: {
            client_id: "changed-client",
            refresh_token: "oauth-refresh-rotated-2",
          },
        },
      },
    ]) {
      const res = await request(
        fixture.app,
        `/v1/vaults/${vault.id}/credentials/${credential.id}`,
        { method: "POST", key, body },
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("immutable");
    }
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
      token: "other-token",
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

  it("enforces the max-20 active credential boundary", async () => {
    const fixture = makeVaultsFixture();
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    for (let i = 0; i < 20; i += 1) {
      const created = await createCredential(fixture.app, key, vault.id, {
        token: `token-value-${i}`,
        serverUrl: `https://mcp.example.com/${i}`,
      });
      expect(created.status, `credential ${i}`).toBe(200);
    }

    const overflow = await createCredential(fixture.app, key, vault.id, {
      token: "overflow",
      serverUrl: "https://mcp.example.com/overflow",
    });
    expect(overflow.status).toBe(400);
    expect(await overflow.text()).toContain("20 active credentials");
    fixture.close();
  });

  it("lists archived credentials only when include_archived=true", async () => {
    const fixture = makeVaultsFixture();
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const created = await createCredential(fixture.app, key, vault.id, {
      token: TOKEN,
    });
    const credential = (await created.json()) as { id: string };
    await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials/${credential.id}/archive`,
      { method: "POST", key },
    );

    const hidden = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials`,
      { key },
    );
    expect(await hidden.json()).toMatchObject({ data: [] });
    const visible = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials?include_archived=true`,
      { key },
    );
    expect(await visible.json()).toMatchObject({
      data: [expect.objectContaining({ id: credential.id, archived_at: expect.any(String) })],
    });
    fixture.close();
  });

  it("paginates vault lists with next_page", async () => {
    const fixture = makeVaultsFixture();
    const key = fixture.mintKey("wrk_default");
    await createVault(fixture.app, key, "A");
    await createVault(fixture.app, key, "B");

    const first = await request(fixture.app, "/v1/vaults?limit=1", { key });
    const firstBody = (await first.json()) as {
      data: Array<{ id: string }>;
      next_page: string | null;
      has_more: boolean;
    };
    expect(firstBody.data).toHaveLength(1);
    expect(firstBody.has_more).toBe(true);
    expect(firstBody.next_page).toBe(firstBody.data[0]?.id);

    const second = await request(
      fixture.app,
      `/v1/vaults?limit=1&page=${firstBody.next_page}`,
      { key },
    );
    expect((await second.json()) as { data: unknown[] }).toMatchObject({
      data: [expect.any(Object)],
    });
    fixture.close();
  });

  it("rejects credential mcp_server_url updates as immutable", async () => {
    const fixture = makeVaultsFixture();
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const created = await createCredential(fixture.app, key, vault.id, {
      token: TOKEN,
    });
    const credential = (await created.json()) as { id: string };

    const update = await request(
      fixture.app,
      `/v1/vaults/${vault.id}/credentials/${credential.id}`,
      {
        method: "POST",
        key,
        body: {
          auth: {
            type: "static_bearer",
            mcp_server_url: "https://mcp.example.com/changed",
            token: "new-token-1",
          },
        },
      },
    );

    expect(update.status).toBe(400);
    expect(await update.text()).toContain("immutable");
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

  it("rejects tokens shorter than the scrub floor", async () => {
    // A token under scrubKnownSecrets' 8-char guard could not be redacted
    // if a hostile server echoed it (review #170, Codex) — unstorable.
    const fixture = makeVaultsFixture();
    const key = fixture.mintKey("wrk_default");
    const vault = await createVault(fixture.app, key);
    const res = await createCredential(fixture.app, key, vault.id, {
      token: "tok",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("at least 8 characters");
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
            token: "rotated-token",
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

  it("rejects unknown and archived vault_ids at session create", async () => {
    const fixture = makeVaultsFixture();
    const key = fixture.mintKey("wrk_default");
    const agent = await createAgent(fixture.app, key);
    const environment = await createEnvironment(fixture.app, key);
    const vault = await createVault(fixture.app, key);
    await request(fixture.app, `/v1/vaults/${vault.id}/archive`, {
      method: "POST",
      key,
    });

    for (const vaultId of ["vlt_missing", vault.id]) {
      const res = await request(fixture.app, "/v1/sessions", {
        method: "POST",
        key,
        body: {
          agent: agent.id,
          environment_id: environment.id,
          vault_ids: [vaultId],
        },
      });
      expect(res.status, vaultId).toBe(400);
    }
    fixture.close();
  });
});

function makeVaultsFixture(
  opts: {
    secretsStore?: boolean;
    mcpFetch?: McpFetch;
    allowInsecureTokenEndpoint?: (url: URL) => boolean;
  } = {},
) {
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
  const vaultService = new DefaultVaultService(vaultStore, {
    ...(opts.allowInsecureTokenEndpoint === undefined
      ? {}
      : { allowInsecureTokenEndpoint: opts.allowInsecureTokenEndpoint }),
  });
  const fileStorage = new InMemoryFileStorage();
  const broadcaster = new SessionEventBroadcaster(eventStore);
  const app = createRawControlPlaneApp({
    agents: new DefaultAgentService(agentStore, undefined),
    environments: new DefaultEnvironmentService(environmentStore),
    files: new DefaultFileService(fileStorage),
    secrets: new DefaultSecretsService(secrets),
    vaults: vaultService,
    ...(opts.mcpFetch === undefined
      ? {}
      : {
          mcp: {
            fetch: opts.mcpFetch,
            refresh: new RefreshCoordinator({ store: vaultStore, fetch: opts.mcpFetch }),
            operationTimeoutMs: 1000,
          },
        }),
    sessions: new DefaultSessionService(
      sessionStore,
      agentStore,
      environmentStore,
      fileStorage,
      { assertDeletable: () => {}, vaults: vaultService },
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
    vaultStore,
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
  opts: { token: string; serverUrl?: string },
): Promise<Response> {
  return request(app, `/v1/vaults/${vaultId}/credentials`, {
    method: "POST",
    key,
    body: {
      auth: {
        type: "static_bearer",
        mcp_server_url: opts.serverUrl ?? SERVER_URL,
        token: opts.token,
      },
    },
  });
}

function createOauthCredential(
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
  key: string,
  vaultId: string,
  opts: {
    serverUrl?: string;
    expiresAt?: string | null;
    tokenEndpoint?: string;
  } = {},
): Promise<Response> {
  const expiresAt =
    opts.expiresAt === undefined ? "2099-12-31T23:59:59Z" : opts.expiresAt;
  return request(app, `/v1/vaults/${vaultId}/credentials`, {
    method: "POST",
    key,
    body: {
      display_name: "OAuth credential",
      auth: {
        type: "mcp_oauth",
        mcp_server_url: opts.serverUrl ?? SERVER_URL,
        access_token: OAUTH_ACCESS,
        ...(expiresAt === null ? {} : { expires_at: expiresAt }),
        refresh: {
          token_endpoint: opts.tokenEndpoint ?? "https://oauth.example.com/token",
          client_id: "client-id",
          scope: "read write",
          refresh_token: OAUTH_REFRESH,
          token_endpoint_auth: {
            type: "client_secret_post",
            client_secret: OAUTH_CLIENT_SECRET,
          },
        },
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
