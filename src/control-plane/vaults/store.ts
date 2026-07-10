import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ManagedAgentsListPage } from "../../types/common.ts";
import { withSqliteTransaction } from "../sqlite-transaction.ts";
import type { SecretsStore } from "../secrets/types.ts";
import type { WorkspaceId } from "../workspace.ts";
import type {
  CreateVaultCredentialRecord,
  CreateVaultRecord,
  ListVaultCredentialsOptions,
  ListVaultsOptions,
  OauthRefreshDueCredential,
  PersistAuthHintInput,
  PersistAuthHintResult,
  PersistOauthRefreshFailureInput,
  PersistOauthRefreshResult,
  PersistOauthRefreshSuccessInput,
  VaultCredentialResolution,
  VaultCredentialRuntimeMetadata,
  VaultCredentialAuth,
  VaultCredentialAdminMetadata,
  VaultOauthRefreshState,
  VaultCredentialRow,
  VaultRow,
  VaultStore,
  ListVaultCredentialAdminMetadataOptions,
} from "./types.ts";

export const VAULT_SECRET_PREFIX = "vault/";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vaults (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  type          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  metadata      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  archived_at   TEXT
);
CREATE INDEX IF NOT EXISTS vaults_by_workspace
ON vaults (workspace_id, id);

CREATE TABLE IF NOT EXISTS vault_credentials (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  vault_id        TEXT NOT NULL,
  type            TEXT NOT NULL,
  display_name    TEXT,
  metadata        TEXT NOT NULL,
  auth_type       TEXT NOT NULL,
  mcp_server_url  TEXT NOT NULL,
  token_endpoint  TEXT,
  client_id       TEXT,
  scope           TEXT,
  token_endpoint_auth_type TEXT,
  expires_at      TEXT,
  auth_version    INTEGER NOT NULL DEFAULT 1,
  refresh_status  TEXT,
  refresh_attempts INTEGER NOT NULL DEFAULT 0,
  next_refresh_at TEXT,
  auth_hint_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  archived_at     TEXT
);
CREATE INDEX IF NOT EXISTS vault_credentials_by_vault
ON vault_credentials (workspace_id, vault_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS vault_credentials_active_server_url
ON vault_credentials (workspace_id, vault_id, mcp_server_url)
WHERE archived_at IS NULL;
`;

interface VaultDbRow {
  id: string;
  workspace_id: string;
  type: "vault";
  display_name: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface VaultCredentialDbRow {
  id: string;
  workspace_id: string;
  vault_id: string;
  type: "vault_credential";
  display_name: string | null;
  metadata: string;
  auth_type: "static_bearer" | "mcp_oauth";
  mcp_server_url: string;
  token_endpoint: string | null;
  client_id: string | null;
  scope: string | null;
  token_endpoint_auth_type:
    | "none"
    | "client_secret_basic"
    | "client_secret_post"
    | null;
  expires_at: string | null;
  auth_version: number;
  refresh_status: "ok" | "invalid" | "transient" | null;
  refresh_attempts: number;
  next_refresh_at: string | null;
  auth_hint_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface RuntimeMetadataDbRow {
  id: string;
  vault_id: string;
  auth_type: "static_bearer" | "mcp_oauth";
  token_endpoint: string | null;
  client_id: string | null;
  token_endpoint_auth_type:
    | "none"
    | "client_secret_basic"
    | "client_secret_post"
    | null;
  auth_version: number;
  expires_at: string | null;
  refresh_status: "ok" | "invalid" | "transient" | null;
  refresh_attempts: number;
  next_refresh_at: string | null;
  auth_hint_at: string | null;
}

interface AdminCredentialMetadataDbRow extends RuntimeMetadataDbRow {
  vault_display_name: string;
  vault_archived_at: string | null;
  credential_display_name: string | null;
  credential_archived_at: string | null;
  mcp_server_url: string;
}

interface OauthSecretPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  client_secret?: unknown;
}

export class SqliteVaultStore implements VaultStore {
  private readonly insertVaultStmt: StatementSync;
  private readonly retrieveVaultActiveStmt: StatementSync;
  private readonly retrieveVaultAnyStmt: StatementSync;
  private readonly updateVaultStmt: StatementSync;
  private readonly archiveVaultStmt: StatementSync;
  private readonly deleteVaultStmt: StatementSync;
  private readonly deleteCredentialsByVaultStmt: StatementSync;
  private readonly credentialRowsByVaultStmt: StatementSync;
  private readonly insertCredentialStmt: StatementSync;
  private readonly retrieveCredentialActiveStmt: StatementSync;
  private readonly retrieveCredentialAnyStmt: StatementSync;
  private readonly updateCredentialMetadataStmt: StatementSync;
  private readonly archiveCredentialStmt: StatementSync;
  private readonly deleteCredentialStmt: StatementSync;
  private readonly countActiveCredentialsStmt: StatementSync;
  private readonly resolveCredentialStmt: StatementSync;
  private readonly readCredentialRuntimeMetadataStmt: StatementSync;
  private readonly persistAuthHintStmt: StatementSync;
  private readonly persistOauthRefreshSuccessStmt: StatementSync;
  private readonly persistOauthRefreshFailureStmt: StatementSync;
  private readonly listDueRefreshesStmt: StatementSync;
  private readonly nextDueRefreshAtStmt: StatementSync;
  private readonly listVaultStmts = new Map<string, StatementSync>();
  private readonly listCredentialStmts = new Map<string, StatementSync>();
  private readonly listAdminCredentialMetadataStmts = new Map<string, StatementSync>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly secrets?: SecretsStore,
  ) {
    this.db.exec(SCHEMA);
    ensureVaultCredentialColumns(this.db);
    this.insertVaultStmt = this.db.prepare(
      `INSERT INTO vaults (
        id, workspace_id, type, display_name, metadata, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.retrieveVaultActiveStmt = this.db.prepare(
      `SELECT * FROM vaults
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
    );
    this.retrieveVaultAnyStmt = this.db.prepare(
      `SELECT * FROM vaults WHERE workspace_id = ? AND id = ?`,
    );
    this.updateVaultStmt = this.db.prepare(
      `UPDATE vaults
       SET display_name = ?, metadata = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
    );
    this.archiveVaultStmt = this.db.prepare(
      `UPDATE vaults
       SET archived_at = COALESCE(archived_at, ?), updated_at = ?
       WHERE workspace_id = ? AND id = ?`,
    );
    this.deleteVaultStmt = this.db.prepare(
      `DELETE FROM vaults WHERE workspace_id = ? AND id = ?`,
    );
    this.deleteCredentialsByVaultStmt = this.db.prepare(
      `DELETE FROM vault_credentials WHERE workspace_id = ? AND vault_id = ?`,
    );
    this.credentialRowsByVaultStmt = this.db.prepare(
      `SELECT * FROM vault_credentials WHERE workspace_id = ? AND vault_id = ?`,
    );
    this.insertCredentialStmt = this.db.prepare(
      `INSERT INTO vault_credentials (
        id, workspace_id, vault_id, type, display_name, metadata, auth_type,
        mcp_server_url, token_endpoint, client_id, scope, token_endpoint_auth_type,
        expires_at, auth_version, next_refresh_at, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.retrieveCredentialActiveStmt = this.db.prepare(
      `SELECT * FROM vault_credentials
       WHERE workspace_id = ? AND vault_id = ? AND id = ? AND archived_at IS NULL`,
    );
    this.retrieveCredentialAnyStmt = this.db.prepare(
      `SELECT * FROM vault_credentials
       WHERE workspace_id = ? AND vault_id = ? AND id = ?`,
    );
    this.updateCredentialMetadataStmt = this.db.prepare(
      `UPDATE vault_credentials
       SET display_name = ?, metadata = ?, expires_at = ?, auth_version = ?,
           refresh_status = CASE WHEN ? THEN NULL ELSE refresh_status END,
           refresh_attempts = CASE WHEN ? THEN 0 ELSE refresh_attempts END,
           next_refresh_at = CASE WHEN ? THEN ? ELSE next_refresh_at END,
           auth_hint_at = CASE WHEN ? THEN NULL ELSE auth_hint_at END,
           updated_at = ?
       WHERE workspace_id = ? AND vault_id = ? AND id = ? AND archived_at IS NULL`,
    );
    this.archiveCredentialStmt = this.db.prepare(
      `UPDATE vault_credentials
       SET archived_at = COALESCE(archived_at, ?), auth_version = auth_version + 1,
           updated_at = ?
       WHERE workspace_id = ? AND vault_id = ? AND id = ?`,
    );
    this.deleteCredentialStmt = this.db.prepare(
      `DELETE FROM vault_credentials
       WHERE workspace_id = ? AND vault_id = ? AND id = ?`,
    );
    this.countActiveCredentialsStmt = this.db.prepare(
      `SELECT COUNT(*) AS n FROM vault_credentials
       WHERE workspace_id = ? AND vault_id = ? AND archived_at IS NULL`,
    );
    this.resolveCredentialStmt = this.db.prepare(
      `SELECT * FROM vault_credentials
       WHERE workspace_id = ? AND vault_id = ? AND mcp_server_url = ? AND archived_at IS NULL
       ORDER BY id ASC
       LIMIT 1`,
    );
    this.readCredentialRuntimeMetadataStmt = this.db.prepare(
      `SELECT id, vault_id, auth_type, token_endpoint, client_id,
              token_endpoint_auth_type, auth_version, expires_at, refresh_status,
              auth_hint_at, next_refresh_at, refresh_attempts
       FROM vault_credentials
       WHERE workspace_id = ? AND vault_id = ? AND id = ? AND archived_at IS NULL`,
    );
    this.persistAuthHintStmt = this.db.prepare(
      `UPDATE vault_credentials
       SET auth_hint_at = ?
       WHERE workspace_id = ? AND vault_id = ? AND id = ?
         AND auth_type = 'mcp_oauth'
         AND auth_version = ?
         AND archived_at IS NULL`,
    );
    this.persistOauthRefreshSuccessStmt = this.db.prepare(
      `UPDATE vault_credentials
       SET expires_at = ?, scope = ?, auth_version = auth_version + 1,
           refresh_status = 'ok', refresh_attempts = 0, next_refresh_at = ?,
           auth_hint_at = NULL, updated_at = ?
       WHERE workspace_id = ? AND vault_id = ? AND id = ?
         AND auth_type = 'mcp_oauth'
         AND auth_version = ?
         AND archived_at IS NULL`,
    );
    this.persistOauthRefreshFailureStmt = this.db.prepare(
      `UPDATE vault_credentials
       SET refresh_status = ?, refresh_attempts = ?, next_refresh_at = ?,
           auth_hint_at = NULL
       WHERE workspace_id = ? AND vault_id = ? AND id = ?
         AND auth_type = 'mcp_oauth'
         AND auth_version = ?
         AND archived_at IS NULL`,
    );
    this.listDueRefreshesStmt = this.db.prepare(
      `SELECT workspace_id, vault_id, id, auth_version, next_refresh_at
       FROM vault_credentials
       WHERE auth_type = 'mcp_oauth'
         AND archived_at IS NULL
         AND next_refresh_at IS NOT NULL
         AND next_refresh_at <= ?
         AND COALESCE(refresh_status, '') != 'invalid'
       ORDER BY next_refresh_at ASC, id ASC
       LIMIT ?`,
    );
    this.nextDueRefreshAtStmt = this.db.prepare(
      `SELECT MIN(next_refresh_at) AS next_refresh_at
       FROM vault_credentials
       WHERE auth_type = 'mcp_oauth'
         AND archived_at IS NULL
         AND next_refresh_at IS NOT NULL
         AND COALESCE(refresh_status, '') != 'invalid'`,
    );
  }

  static open(path = ":memory:", secrets?: SecretsStore): SqliteVaultStore {
    return new SqliteVaultStore(new DatabaseSync(path), secrets);
  }

  createVault(record: CreateVaultRecord): VaultRow {
    const v = record.row;
    this.insertVaultStmt.run(
      v.id,
      v.workspace_id,
      v.type,
      v.display_name,
      JSON.stringify(v.metadata),
      v.created_at,
      v.updated_at,
      v.archived_at,
    );
    return v;
  }

  retrieveVault(workspaceId: string, vaultId: string): VaultRow | undefined {
    const row = this.retrieveVaultActiveStmt.get(
      workspaceId,
      vaultId,
    ) as unknown as VaultDbRow | undefined;
    return row ? deserializeVault(row) : undefined;
  }

  retrieveVaultAny(workspaceId: string, vaultId: string): VaultRow | undefined {
    const row = this.retrieveVaultAnyStmt.get(
      workspaceId,
      vaultId,
    ) as unknown as VaultDbRow | undefined;
    return row ? deserializeVault(row) : undefined;
  }

  listVaults(
    workspaceId: string,
    opts: ListVaultsOptions = {},
  ): ManagedAgentsListPage<VaultRow> {
    if (opts.page === "") return { data: [], has_more: false, next_page: null };
    const limit = normalizeLimit(opts.limit);
    const rows = this.listVaultStmt({
      includeArchived: opts.includeArchived ?? false,
      hasPage: opts.page !== undefined,
    }).all(...selectListArgs(workspaceId, limit + 1, opts.page)) as unknown as VaultDbRow[];
    const data = rows.slice(0, limit).map(deserializeVault);
    return {
      data,
      has_more: rows.length > limit,
      next_page: rows.length > limit ? data[data.length - 1]?.id ?? null : null,
    };
  }

  listWorkspaceCredentialAdminMetadata(
    workspaceId: string,
    opts: ListVaultCredentialAdminMetadataOptions = {},
  ): ManagedAgentsListPage<VaultCredentialAdminMetadata> {
    if (opts.page === "") return { data: [], has_more: false, next_page: null };
    const limit = normalizeLimit(opts.limit);
    const rows = this.listAdminCredentialMetadataStmt({ hasPage: opts.page !== undefined })
      .all(...selectListArgs(workspaceId, limit + 1, opts.page)) as unknown as AdminCredentialMetadataDbRow[];
    const data = rows.slice(0, limit).map(adminCredentialMetadata);
    return {
      data,
      has_more: rows.length > limit,
      next_page: rows.length > limit ? data[data.length - 1]?.credentialId ?? null : null,
    };
  }

  updateVault(
    workspaceId: string,
    vaultId: string,
    updates: { displayName?: string; metadata?: Record<string, string> },
    updatedAt: string,
  ): VaultRow | undefined {
    const existing = this.retrieveVault(workspaceId, vaultId);
    if (!existing) return undefined;
    this.updateVaultStmt.run(
      updates.displayName ?? existing.display_name,
      JSON.stringify(updates.metadata ?? existing.metadata),
      updatedAt,
      workspaceId,
      vaultId,
    );
    return this.retrieveVaultAny(workspaceId, vaultId);
  }

  archiveVault(
    workspaceId: string,
    vaultId: string,
    archivedAt: string,
  ): VaultRow | undefined {
    const existing = this.retrieveVaultAny(workspaceId, vaultId);
    if (!existing) return undefined;
    return withSqliteTransaction(this.db, () => {
      const credentials = this.credentialsForVault(workspaceId, vaultId);
      for (const credential of credentials) {
        this.secrets?.delete(workspaceId, secretName(vaultId, credential.id));
      }
      this.archiveVaultStmt.run(archivedAt, archivedAt, workspaceId, vaultId);
      for (const credential of credentials) {
        this.archiveCredentialStmt.run(
          archivedAt,
          archivedAt,
          workspaceId,
          vaultId,
          credential.id,
        );
      }
      return this.retrieveVaultAny(workspaceId, vaultId);
    });
  }

  deleteVault(workspaceId: string, vaultId: string): VaultRow | undefined {
    const existing = this.retrieveVaultAny(workspaceId, vaultId);
    if (!existing) return undefined;
    return withSqliteTransaction(this.db, () => {
      for (const credential of this.credentialsForVault(workspaceId, vaultId)) {
        this.secrets?.delete(workspaceId, secretName(vaultId, credential.id));
      }
      this.deleteCredentialsByVaultStmt.run(workspaceId, vaultId);
      this.deleteVaultStmt.run(workspaceId, vaultId);
      return existing;
    });
  }

  createCredential(record: CreateVaultCredentialRecord): VaultCredentialRow {
    return withSqliteTransaction(this.db, () => {
      const c = record.row;
      this.requireSecrets().put(
        c.workspace_id,
        secretName(c.vault_id, c.id),
        record.token,
      );
      this.insertCredentialStmt.run(
        c.id,
        c.workspace_id,
        c.vault_id,
        c.type,
        c.display_name,
        JSON.stringify(c.metadata),
        c.auth.type,
        c.auth.mcp_server_url,
        c.auth.type === "mcp_oauth" ? c.auth.refresh?.token_endpoint ?? null : null,
        c.auth.type === "mcp_oauth" ? c.auth.refresh?.client_id ?? null : null,
        c.auth.type === "mcp_oauth" ? c.auth.refresh?.scope ?? null : null,
        c.auth.type === "mcp_oauth"
          ? c.auth.refresh?.token_endpoint_auth.type ?? null
          : null,
        c.auth.type === "mcp_oauth" ? c.auth.expires_at ?? null : null,
        c.auth_version,
        record.nextRefreshAt ?? null,
        c.created_at,
        c.updated_at,
        c.archived_at,
      );
      return c;
    });
  }

  retrieveCredential(
    workspaceId: string,
    vaultId: string,
    credentialId: string,
  ): VaultCredentialRow | undefined {
    const row = this.retrieveCredentialActiveStmt.get(
      workspaceId,
      vaultId,
      credentialId,
    ) as unknown as VaultCredentialDbRow | undefined;
    return row ? deserializeCredential(row) : undefined;
  }

  retrieveCredentialAny(
    workspaceId: string,
    vaultId: string,
    credentialId: string,
  ): VaultCredentialRow | undefined {
    const row = this.retrieveCredentialAnyStmt.get(
      workspaceId,
      vaultId,
      credentialId,
    ) as unknown as VaultCredentialDbRow | undefined;
    return row ? deserializeCredential(row) : undefined;
  }

  listCredentials(
    workspaceId: string,
    vaultId: string,
    opts: ListVaultCredentialsOptions = {},
  ): ManagedAgentsListPage<VaultCredentialRow> {
    if (opts.page === "") return { data: [], has_more: false, next_page: null };
    const limit = normalizeLimit(opts.limit);
    const rows = this.listCredentialStmt({
      includeArchived: opts.includeArchived ?? false,
      hasPage: opts.page !== undefined,
    }).all(
      ...selectCredentialListArgs(workspaceId, vaultId, limit + 1, opts.page),
    ) as unknown as VaultCredentialDbRow[];
    const data = rows.slice(0, limit).map(deserializeCredential);
    return {
      data,
      has_more: rows.length > limit,
      next_page: rows.length > limit ? data[data.length - 1]?.id ?? null : null,
    };
  }

  updateCredential(
    workspaceId: string,
    vaultId: string,
    credentialId: string,
    updates: {
      displayName?: string | null;
      metadata?: Record<string, string>;
      auth?:
        | { type: "static_bearer"; token: string }
        | {
            type: "mcp_oauth";
            expiresAt?: string | null;
            accessToken?: string;
            refreshToken?: string;
          };
    },
    updatedAt: string,
    scheduling?: { nextRefreshAt: string | null },
  ): VaultCredentialRow | undefined {
    const existing = this.retrieveCredential(workspaceId, vaultId, credentialId);
    if (!existing) return undefined;
    return withSqliteTransaction(this.db, () => {
      if (updates.auth !== undefined) {
        this.putUpdatedSecret(
          workspaceId,
          vaultId,
          credentialId,
          existing,
          updates.auth,
        );
      }
      const nextAuthVersion =
        updates.auth === undefined ? existing.auth_version : existing.auth_version + 1;
      const nextExpiresAt =
        updates.auth?.type === "mcp_oauth" && updates.auth.expiresAt !== undefined
          ? updates.auth.expiresAt
          : existing.auth.type === "mcp_oauth"
            ? existing.auth.expires_at ?? null
            : null;
      this.updateCredentialMetadataStmt.run(
        updates.displayName === undefined
          ? existing.display_name
          : updates.displayName,
        JSON.stringify(updates.metadata ?? existing.metadata),
        nextExpiresAt,
        nextAuthVersion,
        updates.auth === undefined ? 0 : 1,
        updates.auth === undefined ? 0 : 1,
        updates.auth === undefined ? 0 : 1,
        scheduling?.nextRefreshAt ?? null,
        updates.auth === undefined ? 0 : 1,
        updatedAt,
        workspaceId,
        vaultId,
        credentialId,
      );
      return this.retrieveCredentialAny(workspaceId, vaultId, credentialId);
    });
  }

  archiveCredential(
    workspaceId: string,
    vaultId: string,
    credentialId: string,
    archivedAt: string,
  ): VaultCredentialRow | undefined {
    const existing = this.retrieveCredentialAny(workspaceId, vaultId, credentialId);
    if (!existing) return undefined;
    return withSqliteTransaction(this.db, () => {
      this.secrets?.delete(workspaceId, secretName(vaultId, credentialId));
      this.archiveCredentialStmt.run(
        archivedAt,
        archivedAt,
        workspaceId,
        vaultId,
        credentialId,
      );
      return this.retrieveCredentialAny(workspaceId, vaultId, credentialId);
    });
  }

  deleteCredential(
    workspaceId: string,
    vaultId: string,
    credentialId: string,
  ): VaultCredentialRow | undefined {
    const existing = this.retrieveCredentialAny(workspaceId, vaultId, credentialId);
    if (!existing) return undefined;
    return withSqliteTransaction(this.db, () => {
      this.secrets?.delete(workspaceId, secretName(vaultId, credentialId));
      this.deleteCredentialStmt.run(workspaceId, vaultId, credentialId);
      return existing;
    });
  }

  countActiveCredentials(workspaceId: string, vaultId: string): number {
    return (this.countActiveCredentialsStmt.get(workspaceId, vaultId) as { n: number }).n;
  }

  resolveCredential(
    workspaceId: WorkspaceId,
    vaultIds: readonly string[],
    serverUrl: string,
  ): VaultCredentialResolution | undefined {
    for (const vaultId of vaultIds) {
      const row = this.resolveCredentialStmt.get(
        workspaceId,
        vaultId,
        serverUrl,
      ) as unknown as VaultCredentialDbRow | undefined;
      if (!row) continue;
      const token = this.secrets?.reveal(workspaceId, secretName(vaultId, row.id));
      if (token === undefined) return undefined;
      const accessToken =
        row.auth_type === "mcp_oauth" ? oauthAccessToken(token) : token;
      if (accessToken === undefined) return undefined;
      return {
        vaultId,
        credentialId: row.id,
        authType: row.auth_type,
        authVersion: row.auth_version,
        ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
        refreshStatus: row.refresh_status,
        authHintAt: row.auth_hint_at,
        updatedAt: row.updated_at,
        token: accessToken,
      };
    }
    return undefined;
  }

  readCredentialRuntimeMetadata(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): VaultCredentialRuntimeMetadata | undefined {
    const row = this.readCredentialRuntimeMetadataStmt.get(
      workspaceId,
      vaultId,
      credentialId,
    ) as unknown as RuntimeMetadataDbRow | undefined;
    return row === undefined ? undefined : runtimeMetadata(row);
  }

  persistAuthHint(input: PersistAuthHintInput): PersistAuthHintResult {
    return withSqliteTransaction(this.db, () => {
      const result = this.persistAuthHintStmt.run(
        input.authHintAt,
        input.workspaceId,
        input.vaultId,
        input.credentialId,
        input.expectedAuthVersion,
      ) as { changes: number };
      const metadata = this.readCredentialRuntimeMetadata(
        input.workspaceId,
        input.vaultId,
        input.credentialId,
      );
      return result.changes === 1 && metadata !== undefined
        ? { status: "updated", metadata }
        : { status: "stale", metadata };
    });
  }

  readOauthRefreshState(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): VaultOauthRefreshState | undefined {
    return this.readOauthRefreshStateInternal(workspaceId, vaultId, credentialId);
  }

  persistOauthRefreshSuccess(
    input: PersistOauthRefreshSuccessInput,
  ): PersistOauthRefreshResult {
    return withSqliteTransaction(this.db, () => {
      const current = this.readOauthRefreshStateInternal(
        input.workspaceId,
        input.vaultId,
        input.credentialId,
      );
      if (current === undefined) return { status: "stale", state: undefined };
      const result = this.persistOauthRefreshSuccessStmt.run(
        input.expiresAt === undefined ? current.expiresAt ?? null : input.expiresAt,
        input.scope === undefined ? current.refresh?.scope ?? null : input.scope,
        input.nextRefreshAt ?? null,
        input.updatedAt,
        input.workspaceId,
        input.vaultId,
        input.credentialId,
        input.expectedAuthVersion,
      ) as { changes: number };
      if (result.changes !== 1) {
        return {
          status: "stale",
          state: this.readOauthRefreshStateInternal(
            input.workspaceId,
            input.vaultId,
            input.credentialId,
          ),
        };
      }
      const nextRefreshToken = input.refreshToken ?? current.secrets.refreshToken;
      const nextSecret = {
        access_token: input.accessToken,
        ...(nextRefreshToken === undefined
          ? {}
          : { refresh_token: nextRefreshToken }),
        ...(current.secrets.clientSecret === undefined
          ? {}
          : { client_secret: current.secrets.clientSecret }),
      };
      this.requireSecrets().put(
        input.workspaceId,
        secretName(input.vaultId, input.credentialId),
        JSON.stringify(nextSecret),
      );
      return {
        status: "updated",
        state: this.readOauthRefreshStateInternal(
          input.workspaceId,
          input.vaultId,
          input.credentialId,
        )!,
      };
    });
  }

  persistOauthRefreshFailure(
    input: PersistOauthRefreshFailureInput,
  ): PersistOauthRefreshResult {
    return withSqliteTransaction(this.db, () => {
      const result = this.persistOauthRefreshFailureStmt.run(
        input.status,
        input.refreshAttempts,
        input.nextRefreshAt,
        input.workspaceId,
        input.vaultId,
        input.credentialId,
        input.expectedAuthVersion,
      ) as { changes: number };
      return result.changes === 1
        ? {
            status: "updated",
            state: this.readOauthRefreshStateInternal(
              input.workspaceId,
              input.vaultId,
              input.credentialId,
            )!,
          }
        : {
            status: "stale",
            state: this.readOauthRefreshStateInternal(
              input.workspaceId,
              input.vaultId,
              input.credentialId,
            ),
          };
    });
  }

  listDueRefreshes(now: string, limit = 50): OauthRefreshDueCredential[] {
    const rows = this.listDueRefreshesStmt.all(now, limit) as Array<{
      workspace_id: string;
      vault_id: string;
      id: string;
      auth_version: number;
      next_refresh_at: string;
    }>;
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      vaultId: row.vault_id,
      credentialId: row.id,
      authVersion: row.auth_version,
      nextRefreshAt: row.next_refresh_at,
    }));
  }

  nextDueRefreshAt(_now: string): string | null {
    const row = this.nextDueRefreshAtStmt.get() as
      | { next_refresh_at: string | null }
      | undefined;
    return row?.next_refresh_at ?? null;
  }

  close(): void {
    this.db.close();
  }

  private requireSecrets(): SecretsStore {
    if (this.secrets === undefined) {
      throw new Error(
        "Secrets require a master key: set OMA_MASTER_KEY or OMA_MASTER_KEY_FILE on the deployment",
      );
    }
    return this.secrets;
  }

  private putUpdatedSecret(
    workspaceId: string,
    vaultId: string,
    credentialId: string,
    existing: VaultCredentialRow,
    auth: NonNullable<Parameters<VaultStore["updateCredential"]>[3]["auth"]>,
  ): void {
    if (auth.type !== existing.auth.type) {
      throw new Error("Credential auth type cannot be changed");
    }
    const name = secretName(vaultId, credentialId);
    if (auth.type === "static_bearer") {
      this.requireSecrets().put(workspaceId, name, auth.token);
      return;
    }
    const current = this.requireSecrets().reveal(workspaceId, name);
    const parsed = current === undefined ? {} : parseOauthSecret(current);
    const next = {
      ...parsed,
      ...(auth.accessToken === undefined ? {} : { access_token: auth.accessToken }),
      ...(auth.refreshToken === undefined
        ? {}
        : { refresh_token: auth.refreshToken }),
    };
    this.requireSecrets().put(workspaceId, name, JSON.stringify(next));
  }

  private credentialsForVault(
    workspaceId: string,
    vaultId: string,
  ): VaultCredentialRow[] {
    return (this.credentialRowsByVaultStmt.all(
      workspaceId,
      vaultId,
    ) as unknown as VaultCredentialDbRow[]).map(deserializeCredential);
  }

  private readOauthRefreshStateInternal(
    workspaceId: string,
    vaultId: string,
    credentialId: string,
  ): VaultOauthRefreshState | undefined {
    const row = this.retrieveCredentialActiveStmt.get(
      workspaceId,
      vaultId,
      credentialId,
    ) as unknown as VaultCredentialDbRow | undefined;
    if (!row || row.auth_type !== "mcp_oauth") return undefined;
    const raw = this.secrets?.reveal(workspaceId, secretName(vaultId, credentialId));
    const parsed = raw === undefined ? {} : parseOauthSecret(raw);
    const auth = deserializeCredentialAuth(row);
    if (auth.type !== "mcp_oauth") return undefined;
    return {
      workspaceId,
      vaultId,
      credentialId,
      authVersion: row.auth_version,
      mcpServerUrl: row.mcp_server_url,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      ...(auth.refresh === undefined
        ? {}
        : {
            refresh: {
              tokenEndpoint: auth.refresh.token_endpoint,
              clientId: auth.refresh.client_id,
              ...(auth.refresh.scope === undefined
                ? {}
                : { scope: auth.refresh.scope }),
              tokenEndpointAuth: auth.refresh.token_endpoint_auth,
            },
          }),
      secrets: {
        ...(typeof parsed.access_token === "string"
          ? { accessToken: parsed.access_token }
          : {}),
        ...(typeof parsed.refresh_token === "string"
          ? { refreshToken: parsed.refresh_token }
          : {}),
        ...(typeof parsed.client_secret === "string"
          ? { clientSecret: parsed.client_secret }
          : {}),
      },
      refreshStatus: row.refresh_status,
      refreshAttempts: row.refresh_attempts,
      nextRefreshAt: row.next_refresh_at,
      authHintAt: row.auth_hint_at,
    };
  }

  private listVaultStmt(opts: {
    includeArchived: boolean;
    hasPage: boolean;
  }): StatementSync {
    const key = JSON.stringify(opts);
    const existing = this.listVaultStmts.get(key);
    if (existing) return existing;
    const predicates = ["workspace_id = ?"];
    if (!opts.includeArchived) predicates.push("archived_at IS NULL");
    if (opts.hasPage) predicates.push("id < ?");
    const stmt = this.db.prepare(
      `SELECT * FROM vaults
       WHERE ${predicates.join(" AND ")}
       ORDER BY id DESC
       LIMIT ?`,
    );
    this.listVaultStmts.set(key, stmt);
    return stmt;
  }

  private listCredentialStmt(opts: {
    includeArchived: boolean;
    hasPage: boolean;
  }): StatementSync {
    const key = JSON.stringify(opts);
    const existing = this.listCredentialStmts.get(key);
    if (existing) return existing;
    const predicates = ["workspace_id = ?", "vault_id = ?"];
    if (!opts.includeArchived) predicates.push("archived_at IS NULL");
    if (opts.hasPage) predicates.push("id < ?");
    const stmt = this.db.prepare(
      `SELECT * FROM vault_credentials
       WHERE ${predicates.join(" AND ")}
       ORDER BY id DESC
       LIMIT ?`,
    );
    this.listCredentialStmts.set(key, stmt);
    return stmt;
  }

  private listAdminCredentialMetadataStmt(opts: { hasPage: boolean }): StatementSync {
    const key = JSON.stringify(opts);
    const existing = this.listAdminCredentialMetadataStmts.get(key);
    if (existing) return existing;
    const predicates = ["c.workspace_id = ?"];
    if (opts.hasPage) predicates.push("c.id < ?");
    const stmt = this.db.prepare(
      `SELECT c.id, c.vault_id, c.auth_type, c.token_endpoint, c.client_id,
              c.token_endpoint_auth_type, c.auth_version, c.expires_at,
              c.refresh_status, c.refresh_attempts, c.next_refresh_at, c.auth_hint_at,
              c.mcp_server_url, c.display_name AS credential_display_name,
              c.archived_at AS credential_archived_at,
              v.display_name AS vault_display_name, v.archived_at AS vault_archived_at
       FROM vault_credentials c
       INNER JOIN vaults v ON v.workspace_id = c.workspace_id AND v.id = c.vault_id
       WHERE ${predicates.join(" AND ")}
       ORDER BY c.id DESC
       LIMIT ?`,
    );
    this.listAdminCredentialMetadataStmts.set(key, stmt);
    return stmt;
  }
}

export function vaultSecretName(vaultId: string, credentialId: string): string {
  return secretName(vaultId, credentialId);
}

function secretName(vaultId: string, credentialId: string): string {
  return `${VAULT_SECRET_PREFIX}${vaultId}/${credentialId}`;
}

function selectListArgs(
  workspaceId: string,
  limit: number,
  page: string | undefined,
): [string, number] | [string, string, number] {
  return page === undefined ? [workspaceId, limit] : [workspaceId, page, limit];
}

function selectCredentialListArgs(
  workspaceId: string,
  vaultId: string,
  limit: number,
  page: string | undefined,
): [string, string, number] | [string, string, string, number] {
  return page === undefined
    ? [workspaceId, vaultId, limit]
    : [workspaceId, vaultId, page, limit];
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isSafeInteger(limit) || limit <= 0) return 20;
  return Math.min(limit, 100);
}

function deserializeVault(row: VaultDbRow): VaultRow {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    type: "vault",
    display_name: row.display_name,
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
}

function deserializeCredential(row: VaultCredentialDbRow): VaultCredentialRow {
  const auth = deserializeCredentialAuth(row);
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    vault_id: row.vault_id,
    type: "vault_credential",
    display_name: row.display_name,
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    auth,
    auth_version: row.auth_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
}

function deserializeCredentialAuth(row: VaultCredentialDbRow): VaultCredentialAuth {
  if (row.auth_type === "static_bearer") {
    return {
      type: "static_bearer",
      mcp_server_url: row.mcp_server_url,
    };
  }
  return {
    type: "mcp_oauth",
    mcp_server_url: row.mcp_server_url,
    ...(row.expires_at === null ? {} : { expires_at: row.expires_at }),
    ...(row.token_endpoint === null ||
    row.client_id === null ||
    row.token_endpoint_auth_type === null
      ? {}
      : {
          refresh: {
            token_endpoint: row.token_endpoint,
            client_id: row.client_id,
            ...(row.scope === null ? {} : { scope: row.scope }),
            token_endpoint_auth: { type: row.token_endpoint_auth_type },
          },
        }),
  };
}

function runtimeMetadata(
  row: RuntimeMetadataDbRow,
): VaultCredentialRuntimeMetadata {
  return {
    vaultId: row.vault_id,
    credentialId: row.id,
    authType: row.auth_type,
    hasRefresh:
      row.auth_type === "mcp_oauth" &&
      row.token_endpoint !== null &&
      row.client_id !== null &&
      row.token_endpoint_auth_type !== null,
    authVersion: row.auth_version,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    refreshStatus: row.refresh_status,
    authHintAt: row.auth_hint_at,
    nextRefreshAt: row.next_refresh_at,
    refreshAttempts: row.refresh_attempts,
  };
}

function adminCredentialMetadata(row: AdminCredentialMetadataDbRow): VaultCredentialAdminMetadata {
  return {
    ...runtimeMetadata(row),
    vaultDisplayName: row.vault_display_name,
    vaultArchivedAt: row.vault_archived_at,
    credentialDisplayName: row.credential_display_name,
    credentialArchivedAt: row.credential_archived_at,
    mcpServerUrl: row.mcp_server_url,
  };
}

function ensureVaultCredentialColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(vault_credentials)").all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((column) => column.name));
  for (const [name, definition] of [
    ["token_endpoint", "TEXT"],
    ["client_id", "TEXT"],
    ["scope", "TEXT"],
    ["token_endpoint_auth_type", "TEXT"],
    ["expires_at", "TEXT"],
    ["auth_version", "INTEGER NOT NULL DEFAULT 1"],
    ["refresh_status", "TEXT"],
    ["refresh_attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["next_refresh_at", "TEXT"],
    ["auth_hint_at", "TEXT"],
  ] as const) {
    if (!names.has(name)) {
      db.exec(`ALTER TABLE vault_credentials ADD COLUMN ${name} ${definition}`);
    }
  }
}

function oauthAccessToken(value: string): string | undefined {
  const parsed = parseOauthSecret(value);
  return typeof parsed.access_token === "string" && parsed.access_token.length > 0
    ? parsed.access_token
    : undefined;
}

function parseOauthSecret(value: string): OauthSecretPayload {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as OauthSecretPayload)
      : {};
  } catch {
    return {};
  }
}
