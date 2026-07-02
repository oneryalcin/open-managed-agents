import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID, type WorkspaceId } from "../workspace.ts";
import { uuidv7 } from "../../types/events.ts";

// Plan 0113 D2/D3: opaque `oma_`-prefixed 256-bit keys, SHA-256 digests at
// rest, tombstone revocation, idempotent wrk_default seeding.
const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_api_keys (
  key_sha256   TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS workspace_api_keys_by_workspace
  ON workspace_api_keys (workspace_id, key_sha256);
`;

export const WORKSPACE_API_KEY_PREFIX = "oma_";

export interface WorkspaceRow {
  workspace_id: WorkspaceId;
  name: string;
  created_at: string;
}

export interface WorkspaceApiKeyRow {
  key_sha256: string;
  workspace_id: WorkspaceId;
  label: string;
  created_at: string;
  revoked_at: string | null;
}

export interface MintedWorkspaceApiKey {
  plaintextKey: string;
  keySha256: string;
  workspaceId: WorkspaceId;
  label: string;
}

export function newWorkspaceId(): string {
  return `wrk_${uuidv7()}`;
}

export function hashWorkspaceApiKey(plaintextKey: string): string {
  return createHash("sha256").update(plaintextKey).digest("hex");
}

export class SqliteWorkspaceStore {
  private readonly db: DatabaseSync;
  private readonly insertWorkspaceStmt: StatementSync;
  private readonly getWorkspaceStmt: StatementSync;
  private readonly insertKeyStmt: StatementSync;
  private readonly authenticateStmt: StatementSync;
  private readonly revokeKeyStmt: StatementSync;
  private readonly listKeysStmt: StatementSync;
  private readonly listWorkspacesStmt: StatementSync;
  private readonly getKeyStmt: StatementSync;
  private readonly countKeysStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    this.insertWorkspaceStmt = this.db.prepare(
      `INSERT INTO workspaces (workspace_id, name, created_at) VALUES (?, ?, ?)`,
    );
    this.getWorkspaceStmt = this.db.prepare(
      `SELECT workspace_id, name, created_at FROM workspaces WHERE workspace_id = ?`,
    );
    this.insertKeyStmt = this.db.prepare(
      `INSERT INTO workspace_api_keys (key_sha256, workspace_id, label, created_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)`,
    );
    this.authenticateStmt = this.db.prepare(
      `SELECT workspace_id FROM workspace_api_keys
       WHERE key_sha256 = ? AND revoked_at IS NULL`,
    );
    this.revokeKeyStmt = this.db.prepare(
      `UPDATE workspace_api_keys
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE key_sha256 = ?`,
    );
    this.listKeysStmt = this.db.prepare(
      `SELECT key_sha256, workspace_id, label, created_at, revoked_at
       FROM workspace_api_keys
       WHERE workspace_id = ?
       ORDER BY key_sha256 ASC`,
    );
    this.listWorkspacesStmt = this.db.prepare(
      `SELECT workspace_id, name, created_at FROM workspaces
       ORDER BY workspace_id ASC`,
    );
    this.getKeyStmt = this.db.prepare(
      `SELECT key_sha256, workspace_id, label, created_at, revoked_at
       FROM workspace_api_keys
       WHERE key_sha256 = ?`,
    );
    this.countKeysStmt = this.db.prepare(
      `SELECT COUNT(*) AS n FROM workspace_api_keys`,
    );
    this.db.prepare(
      `INSERT OR IGNORE INTO workspaces (workspace_id, name, created_at)
       VALUES (?, 'Default workspace', ?)`,
    ).run(DEFAULT_WORKSPACE_ID, new Date().toISOString());
  }

  static open(path: string): SqliteWorkspaceStore {
    return new SqliteWorkspaceStore(new DatabaseSync(path));
  }

  createWorkspace(name: string, workspaceId = newWorkspaceId()): WorkspaceRow {
    const row: WorkspaceRow = {
      workspace_id: workspaceId,
      name,
      created_at: new Date().toISOString(),
    };
    this.insertWorkspaceStmt.run(row.workspace_id, row.name, row.created_at);
    return row;
  }

  getWorkspace(workspaceId: WorkspaceId): WorkspaceRow | undefined {
    return this.getWorkspaceStmt.get(workspaceId) as WorkspaceRow | undefined;
  }

  listWorkspaces(): WorkspaceRow[] {
    return this.listWorkspacesStmt.all() as unknown as WorkspaceRow[];
  }

  getKey(keySha256: string): WorkspaceApiKeyRow | undefined {
    return this.getKeyStmt.get(keySha256) as WorkspaceApiKeyRow | undefined;
  }

  mintKey(workspaceId: WorkspaceId, label: string): MintedWorkspaceApiKey {
    if (!this.getWorkspace(workspaceId)) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    const plaintextKey = `${WORKSPACE_API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    const keySha256 = hashWorkspaceApiKey(plaintextKey);
    this.insertKeyStmt.run(keySha256, workspaceId, label, new Date().toISOString());
    return { plaintextKey, keySha256, workspaceId, label };
  }

  // Counts every key ever minted, revoked included: first boot means "no key
  // was ever issued", not "no key currently works".
  countApiKeys(): number {
    return (this.countKeysStmt.get() as { n: number }).n;
  }

  authenticate(plaintextKey: string): WorkspaceId | undefined {
    const row = this.authenticateStmt.get(hashWorkspaceApiKey(plaintextKey)) as
      | { workspace_id: WorkspaceId }
      | undefined;
    return row?.workspace_id;
  }

  revokeKey(keySha256: string): boolean {
    return this.revokeKeyStmt.run(new Date().toISOString(), keySha256).changes > 0;
  }

  listKeys(workspaceId: WorkspaceId): WorkspaceApiKeyRow[] {
    return this.listKeysStmt.all(workspaceId) as unknown as WorkspaceApiKeyRow[];
  }

  close(): void {
    this.db.close();
  }
}
