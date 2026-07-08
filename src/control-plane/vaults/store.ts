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
  VaultCredentialResolution,
  VaultCredentialRow,
  VaultRow,
  VaultStore,
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
  auth_type: "static_bearer";
  mcp_server_url: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
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
  private readonly listVaultStmts = new Map<string, StatementSync>();
  private readonly listCredentialStmts = new Map<string, StatementSync>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly secrets?: SecretsStore,
  ) {
    this.db.exec(SCHEMA);
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
        mcp_server_url, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
       SET display_name = ?, metadata = ?, updated_at = ?
       WHERE workspace_id = ? AND vault_id = ? AND id = ? AND archived_at IS NULL`,
    );
    this.archiveCredentialStmt = this.db.prepare(
      `UPDATE vault_credentials
       SET archived_at = COALESCE(archived_at, ?), updated_at = ?
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
      token?: string;
    },
    updatedAt: string,
  ): VaultCredentialRow | undefined {
    const existing = this.retrieveCredential(workspaceId, vaultId, credentialId);
    if (!existing) return undefined;
    return withSqliteTransaction(this.db, () => {
      if (updates.token !== undefined) {
        this.requireSecrets().put(
          workspaceId,
          secretName(vaultId, credentialId),
          updates.token,
        );
      }
      this.updateCredentialMetadataStmt.run(
        updates.displayName === undefined
          ? existing.display_name
          : updates.displayName,
        JSON.stringify(updates.metadata ?? existing.metadata),
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
      return {
        credentialId: row.id,
        updatedAt: row.updated_at,
        token,
      };
    }
    return undefined;
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

  private credentialsForVault(
    workspaceId: string,
    vaultId: string,
  ): VaultCredentialRow[] {
    return (this.credentialRowsByVaultStmt.all(
      workspaceId,
      vaultId,
    ) as unknown as VaultCredentialDbRow[]).map(deserializeCredential);
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
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    vault_id: row.vault_id,
    type: "vault_credential",
    display_name: row.display_name,
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    auth: {
      type: "static_bearer",
      mcp_server_url: row.mcp_server_url,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
}
