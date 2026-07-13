import { DatabaseSync, type StatementSync } from "node:sqlite";
import { invalidRequest } from "../errors.ts";
import { withSqliteTransaction } from "../sqlite-transaction.ts";
import type {
  CreateSessionRecord,
  CreateSessionIdempotencyCommit,
  ListSessionsOptions,
  PendingInternalSnapshotCreateRollbackRow,
  PendingInternalSnapshotDeleteRow,
  SessionFileMountSnapshotRow,
  SessionSkillSnapshotRow,
  SessionListPage,
  SessionRow,
  SessionStore,
} from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  type           TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  agent_version  INTEGER NOT NULL,
  environment_id TEXT NOT NULL,
  vault_ids      TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL,
  title          TEXT,
  metadata       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  archived_at    TEXT,
  usage          TEXT
);
CREATE INDEX IF NOT EXISTS sessions_by_workspace ON sessions (workspace_id, id);
CREATE INDEX IF NOT EXISTS sessions_by_workspace_agent ON sessions (workspace_id, agent_id, id);
-- Partial index so the /metrics active-sessions gauge scans O(active), not
-- O(history) (plan 0121 §3.2).
CREATE INDEX IF NOT EXISTS idx_sessions_live ON sessions (archived_at) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS session_resources (
  id          TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  type        TEXT NOT NULL,
  file_id     TEXT NOT NULL,
  mount_path  TEXT NOT NULL,
  position    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_resources_by_session
ON session_resources (workspace_id, session_id, id);

CREATE TABLE IF NOT EXISTS session_file_mount_snapshots (
  workspace_id      TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  file_id           TEXT NOT NULL,
  mount_path        TEXT NOT NULL,
  snapshot_file_id  TEXT NOT NULL,
  sha256            TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'upload',
  skill_snapshot_id TEXT,
  PRIMARY KEY (workspace_id, session_id, resource_id)
);
CREATE TABLE IF NOT EXISTS session_skill_snapshots (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  skill_snapshot_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  PRIMARY KEY (workspace_id, session_id, skill_snapshot_id)
);
CREATE INDEX IF NOT EXISTS session_file_mount_snapshots_by_session
ON session_file_mount_snapshots (workspace_id, session_id);

CREATE TABLE IF NOT EXISTS pending_internal_snapshot_deletes (
  workspace_id      TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  file_id           TEXT NOT NULL,
  mount_path        TEXT NOT NULL,
  snapshot_file_id  TEXT NOT NULL,
  sha256            TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'upload',
  skill_snapshot_id TEXT,
  created_at        TEXT NOT NULL,
  last_attempt_at   TEXT,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  PRIMARY KEY (workspace_id, session_id, resource_id)
);

CREATE TABLE IF NOT EXISTS pending_internal_snapshot_create_rollbacks (
  workspace_id      TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  resource_id       TEXT NOT NULL,
  file_id           TEXT NOT NULL,
  mount_path        TEXT NOT NULL,
  snapshot_file_id  TEXT NOT NULL,
  sha256            TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'upload',
  skill_snapshot_id TEXT,
  created_at        TEXT NOT NULL,
  last_attempt_at   TEXT,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  PRIMARY KEY (workspace_id, session_id, resource_id)
);
`;

interface SessionDbRow {
  id: string;
  workspace_id: string;
  type: "session";
  agent_id: string;
  agent_version: number;
  environment_id: string;
  vault_ids: string;
  status: SessionRow["status"];
  title: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  usage: string | null;
}

export class SqliteSessionStore implements SessionStore {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly insertResourceStmt: StatementSync;
  private readonly insertSnapshotStmt: StatementSync;
  private readonly insertSkillSnapshotStmt: StatementSync;
  private readonly retrieveActiveStmt: StatementSync;
  private readonly countActiveStmt: StatementSync;
  private readonly countAllActiveStmt: StatementSync;
  private readonly retrieveAnyStmt: StatementSync;
  private readonly archiveStmt: StatementSync;
  private readonly insertPendingSnapshotDeletesStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly deleteResourcesStmt: StatementSync;
  private readonly deleteSnapshotsStmt: StatementSync;
  private readonly resourcesBySessionStmt: StatementSync;
  private readonly snapshotsBySessionStmt: StatementSync;
  private readonly skillSnapshotsBySessionStmt: StatementSync;
  private readonly pendingSnapshotDeleteWorkspacesStmt: StatementSync;
  private readonly pendingSnapshotDeletesByWorkspaceStmt: StatementSync;
  private readonly pendingSnapshotDeletesBySessionStmt: StatementSync;
  private readonly recordPendingSnapshotDeleteAttemptStmt: StatementSync;
  private readonly clearPendingSnapshotDeleteStmt: StatementSync;
  private readonly insertPendingSnapshotCreateRollbackStmt: StatementSync;
  private readonly clearPendingSnapshotCreateRollbacksBySessionStmt: StatementSync;
  private readonly pendingSnapshotCreateRollbackWorkspacesStmt: StatementSync;
  private readonly pendingSnapshotCreateRollbacksByWorkspaceStmt: StatementSync;
  private readonly pendingSnapshotCreateRollbacksBySessionStmt: StatementSync;
  private readonly recordPendingSnapshotCreateRollbackAttemptStmt: StatementSync;
  private readonly clearPendingSnapshotCreateRollbackStmt: StatementSync;
  private readonly listStmts: Map<string, StatementSync> = new Map();

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    ensureVaultIdsColumn(this.db);
    ensureSnapshotColumns(this.db);
    this.insertStmt = this.db.prepare(
      `INSERT INTO sessions (
        id, workspace_id, type, agent_id, agent_version, environment_id,
        vault_ids, status, title, metadata, created_at, updated_at, archived_at, usage
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertResourceStmt = this.db.prepare(
      `INSERT INTO session_resources (
        id, workspace_id, session_id, type, file_id, mount_path, position, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertSnapshotStmt = this.db.prepare(
      `INSERT INTO session_file_mount_snapshots (
        workspace_id, session_id, resource_id, file_id, mount_path,
        snapshot_file_id, sha256, size_bytes, kind, skill_snapshot_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertSkillSnapshotStmt = this.db.prepare(
      `INSERT INTO session_skill_snapshots
       (workspace_id,session_id,skill_snapshot_id,skill_id,version,name,description)
       VALUES (?,?,?,?,?,?,?)`,
    );
    this.retrieveActiveStmt = this.db.prepare(
      `SELECT * FROM sessions
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
    );
    this.countActiveStmt = this.db.prepare(
      `SELECT COUNT(*) AS n FROM sessions
       WHERE workspace_id = ? AND archived_at IS NULL`,
    );
    this.countAllActiveStmt = this.db.prepare(
      `SELECT COUNT(*) AS n FROM sessions WHERE archived_at IS NULL`,
    );
    this.retrieveAnyStmt = this.db.prepare(
      `SELECT * FROM sessions
       WHERE workspace_id = ? AND id = ?`,
    );
    this.archiveStmt = this.db.prepare(
      `UPDATE sessions
       SET status = 'terminated', updated_at = ?, archived_at = COALESCE(archived_at, ?)
       WHERE workspace_id = ? AND id = ?`,
    );
    this.insertPendingSnapshotDeletesStmt = this.db.prepare(
      `INSERT OR IGNORE INTO pending_internal_snapshot_deletes (
        workspace_id, session_id, resource_id, file_id, mount_path,
        snapshot_file_id, sha256, size_bytes, kind, skill_snapshot_id, created_at
      )
      SELECT
        workspace_id, session_id, resource_id, file_id, mount_path,
        snapshot_file_id, sha256, size_bytes, kind, skill_snapshot_id, ?
      FROM session_file_mount_snapshots
      WHERE workspace_id = ? AND session_id = ?`,
    );
    this.deleteStmt = this.db.prepare(
      `DELETE FROM sessions
       WHERE workspace_id = ? AND id = ?`,
    );
    this.deleteResourcesStmt = this.db.prepare(
      `DELETE FROM session_resources
       WHERE workspace_id = ? AND session_id = ?`,
    );
    this.deleteSnapshotsStmt = this.db.prepare(
      `DELETE FROM session_file_mount_snapshots
       WHERE workspace_id = ? AND session_id = ?`,
    );
    this.resourcesBySessionStmt = this.db.prepare(
      `SELECT * FROM session_resources
       WHERE workspace_id = ? AND session_id = ?
       ORDER BY position ASC, id ASC`,
    );
    this.snapshotsBySessionStmt = this.db.prepare(
      `SELECT * FROM session_file_mount_snapshots
       WHERE workspace_id = ? AND session_id = ?
       ORDER BY resource_id ASC`,
    );
    this.skillSnapshotsBySessionStmt = this.db.prepare(
      `SELECT * FROM session_skill_snapshots WHERE workspace_id=? AND session_id=? ORDER BY skill_snapshot_id`,
    );
    this.pendingSnapshotDeleteWorkspacesStmt = this.db.prepare(
      `SELECT DISTINCT workspace_id
       FROM pending_internal_snapshot_deletes
       ORDER BY workspace_id ASC`,
    );
    this.pendingSnapshotDeletesByWorkspaceStmt = this.db.prepare(
      `SELECT *
       FROM pending_internal_snapshot_deletes
       WHERE workspace_id = ?
       ORDER BY session_id ASC, resource_id ASC`,
    );
    this.pendingSnapshotDeletesBySessionStmt = this.db.prepare(
      `SELECT *
       FROM pending_internal_snapshot_deletes
       WHERE workspace_id = ? AND session_id = ?
       ORDER BY resource_id ASC`,
    );
    this.recordPendingSnapshotDeleteAttemptStmt = this.db.prepare(
      `UPDATE pending_internal_snapshot_deletes
       SET last_attempt_at = ?, attempt_count = attempt_count + 1, last_error = ?
       WHERE workspace_id = ? AND session_id = ? AND resource_id = ?`,
    );
    this.clearPendingSnapshotDeleteStmt = this.db.prepare(
      `DELETE FROM pending_internal_snapshot_deletes
       WHERE workspace_id = ? AND session_id = ? AND resource_id = ?`,
    );
    this.insertPendingSnapshotCreateRollbackStmt = this.db.prepare(
      `INSERT INTO pending_internal_snapshot_create_rollbacks (
        workspace_id, session_id, resource_id, file_id, mount_path,
        snapshot_file_id, sha256, size_bytes, kind, skill_snapshot_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.clearPendingSnapshotCreateRollbacksBySessionStmt = this.db.prepare(
      `DELETE FROM pending_internal_snapshot_create_rollbacks
       WHERE workspace_id = ? AND session_id = ?`,
    );
    this.pendingSnapshotCreateRollbackWorkspacesStmt = this.db.prepare(
      `SELECT DISTINCT workspace_id
       FROM pending_internal_snapshot_create_rollbacks
       ORDER BY workspace_id ASC`,
    );
    this.pendingSnapshotCreateRollbacksByWorkspaceStmt = this.db.prepare(
      `SELECT *
       FROM pending_internal_snapshot_create_rollbacks
       WHERE workspace_id = ?
       ORDER BY session_id ASC, resource_id ASC`,
    );
    this.pendingSnapshotCreateRollbacksBySessionStmt = this.db.prepare(
      `SELECT *
       FROM pending_internal_snapshot_create_rollbacks
       WHERE workspace_id = ? AND session_id = ?
       ORDER BY resource_id ASC`,
    );
    this.recordPendingSnapshotCreateRollbackAttemptStmt = this.db.prepare(
      `UPDATE pending_internal_snapshot_create_rollbacks
       SET last_attempt_at = ?, attempt_count = attempt_count + 1, last_error = ?
       WHERE workspace_id = ? AND session_id = ? AND resource_id = ?`,
    );
    this.clearPendingSnapshotCreateRollbackStmt = this.db.prepare(
      `DELETE FROM pending_internal_snapshot_create_rollbacks
       WHERE workspace_id = ? AND session_id = ? AND resource_id = ?`,
    );
  }

  static open(path = ":memory:"): SqliteSessionStore {
    return new SqliteSessionStore(new DatabaseSync(path));
  }

  create(record: CreateSessionRecord): SessionRow {
    return this.createInTransaction(record);
  }

  createAndCompleteIdempotency(
    record: CreateSessionRecord,
    idempotency: CreateSessionIdempotencyCommit,
  ): SessionRow {
    return this.createInTransaction(record, idempotency);
  }

  private createInTransaction(
    record: CreateSessionRecord,
    idempotency?: CreateSessionIdempotencyCommit,
  ): SessionRow {
    const s = record.row;
    return this.withTransaction(() => {
      this.insertStmt.run(
        s.id,
        s.workspace_id,
        s.type,
        s.agent.id,
        s.agent.version,
        s.environment_id,
        JSON.stringify(s.vault_ids ?? []),
        s.status,
        s.title,
        JSON.stringify(s.metadata),
        s.created_at,
        s.updated_at,
        s.archived_at,
        s.usage,
      );
      for (const [position, resource] of s.resources.entries()) {
        this.insertResourceStmt.run(
          resource.id,
          s.workspace_id,
          s.id,
          resource.type,
          resource.file_id,
          resource.mount_path,
          position,
          resource.created_at,
          resource.updated_at,
        );
      }
      for (const snapshot of record.snapshots ?? []) {
        this.insertSnapshotStmt.run(
          snapshot.workspace_id,
          snapshot.session_id,
          snapshot.resource_id,
          snapshot.file_id,
          snapshot.mount_path,
          snapshot.snapshot_file_id,
          snapshot.sha256,
          snapshot.size_bytes,
          snapshot.kind,
          snapshot.skill_snapshot_id,
        );
      }
      for (const skill of record.skillSnapshots ?? []) {
        this.insertSkillSnapshotStmt.run(skill.workspace_id, skill.session_id, skill.skill_snapshot_id, skill.skill_id, skill.version, skill.name, skill.description);
      }
      idempotency?.complete();
      this.clearPendingSnapshotCreateRollbacksBySessionStmt.run(s.workspace_id, s.id);
      return s;
    });
  }

  retrieve(workspaceId: string, sessionId: string): SessionRow | undefined {
    const row = this.retrieveActiveStmt.get(
      workspaceId,
      sessionId,
    ) as unknown as SessionDbRow | undefined;
    return row ? this.deserialize(row) : undefined;
  }

  countActive(workspaceId: string): number {
    return (this.countActiveStmt.get(workspaceId) as { n: number }).n;
  }

  // Unscoped, for the /metrics gauge (0121 C2) — served by idx_sessions_live.
  countAllActive(): number {
    return (this.countAllActiveStmt.get() as { n: number }).n;
  }

  retrieveAny(workspaceId: string, sessionId: string): SessionRow | undefined {
    const row = this.retrieveAnyStmt.get(
      workspaceId,
      sessionId,
    ) as unknown as SessionDbRow | undefined;
    return row ? this.deserialize(row) : undefined;
  }

  archive(
    workspaceId: string,
    sessionId: string,
    archivedAt: string,
  ): SessionRow | undefined {
    this.archiveStmt.run(archivedAt, archivedAt, workspaceId, sessionId);
    return this.retrieveAny(workspaceId, sessionId);
  }

  delete(workspaceId: string, sessionId: string): SessionRow | undefined {
    const existing = this.retrieveAny(workspaceId, sessionId);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    return this.withTransaction(() => {
      this.insertPendingSnapshotDeletesStmt.run(now, workspaceId, sessionId);
      this.deleteSnapshotsStmt.run(workspaceId, sessionId);
      this.db.prepare("DELETE FROM session_skill_snapshots WHERE workspace_id=? AND session_id=?").run(workspaceId, sessionId);
      this.deleteResourcesStmt.run(workspaceId, sessionId);
      this.deleteStmt.run(workspaceId, sessionId);
      return existing;
    });
  }

  withTransaction<T>(fn: () => T): T {
    return withSqliteTransaction(this.db, fn);
  }

  getFileMountSnapshots(
    workspaceId: string,
    sessionId: string,
  ): SessionFileMountSnapshotRow[] {
    return this.snapshotsBySessionStmt.all(
      workspaceId,
      sessionId,
    ) as unknown as SessionFileMountSnapshotRow[];
  }

  getSkillSnapshots(workspaceId: string, sessionId: string): SessionSkillSnapshotRow[] {
    return this.skillSnapshotsBySessionStmt.all(workspaceId, sessionId) as unknown as SessionSkillSnapshotRow[];
  }

  listPendingInternalSnapshotDeleteWorkspaces(): string[] {
    const rows = this.pendingSnapshotDeleteWorkspacesStmt.all() as Array<{
      workspace_id: string;
    }>;
    return rows.map((row) => row.workspace_id);
  }

  getPendingInternalSnapshotDeletes(
    workspaceId: string,
    sessionId?: string,
  ): PendingInternalSnapshotDeleteRow[] {
    const rows =
      sessionId === undefined
        ? this.pendingSnapshotDeletesByWorkspaceStmt.all(workspaceId)
        : this.pendingSnapshotDeletesBySessionStmt.all(workspaceId, sessionId);
    return rows as unknown as PendingInternalSnapshotDeleteRow[];
  }

  recordPendingInternalSnapshotDeleteAttempt(
    workspaceId: string,
    sessionId: string,
    resourceId: string,
    attemptedAt: string,
    error: string,
  ): void {
    this.recordPendingSnapshotDeleteAttemptStmt.run(
      attemptedAt,
      error,
      workspaceId,
      sessionId,
      resourceId,
    );
  }

  clearPendingInternalSnapshotDelete(
    workspaceId: string,
    sessionId: string,
    resourceId: string,
  ): void {
    this.clearPendingSnapshotDeleteStmt.run(workspaceId, sessionId, resourceId);
  }

  recordPendingInternalSnapshotCreateRollback(
    row: SessionFileMountSnapshotRow,
    createdAt: string,
  ): void {
    this.insertPendingSnapshotCreateRollbackStmt.run(
      row.workspace_id,
      row.session_id,
      row.resource_id,
      row.file_id,
      row.mount_path,
      row.snapshot_file_id,
      row.sha256,
      row.size_bytes,
      row.kind,
      row.skill_snapshot_id,
      createdAt,
    );
  }

  listPendingInternalSnapshotCreateRollbackWorkspaces(): string[] {
    const rows = this.pendingSnapshotCreateRollbackWorkspacesStmt.all() as Array<{
      workspace_id: string;
    }>;
    return rows.map((row) => row.workspace_id);
  }

  getPendingInternalSnapshotCreateRollbacks(
    workspaceId: string,
    sessionId?: string,
  ): PendingInternalSnapshotCreateRollbackRow[] {
    const rows =
      sessionId === undefined
        ? this.pendingSnapshotCreateRollbacksByWorkspaceStmt.all(workspaceId)
        : this.pendingSnapshotCreateRollbacksBySessionStmt.all(
            workspaceId,
            sessionId,
          );
    return rows as unknown as PendingInternalSnapshotCreateRollbackRow[];
  }

  recordPendingInternalSnapshotCreateRollbackAttempt(
    workspaceId: string,
    sessionId: string,
    resourceId: string,
    attemptedAt: string,
    error: string,
  ): void {
    this.recordPendingSnapshotCreateRollbackAttemptStmt.run(
      attemptedAt,
      error,
      workspaceId,
      sessionId,
      resourceId,
    );
  }

  clearPendingInternalSnapshotCreateRollback(
    workspaceId: string,
    sessionId: string,
    resourceId: string,
  ): void {
    this.clearPendingSnapshotCreateRollbackStmt.run(
      workspaceId,
      sessionId,
      resourceId,
    );
  }

  list(
    workspaceId: string,
    opts: ListSessionsOptions = {},
  ): SessionListPage<SessionRow> {
    if (opts.page === "") {
      return { data: [], next_page: null, prev_page: null };
    }
    const limit = normalizeLimit(opts.limit);
    const order = opts.order ?? "desc";
    const includeArchived = opts.includeArchived ?? false;
    const cursor = opts.page === undefined
      ? undefined
      : decodeSessionCursor(opts.page, { order, agentId: opts.agentId, includeArchived });
    const direction = cursor?.direction ?? "next";
    const queryOrder = direction === "prev"
      ? (order === "asc" ? "desc" : "asc")
      : order;
    const stmt = this.listStmt({
      includeArchived,
      hasAgent: opts.agentId !== undefined,
      hasPage: cursor !== undefined,
      order: queryOrder,
    });
    const rows = stmt.all(
      ...selectListArgs(workspaceId, limit + 1, opts.agentId, cursor?.anchor),
    ) as unknown as SessionDbRow[];
    const hasMoreInQueryDirection = rows.length > limit;
    const selected = rows.slice(0, limit);
    if (direction === "prev") selected.reverse();
    const data = selected.map((row) => this.deserialize(row));
    const hasNext = direction === "prev" ? cursor !== undefined : hasMoreInQueryDirection;
    const hasPrev = direction === "prev" ? hasMoreInQueryDirection : cursor !== undefined;
    const context = { order, agentId: opts.agentId, includeArchived };
    return {
      data,
      next_page: hasNext && data.length > 0
        ? encodeSessionCursor(data[data.length - 1]!.id, "next", context)
        : null,
      prev_page: hasPrev && data.length > 0
        ? encodeSessionCursor(data[0]!.id, "prev", context)
        : null,
    };
  }

  close(): void {
    this.db.close();
  }

  private listStmt(opts: {
    includeArchived: boolean;
    hasAgent: boolean;
    hasPage: boolean;
    order: "asc" | "desc";
  }): StatementSync {
    const key = JSON.stringify(opts);
    const existing = this.listStmts.get(key);
    if (existing) return existing;

    const predicates = ["workspace_id = ?"];
    if (opts.hasAgent) predicates.push("agent_id = ?");
    if (!opts.includeArchived) predicates.push("archived_at IS NULL");
    if (opts.hasPage) predicates.push(opts.order === "asc" ? "id > ?" : "id < ?");

    const stmt = this.db.prepare(
      `SELECT * FROM sessions
       WHERE ${predicates.join(" AND ")}
       ORDER BY id ${opts.order.toUpperCase()}
       LIMIT ?`,
    );
    this.listStmts.set(key, stmt);
    return stmt;
  }

  private deserialize(row: SessionDbRow): SessionRow {
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      type: "session",
      agent: {
        type: "agent",
        id: row.agent_id,
        version: row.agent_version,
      },
      environment_id: row.environment_id,
      vault_ids: parseVaultIds(row.vault_ids),
      status: row.status,
      title: row.title,
      metadata: JSON.parse(row.metadata) as Record<string, string>,
      created_at: row.created_at,
      updated_at: row.updated_at,
      archived_at: row.archived_at,
      // B.1 has no runtime usage source yet; Cycle C/D should deserialize this column.
      usage: null,
      resources: this.resourcesBySessionStmt.all(
        row.workspace_id,
        row.id,
      ) as unknown as SessionRow["resources"],
    };
  }
}

function ensureVaultIdsColumn(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === "vault_ids")) return;
  db.exec("ALTER TABLE sessions ADD COLUMN vault_ids TEXT NOT NULL DEFAULT '[]'");
}

function ensureSnapshotColumns(db: DatabaseSync): void {
  for (const table of [
    "session_file_mount_snapshots",
    "pending_internal_snapshot_deletes",
    "pending_internal_snapshot_create_rollbacks",
  ]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "kind")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN kind TEXT NOT NULL DEFAULT 'upload'`);
    }
    if (!columns.some((column) => column.name === "skill_snapshot_id")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN skill_snapshot_id TEXT`);
    }
  }
}

