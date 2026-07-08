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
      created_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
      archived_at: null,
    },
    token,
  });
}
