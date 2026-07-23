import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSecretsStore } from "../../secrets/store.ts";
import type { McpFetch } from "../../sessions/pi/mcp/fetch.ts";
import { DefaultVaultService } from "../service.ts";
import { SqliteVaultStore } from "../store.ts";
import {
  ConsoleMcpOauthService,
  CONSOLE_MCP_OAUTH_FLOW_TTL_MS,
} from "../console-mcp-oauth.ts";

const WRK = "wrk_default";
const MCP_URL = "https://mcp.example.test/mcp";
const CALLBACK_URL = "http://127.0.0.1:4180/console/mcp-oauth/callback";
const ACCESS = "oauth-access-secret";
const REFRESH = "oauth-refresh-secret";
const CLIENT_SECRET = "oauth-client-secret";

describe("ConsoleMcpOauthService", () => {
  let db: DatabaseSync;
  let store: SqliteVaultStore;
  let vaults: DefaultVaultService;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    store = new SqliteVaultStore(db, new SqliteSecretsStore(db, randomBytes(32)));
    vaults = new DefaultVaultService(store);
    vaults.createVault(WRK, { display_name: "Integrations" });
  });

  afterEach(() => db.close());

  it("discovers, registers, uses PKCE, and persists a refreshable credential without exposing tokens", async () => {
    const fixture = oauthFetch();
    const service = new ConsoleMcpOauthService(vaults, fixture.fetch);
    const vaultId = vaults.listVaults(WRK).data[0]!.id;

    const started = await service.startConnect(WRK, {
      vault_id: vaultId,
      display_name: "Notion",
      mcp_server_url: MCP_URL,
    }, CALLBACK_URL);
    const authorization = new URL(started.authorization_url);
    expect(authorization.origin).toBe("https://auth.example.test");
    expect(authorization.searchParams.get("state")).toMatch(/^oauth_state_/);
    expect(authorization.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("resource")).toBe("https://mcp.example.test/mcp");
    expect(service.status(WRK, started.flow_id).status).toBe("pending");

    const state = authorization.searchParams.get("state")!;
    await service.complete(state, "authorization-code-secret");
    const status = service.status(WRK, started.flow_id);
    expect(status).toMatchObject({ status: "connected", refreshable: true });
    expect(JSON.stringify({ started, status })).not.toContain(ACCESS);
    expect(JSON.stringify({ started, status })).not.toContain(REFRESH);
    expect(JSON.stringify({ started, status })).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify({ started, status })).not.toContain("authorization-code-secret");

    const credential = vaults.retrieveCredential(WRK, vaultId, status.credential_id!);
    expect(credential).toMatchObject({
      display_name: "Notion",
      auth: {
        type: "mcp_oauth",
        mcp_server_url: MCP_URL,
        refresh: {
          token_endpoint: "https://auth.example.test/token",
          client_id: "oma-dynamic-client",
          scope: "workspace.read workspace.write",
          token_endpoint_auth: { type: "client_secret_basic" },
        },
      },
    });
    expect(store.resolveCredential(WRK, [vaultId], MCP_URL)?.token).toBe(ACCESS);
    expect(store.readOauthRefreshState(WRK, vaultId, credential.id)?.secrets).toEqual({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      clientSecret: CLIENT_SECRET,
    });
    expect(fixture.registrationCalls).toBe(1);
    expect(fixture.tokenCalls).toBe(1);
    expect(fixture.tokenBodies[0]).toContain("code_verifier=");
    expect(fixture.tokenBodies[0]).toContain("resource=https%3A%2F%2Fmcp.example.test%2Fmcp");
    await expect(service.complete(state, "replay-code")).rejects.toThrow(/already used/);
    expect(fixture.tokenCalls).toBe(1);
  });

  it("reauthorizes by rotating the existing credential without dynamic registration or duplication", async () => {
    const fixture = oauthFetch();
    const service = new ConsoleMcpOauthService(vaults, fixture.fetch);
    const vaultId = vaults.listVaults(WRK).data[0]!.id;
    const first = await service.startConnect(WRK, {
      vault_id: vaultId,
      mcp_server_url: MCP_URL,
    }, CALLBACK_URL);
    await service.complete(new URL(first.authorization_url).searchParams.get("state")!, "first-code");
    const credentialId = service.status(WRK, first.flow_id).credential_id!;

    fixture.accessToken = "rotated-access-token";
    fixture.refreshToken = "rotated-refresh-token";
    const second = await service.startReauthorize(WRK, {
      vault_id: vaultId,
      credential_id: credentialId,
    }, CALLBACK_URL);
    await service.complete(new URL(second.authorization_url).searchParams.get("state")!, "second-code");

    expect(service.status(WRK, second.flow_id)).toMatchObject({
      status: "connected",
      credential_id: credentialId,
    });
    expect(vaults.listCredentials(WRK, vaultId).data).toHaveLength(1);
    expect(store.resolveCredential(WRK, [vaultId], MCP_URL)?.token).toBe("rotated-access-token");
    expect(fixture.registrationCalls).toBe(1);
  });

  it("expires flow state at ten minutes and isolates status by workspace", async () => {
    let now = new Date("2026-07-23T10:00:00.000Z");
    const fixture = oauthFetch();
    const service = new ConsoleMcpOauthService(vaults, fixture.fetch, { now: () => now });
    const vaultId = vaults.listVaults(WRK).data[0]!.id;
    const started = await service.startConnect(WRK, {
      vault_id: vaultId,
      mcp_server_url: MCP_URL,
    }, CALLBACK_URL);
    expect(() => service.status("wrk_other", started.flow_id)).toThrow(/not found/);

    now = new Date(now.getTime() + CONSOLE_MCP_OAUTH_FLOW_TTL_MS);
    expect(service.status(WRK, started.flow_id)).toMatchObject({
      status: "expired",
      error: { code: "callback_expired" },
    });
    await expect(
      service.complete(new URL(started.authorization_url).searchParams.get("state")!, "late-code"),
    ).rejects.toThrow(/already used/);
    expect(fixture.tokenCalls).toBe(0);
  });

  it("reports automatic registration as unsupported when the provider omits it", async () => {
    const fixture = oauthFetch({ registration: false });
    const service = new ConsoleMcpOauthService(vaults, fixture.fetch);
    const vaultId = vaults.listVaults(WRK).data[0]!.id;
    await expect(service.startConnect(WRK, {
      vault_id: vaultId,
      mcp_server_url: MCP_URL,
    }, CALLBACK_URL)).rejects.toThrow(/does not support automatic client registration/);
    expect(fixture.tokenCalls).toBe(0);
  });

  it("rejects oversized discovery responses before buffering them", async () => {
    const fixture = oauthFetch();
    const service = new ConsoleMcpOauthService(vaults, fixture.fetch, {
      maxBodyBytes: 32,
    });
    const vaultId = vaults.listVaults(WRK).data[0]!.id;

    await expect(service.startConnect(WRK, {
      vault_id: vaultId,
      mcp_server_url: MCP_URL,
    }, CALLBACK_URL)).rejects.toThrow(/could not safely reach/);
    expect(fixture.registrationCalls).toBe(0);
    expect(fixture.tokenCalls).toBe(0);
  });

  it("reports provider denial and token-exchange failure as terminal, token-free states", async () => {
    const deniedFixture = oauthFetch();
    const deniedService = new ConsoleMcpOauthService(vaults, deniedFixture.fetch);
    const vaultId = vaults.listVaults(WRK).data[0]!.id;
    const denied = await deniedService.startConnect(WRK, {
      vault_id: vaultId,
      mcp_server_url: MCP_URL,
    }, CALLBACK_URL);
    const deniedResult = deniedService.deny(
      new URL(denied.authorization_url).searchParams.get("state")!,
    );
    expect(deniedResult).toEqual({ flowId: denied.flow_id, ok: false });
    expect(deniedService.status(WRK, denied.flow_id)).toMatchObject({
      status: "failed",
      error: { code: "authorization_denied" },
    });

    const failedFixture = oauthFetch({ tokenStatus: 400 });
    const failedService = new ConsoleMcpOauthService(vaults, failedFixture.fetch);
    const failed = await failedService.startConnect(WRK, {
      vault_id: vaultId,
      mcp_server_url: MCP_URL,
    }, CALLBACK_URL);
    const failedResult = await failedService.complete(
      new URL(failed.authorization_url).searchParams.get("state")!,
      "rejected-code",
    );
    expect(failedResult).toEqual({ flowId: failed.flow_id, ok: false });
    const failedStatus = failedService.status(WRK, failed.flow_id);
    expect(failedStatus).toMatchObject({
      status: "failed",
      error: { code: "token_exchange_failed" },
    });
    expect(JSON.stringify(failedStatus)).not.toContain("rejected-code");
  });
});

