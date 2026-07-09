import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteSecretsStore } from "../../secrets/store.ts";
import { SqliteVaultStore, vaultSecretName } from "../store.ts";
import type { VaultCredentialRow, VaultRow } from "../types.ts";

const WRK = "wrk_default";
const URL = "https://mcp.example.com/mcp";

describe("SqliteVaultStore", () => {
  let db: DatabaseSync;
  let master: Buffer;
  let secrets: SqliteSecretsStore;
  let store: SqliteVaultStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    master = randomBytes(32);
    secrets = new SqliteSecretsStore(db, master);
    store = new SqliteVaultStore(db, secrets);
  });

  afterEach(() => {
    db.close();
  });

  it("resolves the first matching active credential by vault order and exact URL", () => {
    createVault(store, "vlt_first");
    createVault(store, "vlt_second");
    createCredential(store, "vlt_first", "vcrd_first", URL, "FIRST_TOKEN");
    createCredential(store, "vlt_second", "vcrd_second", URL, "SECOND_TOKEN");

    expect(store.resolveCredential(WRK, ["vlt_second", "vlt_first"], URL)).toEqual({
      credentialId: "vcrd_second",
      updatedAt: "2026-07-08T00:00:00.000Z",
      token: "SECOND_TOKEN",
    });
    expect(
      store.resolveCredential(WRK, ["vlt_second", "vlt_first"], `${URL}/`),
    ).toBeUndefined();
  });

  it("skips archived credentials and then resolves a later vault", () => {
    createVault(store, "vlt_first");
    createVault(store, "vlt_second");
    createCredential(store, "vlt_first", "vcrd_first", URL, "FIRST_TOKEN");
    createCredential(store, "vlt_second", "vcrd_second", URL, "SECOND_TOKEN");

    store.archiveCredential(
      WRK,
      "vlt_second",
      "vcrd_second",
      "2026-07-08T00:00:02.000Z",
    );

    expect(store.resolveCredential(WRK, ["vlt_second", "vlt_first"], URL)).toEqual({
      credentialId: "vcrd_first",
      updatedAt: "2026-07-08T00:00:00.000Z",
      token: "FIRST_TOKEN",
    });
  });

  it("rolls back the secret write if credential metadata insert fails", () => {
    createVault(store, "vlt_first");
    createCredential(store, "vlt_first", "vcrd_same", URL, "ORIGINAL_TOKEN");

    expect(() =>
      createCredential(
        store,
        "vlt_first",
        "vcrd_same",
        "https://mcp.example.com/other",
        "REPLACEMENT_TOKEN",
      ),
    ).toThrow();
    expect(secrets.reveal(WRK, vaultSecretName("vlt_first", "vcrd_same"))).toBe(
      "ORIGINAL_TOKEN",
    );
  });

  it("master-key rotation rewraps vault-backed tokens", () => {
    createVault(store, "vlt_first");
    createCredential(store, "vlt_first", "vcrd_first", URL, "ROTATED_TOKEN");

    const next = randomBytes(32);
    expect(secrets.rotateMasterKey(next)).toBe(1);
    const reopenedSecrets = new SqliteSecretsStore(db, next);
    const reopenedVaults = new SqliteVaultStore(db, reopenedSecrets);

    expect(reopenedVaults.resolveCredential(WRK, ["vlt_first"], URL)).toEqual({
      credentialId: "vcrd_first",
      updatedAt: "2026-07-08T00:00:00.000Z",
      token: "ROTATED_TOKEN",
    });
  });

  it("master-key rotation rewraps mcp_oauth JSON secret rows", () => {
    createVault(store, "vlt_first");
    createOauthCredential(store, "vlt_first", "vcrd_oauth", URL, {
      accessToken: "ACCESS_TOKEN",
      refreshToken: "REFRESH_TOKEN",
      clientSecret: "CLIENT_SECRET",
    });

    const next = randomBytes(32);
    expect(secrets.rotateMasterKey(next)).toBe(1);
    const reopenedSecrets = new SqliteSecretsStore(db, next);
    const reopenedVaults = new SqliteVaultStore(db, reopenedSecrets);

    expect(reopenedVaults.readOauthRefreshState(WRK, "vlt_first", "vcrd_oauth")).toMatchObject({
      secrets: {
        accessToken: "ACCESS_TOKEN",
        refreshToken: "REFRESH_TOKEN",
        clientSecret: "CLIENT_SECRET",
      },
    });
    expect(reopenedVaults.resolveCredential(WRK, ["vlt_first"], URL)?.token).toBe(
      "ACCESS_TOKEN",
    );
  });

  it("stores mcp_oauth secrets as JSON and resolves only the access token", () => {
    createVault(store, "vlt_first");
    createOauthCredential(store, "vlt_first", "vcrd_oauth", URL, {
      accessToken: "ACCESS_TOKEN",
      refreshToken: "REFRESH_TOKEN",
      clientSecret: "CLIENT_SECRET",
    });

    expect(store.retrieveCredential(WRK, "vlt_first", "vcrd_oauth")).toMatchObject({
      auth: {
        type: "mcp_oauth",
        mcp_server_url: URL,
        expires_at: "2099-12-31T23:59:59Z",
        refresh: {
          token_endpoint: "https://oauth.example.com/token",
          client_id: "client-id",
          scope: "read write",
          token_endpoint_auth: { type: "client_secret_post" },
        },
      },
      auth_version: 1,
    });
    expect(JSON.parse(secrets.reveal(WRK, vaultSecretName("vlt_first", "vcrd_oauth")) ?? "{}")).toEqual({
      access_token: "ACCESS_TOKEN",
      refresh_token: "REFRESH_TOKEN",
      client_secret: "CLIENT_SECRET",
    });
    expect(store.resolveCredential(WRK, ["vlt_first"], URL)).toEqual({
      credentialId: "vcrd_oauth",
      updatedAt: "2026-07-08T00:00:00.000Z",
      token: "ACCESS_TOKEN",
    });
  });

  it("degrades malformed mcp_oauth JSON secrets to missing credentials", () => {
    createVault(store, "vlt_first");
    createOauthCredential(store, "vlt_first", "vcrd_oauth", URL, {
      accessToken: "ACCESS_TOKEN",
      refreshToken: "REFRESH_TOKEN",
      clientSecret: "CLIENT_SECRET",
    });
    secrets.put(WRK, vaultSecretName("vlt_first", "vcrd_oauth"), "{not json");

    expect(store.resolveCredential(WRK, ["vlt_first"], URL)).toBeUndefined();
    expect(store.readOauthRefreshState(WRK, "vlt_first", "vcrd_oauth")).toMatchObject({
      secrets: {},
    });
  });

  it("merges mcp_oauth secret rotation without dropping client_secret", () => {
    createVault(store, "vlt_first");
    createOauthCredential(store, "vlt_first", "vcrd_oauth", URL, {
      accessToken: "ACCESS_TOKEN",
      refreshToken: "REFRESH_TOKEN",
      clientSecret: "CLIENT_SECRET",
    });

    const updated = store.updateCredential(
      WRK,
      "vlt_first",
      "vcrd_oauth",
      {
        auth: {
          type: "mcp_oauth",
          accessToken: "NEXT_ACCESS",
          refreshToken: "NEXT_REFRESH",
          expiresAt: "2099-12-31T23:59:59Z",
        },
      },
      "2026-07-08T00:00:01.000Z",
    );

    expect(updated).toMatchObject({
      auth_version: 2,
      auth: { type: "mcp_oauth", expires_at: "2099-12-31T23:59:59Z" },
    });
    expect(JSON.parse(secrets.reveal(WRK, vaultSecretName("vlt_first", "vcrd_oauth")) ?? "{}")).toEqual({
      access_token: "NEXT_ACCESS",
      refresh_token: "NEXT_REFRESH",
      client_secret: "CLIENT_SECRET",
    });
    expect(store.resolveCredential(WRK, ["vlt_first"], URL)?.token).toBe(
      "NEXT_ACCESS",
    );
  });

  it("persists oauth refresh success with an auth_version CAS fence", () => {
    createVault(store, "vlt_first");
    createOauthCredential(store, "vlt_first", "vcrd_oauth", URL, {
      accessToken: "ACCESS_TOKEN",
      refreshToken: "REFRESH_TOKEN",
      clientSecret: "CLIENT_SECRET",
    });
    const state = store.readOauthRefreshState(WRK, "vlt_first", "vcrd_oauth");

    const result = store.persistOauthRefreshSuccess({
      workspaceId: WRK,
      vaultId: "vlt_first",
      credentialId: "vcrd_oauth",
      expectedAuthVersion: state!.authVersion,
      accessToken: "FRESH_ACCESS",
      refreshToken: "FRESH_REFRESH",
      expiresAt: "2099-12-31T23:59:59Z",
      scope: "read",
      nextRefreshAt: "2099-12-31T23:54:59.000Z",
      updatedAt: "2026-07-08T00:00:02.000Z",
    });

    expect(result.status).toBe("updated");
    expect(result.state).toMatchObject({
      authVersion: 2,
      expiresAt: "2099-12-31T23:59:59Z",
      refresh: { scope: "read" },
      refreshStatus: "ok",
      refreshAttempts: 0,
      nextRefreshAt: "2099-12-31T23:54:59.000Z",
      secrets: {
        accessToken: "FRESH_ACCESS",
        refreshToken: "FRESH_REFRESH",
        clientSecret: "CLIENT_SECRET",
      },
    });
    expect(JSON.parse(secrets.reveal(WRK, vaultSecretName("vlt_first", "vcrd_oauth")) ?? "{}")).toEqual({
      access_token: "FRESH_ACCESS",
      refresh_token: "FRESH_REFRESH",
      client_secret: "CLIENT_SECRET",
    });
  });

  it("does not discard a provider-rotated token for a cosmetic metadata race", () => {
    createVault(store, "vlt_first");
    createOauthCredential(store, "vlt_first", "vcrd_oauth", URL, {
      accessToken: "ACCESS_TOKEN",
      refreshToken: "REFRESH_TOKEN",
      clientSecret: "CLIENT_SECRET",
    });
    const state = store.readOauthRefreshState(WRK, "vlt_first", "vcrd_oauth")!;

    store.updateCredential(
      WRK,
      "vlt_first",
      "vcrd_oauth",
      { metadata: { owner: "ops" } },
      "2026-07-08T00:00:01.000Z",
    );
    const result = store.persistOauthRefreshSuccess({
      workspaceId: WRK,
      vaultId: "vlt_first",
      credentialId: "vcrd_oauth",
      expectedAuthVersion: state.authVersion,
      accessToken: "FRESH_ACCESS",
      refreshToken: "FRESH_REFRESH",
      updatedAt: "2026-07-08T00:00:02.000Z",
    });

    expect(result.status).toBe("updated");
    expect(store.readOauthRefreshState(WRK, "vlt_first", "vcrd_oauth")).toMatchObject({
      authVersion: 2,
      secrets: { accessToken: "FRESH_ACCESS", refreshToken: "FRESH_REFRESH" },
    });
  });

  it("discards stale oauth refresh writes after operator auth rotation", () => {
    createVault(store, "vlt_first");
    createOauthCredential(store, "vlt_first", "vcrd_oauth", URL, {
      accessToken: "ACCESS_TOKEN",
      refreshToken: "REFRESH_TOKEN",
      clientSecret: "CLIENT_SECRET",
    });
    const staleState = store.readOauthRefreshState(WRK, "vlt_first", "vcrd_oauth")!;
    store.updateCredential(
      WRK,
      "vlt_first",
      "vcrd_oauth",
      {
        auth: {
          type: "mcp_oauth",
          accessToken: "OPERATOR_ACCESS",
          refreshToken: "OPERATOR_REFRESH",
        },
      },
      "2026-07-08T00:00:01.000Z",
    );

    const result = store.persistOauthRefreshSuccess({
      workspaceId: WRK,
      vaultId: "vlt_first",
      credentialId: "vcrd_oauth",
      expectedAuthVersion: staleState.authVersion,
      accessToken: "STALE_ACCESS",
      refreshToken: "STALE_REFRESH",
      updatedAt: "2026-07-08T00:00:02.000Z",
    });

    expect(result.status).toBe("stale");
    expect(result.state).toMatchObject({
      authVersion: 2,
      secrets: { accessToken: "OPERATOR_ACCESS", refreshToken: "OPERATOR_REFRESH" },
    });
    expect(secrets.reveal(WRK, vaultSecretName("vlt_first", "vcrd_oauth"))).toContain(
      "OPERATOR_REFRESH",
    );
    expect(secrets.reveal(WRK, vaultSecretName("vlt_first", "vcrd_oauth"))).not.toContain(
      "STALE_REFRESH",
    );
  });

  it("does not resurrect a purged oauth secret after archive wins the CAS race", () => {
    createVault(store, "vlt_first");
    createOauthCredential(store, "vlt_first", "vcrd_oauth", URL, {
      accessToken: "ACCESS_TOKEN",
      refreshToken: "REFRESH_TOKEN",
      clientSecret: "CLIENT_SECRET",
    });
    const staleState = store.readOauthRefreshState(WRK, "vlt_first", "vcrd_oauth")!;
    store.archiveCredential(
      WRK,
      "vlt_first",
      "vcrd_oauth",
      "2026-07-08T00:00:01.000Z",
    );

    const result = store.persistOauthRefreshSuccess({
      workspaceId: WRK,
      vaultId: "vlt_first",
      credentialId: "vcrd_oauth",
      expectedAuthVersion: staleState.authVersion,
      accessToken: "STALE_ACCESS",
      refreshToken: "STALE_REFRESH",
      updatedAt: "2026-07-08T00:00:02.000Z",
    });

    expect(result).toEqual({ status: "stale", state: undefined });
    expect(secrets.reveal(WRK, vaultSecretName("vlt_first", "vcrd_oauth"))).toBeUndefined();
  });

  it("does not orphan a secret after hard delete wins the CAS race", () => {
    createVault(store, "vlt_first");
    createOauthCredential(store, "vlt_first", "vcrd_oauth", URL, {
      accessToken: "ACCESS_TOKEN",
      refreshToken: "REFRESH_TOKEN",
      clientSecret: "CLIENT_SECRET",
    });
    const staleState = store.readOauthRefreshState(WRK, "vlt_first", "vcrd_oauth")!;
    store.deleteCredential(WRK, "vlt_first", "vcrd_oauth");

    const result = store.persistOauthRefreshSuccess({
      workspaceId: WRK,
      vaultId: "vlt_first",
      credentialId: "vcrd_oauth",
      expectedAuthVersion: staleState.authVersion,
      accessToken: "STALE_ACCESS",
      refreshToken: "STALE_REFRESH",
      updatedAt: "2026-07-08T00:00:02.000Z",
    });

    expect(result).toEqual({ status: "stale", state: undefined });
    expect(secrets.reveal(WRK, vaultSecretName("vlt_first", "vcrd_oauth"))).toBeUndefined();
  });

  it("migrates pre-M3 credential tables with refresh state columns", () => {
    const oldDb = new DatabaseSync(":memory:");
    const oldSecrets = new SqliteSecretsStore(oldDb, randomBytes(32));
    oldDb.exec(`
      CREATE TABLE vaults (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL,
        display_name TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, archived_at TEXT
      );
      CREATE TABLE vault_credentials (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, vault_id TEXT NOT NULL,
        type TEXT NOT NULL, display_name TEXT, metadata TEXT NOT NULL,
        auth_type TEXT NOT NULL, mcp_server_url TEXT NOT NULL,
        token_endpoint TEXT, client_id TEXT, scope TEXT, token_endpoint_auth_type TEXT,
        expires_at TEXT, auth_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
    `);
    const migrated = new SqliteVaultStore(oldDb, oldSecrets);
    migrated.createVault({
      row: {
        id: "vlt_migrated",
        workspace_id: WRK,
        type: "vault",
        display_name: "migrated",
        metadata: {},
        created_at: "2026-07-08T00:00:00.000Z",
        updated_at: "2026-07-08T00:00:00.000Z",
        archived_at: null,
      },
    });
    createOauthCredential(migrated, "vlt_migrated", "vcrd_migrated", URL, {
      accessToken: "ACCESS_TOKEN",
      refreshToken: "REFRESH_TOKEN",
      clientSecret: "CLIENT_SECRET",
    });

    expect(
      migrated.persistOauthRefreshFailure({
        workspaceId: WRK,
        vaultId: "vlt_migrated",
        credentialId: "vcrd_migrated",
        expectedAuthVersion: 1,
        status: "transient",
        refreshAttempts: 1,
        nextRefreshAt: "2026-07-08T00:01:00.000Z",
      }),
    ).toMatchObject({ status: "updated" });
    expect(
      migrated.readOauthRefreshState(WRK, "vlt_migrated", "vcrd_migrated"),
    ).toMatchObject({
      refreshStatus: "transient",
      refreshAttempts: 1,
      nextRefreshAt: "2026-07-08T00:01:00.000Z",
      authHintAt: null,
    });
    oldDb.close();
  });
});

