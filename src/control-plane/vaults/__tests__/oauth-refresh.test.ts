import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSecretsStore } from "../../secrets/store.ts";
import { RefreshCoordinator, nextRefreshAt } from "../oauth-refresh.ts";
import { SqliteVaultStore } from "../store.ts";
import type { VaultCredentialRow, VaultRow } from "../types.ts";

const WRK = "wrk_default";
const VAULT = "vlt_oauth";
const CREDENTIAL = "vcrd_oauth";
const MCP_URL = "https://mcp.example.com/mcp";
const TOKEN_ENDPOINT = "https://oauth.example.com/token";
const NOW = new Date("2026-07-09T12:00:00.000Z");

describe("RefreshCoordinator", () => {
  let db: DatabaseSync;
  let secrets: SqliteSecretsStore;
  let store: SqliteVaultStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    secrets = new SqliteSecretsStore(db, randomBytes(32));
    store = new SqliteVaultStore(db, secrets);
    createVault(store, VAULT);
  });

  afterEach(() => {
    db.close();
  });

  it("refreshes client_secret_post credentials and persists rotated tokens", async () => {
    createOauthCredential(store, "client_secret_post");
    const fetch = tokenEndpointFixture({
      response: {
        access_token: "NEXT_ACCESS",
        refresh_token: "NEXT_REFRESH",
        expires_in: 600,
        scope: "read",
        token_type: "Bearer",
      },
    });
    const coordinator = new RefreshCoordinator({ store, fetch, now: () => NOW });

    const result = await coordinator.refreshCredential({
      workspaceId: WRK,
      vaultId: VAULT,
      credentialId: CREDENTIAL,
    });

    expect(result).toMatchObject({ outcome: "ok", persisted: "updated" });
    expect(result).toMatchObject({
      state: {
        hasAccessToken: true,
        hasRefreshToken: true,
        hasClientSecret: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("NEXT_REFRESH");
    expect(JSON.stringify(result)).not.toContain("CLIENT_SECRET");
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toMatchObject({
      url: TOKEN_ENDPOINT,
      method: "POST",
      authorization: null,
    });
    expect(fetch.calls[0]?.body.get("grant_type")).toBe("refresh_token");
    expect(fetch.calls[0]?.body.get("refresh_token")).toBe("REFRESH_TOKEN");
    expect(fetch.calls[0]?.body.get("client_id")).toBe("client-id");
    expect(fetch.calls[0]?.body.get("client_secret")).toBe("CLIENT_SECRET");
    expect(fetch.calls[0]?.body.get("scope")).toBe("read write");
    expect(store.readOauthRefreshState(WRK, VAULT, CREDENTIAL)).toMatchObject({
      authVersion: 2,
      expiresAt: "2026-07-09T12:10:00.000Z",
      refresh: { scope: "read" },
      refreshStatus: "ok",
      refreshAttempts: 0,
      nextRefreshAt: "2026-07-09T12:05:00.000Z",
      secrets: {
        accessToken: "NEXT_ACCESS",
        refreshToken: "NEXT_REFRESH",
        clientSecret: "CLIENT_SECRET",
      },
    });
  });

  it("uses only Basic auth for client_secret_basic credentials", async () => {
    createOauthCredential(store, "client_secret_basic", {
      clientId: "client id",
      clientSecret: "secret/value",
    });
    const fetch = tokenEndpointFixture({ response: { access_token: "NEXT" } });
    const coordinator = new RefreshCoordinator({ store, fetch, now: () => NOW });

    await coordinator.refreshCredential({
      workspaceId: WRK,
      vaultId: VAULT,
      credentialId: CREDENTIAL,
    });

    expect(fetch.calls[0]?.body.get("client_id")).toBeNull();
    expect(fetch.calls[0]?.body.get("client_secret")).toBeNull();
    expect(fetch.calls[0]?.authorization).toBe(
      `Basic ${Buffer.from("client+id:secret%2Fvalue").toString("base64")}`,
    );
  });

  it("uses body client_id without client_secret for none auth", async () => {
    createOauthCredential(store, "none", { clientSecret: undefined });
    const fetch = tokenEndpointFixture({ response: { access_token: "NEXT" } });
    const coordinator = new RefreshCoordinator({ store, fetch, now: () => NOW });

    await coordinator.refreshCredential({
      workspaceId: WRK,
      vaultId: VAULT,
      credentialId: CREDENTIAL,
    });

    expect(fetch.calls[0]?.body.get("client_id")).toBe("client-id");
    expect(fetch.calls[0]?.body.get("client_secret")).toBeNull();
    expect(fetch.calls[0]?.authorization).toBeNull();
  });

  it("single-flights concurrent refreshes for the same credential", async () => {
    createOauthCredential(store, "client_secret_post");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = tokenEndpointFixture({
      beforeResponse: () => gate,
      response: { access_token: "NEXT_ACCESS", refresh_token: "NEXT_REFRESH" },
    });
    const coordinator = new RefreshCoordinator({ store, fetch, now: () => NOW });

    const first = coordinator.refreshCredential({
      workspaceId: WRK,
      vaultId: VAULT,
      credentialId: CREDENTIAL,
    });
    const second = coordinator.refreshCredential({
      workspaceId: WRK,
      vaultId: VAULT,
      credentialId: CREDENTIAL,
    });
    release();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { outcome: "ok" },
      { outcome: "ok" },
    ]);
    expect(fetch.calls).toHaveLength(1);
  });

  it("classifies Slack-style 200 ok:false errors as permanent invalid", async () => {
    createOauthCredential(store, "client_secret_post");
    const fetch = tokenEndpointFixture({
      response: { ok: false, error: "invalid_refresh_token" },
    });
    const coordinator = new RefreshCoordinator({ store, fetch, now: () => NOW });

    const result = await coordinator.refreshCredential({
      workspaceId: WRK,
      vaultId: VAULT,
      credentialId: CREDENTIAL,
    });

    expect(result).toMatchObject({
      outcome: "invalid",
      reason: "invalid_refresh_token",
      persisted: "updated",
    });
    await expect(
      coordinator.refreshCredential({
        workspaceId: WRK,
        vaultId: VAULT,
        credentialId: CREDENTIAL,
      }),
    ).resolves.toMatchObject({
      outcome: "skipped",
      reason: "invalid_status",
      state: { refreshStatus: "invalid" },
    });
    await expect(
      coordinator.refreshCredential({
        workspaceId: WRK,
        vaultId: VAULT,
        credentialId: CREDENTIAL,
        force: true,
      }),
    ).resolves.toMatchObject({ outcome: "invalid" });
    expect(store.readOauthRefreshState(WRK, VAULT, CREDENTIAL)).toMatchObject({
      authVersion: 1,
      refreshStatus: "invalid",
      refreshAttempts: 2,
      nextRefreshAt: null,
      secrets: { accessToken: "ACCESS_TOKEN", refreshToken: "REFRESH_TOKEN" },
    });
    expect(fetch.calls).toHaveLength(2);
  });

  it("persists transient retry-after failures without bumping auth_version", async () => {
    createOauthCredential(store, "client_secret_post");
    const fetch = tokenEndpointFixture({
      status: 429,
      headers: { "retry-after": "120" },
      response: { error: "temporarily_unavailable" },
    });
    const coordinator = new RefreshCoordinator({
      store,
      fetch,
      now: () => NOW,
      random: () => 0,
    });

    const result = await coordinator.refreshCredential({
      workspaceId: WRK,
      vaultId: VAULT,
      credentialId: CREDENTIAL,
    });

    expect(result).toMatchObject({
      outcome: "transient_error",
      reason: "temporarily_unavailable",
    });
    expect(store.readOauthRefreshState(WRK, VAULT, CREDENTIAL)).toMatchObject({
      authVersion: 1,
      refreshStatus: "transient",
      refreshAttempts: 1,
      nextRefreshAt: "2026-07-09T12:02:00.000Z",
    });
  });

  it("returns a stale result and keeps operator tokens when CAS loses to rotation", async () => {
    createOauthCredential(store, "client_secret_post");
    const fetch = tokenEndpointFixture({
      beforeResponse: () => {
        store.updateCredential(
          WRK,
          VAULT,
          CREDENTIAL,
          {
            auth: {
              type: "mcp_oauth",
              accessToken: "OPERATOR_ACCESS",
              refreshToken: "OPERATOR_REFRESH",
            },
          },
          "2026-07-09T12:00:01.000Z",
        );
      },
      response: { access_token: "STALE_ACCESS", refresh_token: "STALE_REFRESH" },
    });
    const coordinator = new RefreshCoordinator({ store, fetch, now: () => NOW });

    const result = await coordinator.refreshCredential({
      workspaceId: WRK,
      vaultId: VAULT,
      credentialId: CREDENTIAL,
    });

    expect(result).toMatchObject({
      outcome: "ok",
      persisted: "stale",
      state: { hasAccessToken: true, hasRefreshToken: true },
    });
    expect(JSON.stringify(result)).not.toContain("OPERATOR_REFRESH");
    expect(store.readOauthRefreshState(WRK, VAULT, CREDENTIAL)).toMatchObject({
      authVersion: 2,
      secrets: { refreshToken: "OPERATOR_REFRESH" },
    });
  });

  it("does not persist a stale invalid_grant after operator rotation", async () => {
    createOauthCredential(store, "client_secret_post");
    const fetch = tokenEndpointFixture({
      beforeResponse: () => {
        store.updateCredential(
          WRK,
          VAULT,
          CREDENTIAL,
          {
            auth: {
              type: "mcp_oauth",
              accessToken: "OPERATOR_ACCESS",
              refreshToken: "OPERATOR_REFRESH",
            },
          },
          "2026-07-09T12:00:01.000Z",
        );
      },
      status: 400,
      response: { error: "invalid_grant" },
    });
    const coordinator = new RefreshCoordinator({ store, fetch, now: () => NOW });

    const result = await coordinator.refreshCredential({
      workspaceId: WRK,
      vaultId: VAULT,
      credentialId: CREDENTIAL,
    });

    expect(result).toMatchObject({
      outcome: "invalid",
      persisted: "stale",
      state: { authVersion: 2, refreshStatus: null },
    });
    expect(store.readOauthRefreshState(WRK, VAULT, CREDENTIAL)).toMatchObject({
      authVersion: 2,
      refreshStatus: null,
      secrets: { accessToken: "OPERATOR_ACCESS", refreshToken: "OPERATOR_REFRESH" },
    });
  });

  it("clears stale expires_at when refresh omits expires_in", async () => {
    createOauthCredential(store, "client_secret_post");
    const fetch = tokenEndpointFixture({
      response: { access_token: "LONG_LIVED_ACCESS" },
    });
    const coordinator = new RefreshCoordinator({ store, fetch, now: () => NOW });

    const result = await coordinator.refreshCredential({
      workspaceId: WRK,
      vaultId: VAULT,
      credentialId: CREDENTIAL,
    });

    expect(result).toMatchObject({
      outcome: "ok",
      state: { nextRefreshAt: "2026-07-09T12:15:00.000Z" },
    });
    if (result.outcome === "ok") expect("expiresAt" in result.state).toBe(false);
    const state = store.readOauthRefreshState(WRK, VAULT, CREDENTIAL);
    expect(state).toMatchObject({
      nextRefreshAt: "2026-07-09T12:15:00.000Z",
      secrets: { accessToken: "LONG_LIVED_ACCESS", refreshToken: "REFRESH_TOKEN" },
    });
    expect("expiresAt" in state!).toBe(false);
  });

  it("uses a distinct redirect reason for token endpoint redirect failures", async () => {
    createOauthCredential(store, "client_secret_post");
    const coordinator = new RefreshCoordinator({
      store,
      fetch: async () => {
        throw new TypeError("fetch failed", {
          cause: new Error("unexpected redirect"),
        });
      },
      now: () => NOW,
      random: () => 0,
    });

    await expect(
      coordinator.refreshCredential({
        workspaceId: WRK,
        vaultId: VAULT,
        credentialId: CREDENTIAL,
      }),
    ).resolves.toMatchObject({
      outcome: "transient_error",
      reason: "redirect_blocked",
      state: { refreshStatus: "transient" },
    });
  });

  it("rejects unexpected token_type as permanent invalid", async () => {
    createOauthCredential(store, "client_secret_post");
    const fetch = tokenEndpointFixture({
      response: { access_token: "NEXT_ACCESS", token_type: "mac" },
    });
    const coordinator = new RefreshCoordinator({ store, fetch, now: () => NOW });

    await expect(
      coordinator.refreshCredential({
        workspaceId: WRK,
        vaultId: VAULT,
        credentialId: CREDENTIAL,
      }),
    ).resolves.toMatchObject({
      outcome: "invalid",
      reason: "unsupported_token_type",
    });
  });

  it("reports static bearer credentials distinctly from missing credentials", async () => {
    store.createCredential({
      row: {
        id: CREDENTIAL,
        workspace_id: WRK,
        vault_id: VAULT,
        type: "vault_credential",
        display_name: null,
        metadata: {},
        auth: { type: "static_bearer", mcp_server_url: MCP_URL },
        auth_version: 1,
        created_at: "2026-07-09T00:00:00.000Z",
        updated_at: "2026-07-09T00:00:00.000Z",
        archived_at: null,
      },
      token: "STATIC_TOKEN",
    });
    const coordinator = new RefreshCoordinator({
      store,
      fetch: tokenEndpointFixture({ response: { access_token: "unused" } }),
      now: () => NOW,
    });

    await expect(
      coordinator.refreshCredential({
        workspaceId: WRK,
        vaultId: VAULT,
        credentialId: CREDENTIAL,
      }),
    ).resolves.toMatchObject({
      outcome: "skipped",
      reason: "unsupported_credential_type",
    });
  });

  it("honors the short-token half-life floor", () => {
    expect(
      nextRefreshAt(NOW, new Date(NOW.getTime() + 120_000)).toISOString(),
    ).toBe("2026-07-09T12:01:00.000Z");
    expect(
      nextRefreshAt(NOW, new Date(NOW.getTime() + 10_000)).toISOString(),
    ).toBe("2026-07-09T12:00:30.000Z");
  });

  it("caps oversized token endpoint responses", async () => {
    createOauthCredential(store, "client_secret_post");
    const fetch = tokenEndpointFixture({
      rawBody: JSON.stringify({ access_token: "x".repeat(128) }),
    });
    const coordinator = new RefreshCoordinator({
      store,
      fetch,
      now: () => NOW,
      maxBodyBytes: 8,
    });

    await expect(
      coordinator.refreshCredential({
        workspaceId: WRK,
        vaultId: VAULT,
        credentialId: CREDENTIAL,
      }),
    ).resolves.toMatchObject({
      outcome: "transient_error",
      reason: "response_body_too_large",
    });
  });
});