function parseVaultIds(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
    ? [...parsed]
    : [];
}

interface SessionCursorContext {
  order: "asc" | "desc";
  agentId: string | undefined;
  includeArchived: boolean;
}

interface SessionCursorPayload {
  v: 1;
  anchor: string;
  direction: "next" | "prev";
  order: "asc" | "desc";
  agentId: string | null;
  includeArchived: boolean;
}

function encodeSessionCursor(
  anchor: string,
  direction: "next" | "prev",
  context: SessionCursorContext,
): string {
  const payload: SessionCursorPayload = {
    v: 1,
    anchor,
    direction,
    order: context.order,
    agentId: context.agentId ?? null,
    includeArchived: context.includeArchived,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeSessionCursor(
  value: string,
  context: SessionCursorContext,
): SessionCursorPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalidRequest("invalid page cursor");
  }
  if (!isSessionCursorPayload(payload)) throw invalidRequest("invalid page cursor");
  if (payload.order !== context.order) {
    throw invalidRequest("page token order does not match request");
  }
  if (
    payload.agentId !== (context.agentId ?? null) ||
    payload.includeArchived !== context.includeArchived
  ) {
    throw invalidRequest("page token filters do not match request");
  }
  return payload;
}

function isSessionCursorPayload(value: unknown): value is SessionCursorPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Partial<SessionCursorPayload>;
  return payload.v === 1 &&
    typeof payload.anchor === "string" && payload.anchor.length > 0 &&
    (payload.direction === "next" || payload.direction === "prev") &&
    (payload.order === "asc" || payload.order === "desc") &&
    (payload.agentId === null || typeof payload.agentId === "string") &&
    typeof payload.includeArchived === "boolean";
}

function selectListArgs(
  workspaceId: string,
  limit: number,
  agentId: string | undefined,
  page: string | undefined,
): [string, number] | [string, string, number] | [string, string, string, number] {
  if (agentId === undefined && page === undefined) return [workspaceId, limit];
  if (agentId !== undefined && page === undefined) {
    return [workspaceId, agentId, limit];
  }
  if (agentId === undefined && page !== undefined) {
    return [workspaceId, page, limit];
  }
  return [workspaceId, agentId as string, page as string, limit];
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isSafeInteger(limit) || limit <= 0) return 20;
  return Math.min(limit, 100);
}