function oauthFetch(opts: { registration?: boolean; tokenStatus?: number } = {}) {
  let registrationCalls = 0;
  let tokenCalls = 0;
  const tokenBodies: string[] = [];
  const state = {
    accessToken: ACCESS,
    refreshToken: REFRESH,
    get registrationCalls() { return registrationCalls; },
    get tokenCalls() { return tokenCalls; },
    tokenBodies,
    fetch: (async (input, init) => {
      const url = new URL(input);
      if (url.hostname === "mcp.example.test" && url.pathname.includes(".well-known/oauth-protected-resource")) {
        return json({
          resource: MCP_URL,
          authorization_servers: ["https://auth.example.test"],
          scopes_supported: ["workspace.read", "workspace.write"],
        });
      }
      if (url.href === "https://auth.example.test/.well-known/oauth-authorization-server") {
        return json({
          issuer: "https://auth.example.test",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          ...(opts.registration === false ? {} : { registration_endpoint: "https://auth.example.test/register" }),
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.href === "https://auth.example.test/register") {
        registrationCalls += 1;
        return json({
          client_id: "oma-dynamic-client",
          client_secret: CLIENT_SECRET,
          redirect_uris: [CALLBACK_URL],
          client_name: "Open Managed Agents",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_basic",
        });
      }
      if (url.href === "https://auth.example.test/token") {
        tokenCalls += 1;
        tokenBodies.push(String(init?.body));
        if (opts.tokenStatus !== undefined) {
          return json({ error:"invalid_grant" }, opts.tokenStatus);
        }
        return json({
          access_token: state.accessToken,
          refresh_token: state.refreshToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "workspace.read workspace.write",
        });
      }
      return new Response("not found", { status: 404 });
    }) as McpFetch,
  };
  return state;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