function createVault(store: SqliteVaultStore, id: string): VaultRow {
  return store.createVault({
    row: {
      id,
      workspace_id: WRK,
      type: "vault",
      display_name: id,
      metadata: {},
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
      archived_at: null,
    },
  });
}

function createCredential(
  store: SqliteVaultStore,
  vaultId: string,
  id: string,
  url: string,
  token: string,
): VaultCredentialRow {
  return store.createCredential({
    row: {
      id,
      workspace_id: WRK,
      vault_id: vaultId,
      type: "vault_credential",
      display_name: null,
      metadata: {},
      auth: { type: "static_bearer", mcp_server_url: url },
      auth_version: 1,
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
      archived_at: null,
    },
    token,
  });
}

function createOauthCredential(
  store: SqliteVaultStore,
  vaultId: string,
  id: string,
  url: string,
  opts: {
    accessToken: string;
    refreshToken: string;
    clientSecret: string;
  },
): VaultCredentialRow {
  return store.createCredential({
    row: {
      id,
      workspace_id: WRK,
      vault_id: vaultId,
      type: "vault_credential",
      display_name: null,
      metadata: {},
      auth: {
        type: "mcp_oauth",
        mcp_server_url: url,
        expires_at: "2099-12-31T23:59:59Z",
        refresh: {
          token_endpoint: "https://oauth.example.com/token",
          client_id: "client-id",
          scope: "read write",
          token_endpoint_auth: { type: "client_secret_post" },
        },
      },
      auth_version: 1,
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
      archived_at: null,
    },
    token: JSON.stringify({
      access_token: opts.accessToken,
      refresh_token: opts.refreshToken,
      client_secret: opts.clientSecret,
    }),
  });
}