interface TokenEndpointCall {
  url: string;
  method: string | undefined;
  body: URLSearchParams;
  authorization: string | null;
}

function tokenEndpointFixture(opts: {
  status?: number;
  response?: Record<string, unknown>;
  rawBody?: string;
  headers?: Record<string, string>;
  beforeResponse?: () => void | Promise<void>;
}): ((input: string | URL, init?: RequestInit) => Promise<Response>) & {
  calls: TokenEndpointCall[];
} {
  const calls: TokenEndpointCall[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const body = init?.body instanceof URLSearchParams
      ? init.body
      : new URLSearchParams(String(init?.body ?? ""));
    calls.push({
      url: String(input),
      method: init?.method,
      body,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    await opts.beforeResponse?.();
    return new Response(opts.rawBody ?? JSON.stringify(opts.response ?? {}), {
      status: opts.status ?? 200,
      headers: {
        "content-type": "application/json",
        ...(opts.headers ?? {}),
      },
    });
  }) as ((input: string | URL, init?: RequestInit) => Promise<Response>) & {
    calls: TokenEndpointCall[];
  };
  fn.calls = calls;
  return fn;
}

function createVault(store: SqliteVaultStore, id: string): VaultRow {
  return store.createVault({
    row: {
      id,
      workspace_id: WRK,
      type: "vault",
      display_name: id,
      metadata: {},
      created_at: "2026-07-09T00:00:00.000Z",
      updated_at: "2026-07-09T00:00:00.000Z",
      archived_at: null,
    },
  });
}

function createOauthCredential(
  store: SqliteVaultStore,
  authType: "none" | "client_secret_basic" | "client_secret_post",
  opts: {
    clientId?: string;
    clientSecret?: string;
  } = {},
): VaultCredentialRow {
  return store.createCredential({
    row: {
      id: CREDENTIAL,
      workspace_id: WRK,
      vault_id: VAULT,
      type: "vault_credential",
      display_name: null,
      metadata: {},
      auth: {
        type: "mcp_oauth",
        mcp_server_url: MCP_URL,
        expires_at: "2026-07-09T12:01:00.000Z",
        refresh: {
          token_endpoint: TOKEN_ENDPOINT,
          client_id: opts.clientId ?? "client-id",
          scope: "read write",
          token_endpoint_auth: { type: authType },
        },
      },
      auth_version: 1,
      created_at: "2026-07-09T00:00:00.000Z",
      updated_at: "2026-07-09T00:00:00.000Z",
      archived_at: null,
    },
    token: JSON.stringify({
      access_token: "ACCESS_TOKEN",
      refresh_token: "REFRESH_TOKEN",
      ...(opts.clientSecret === undefined && authType === "none"
        ? {}
        : { client_secret: opts.clientSecret ?? "CLIENT_SECRET" }),
    }),
  });
}
