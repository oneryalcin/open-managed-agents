import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ManagedAgentsListPage } from "../../types/common.ts";
import type {
  CreateEnvironmentRecord,
  EnvironmentRow,
  EnvironmentStore,
  ListEnvironmentsOptions,
} from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS environments (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  type          TEXT NOT NULL,
  name          TEXT NOT NULL,
  config        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  archived_at   TEXT
);
CREATE INDEX IF NOT EXISTS environments_by_workspace ON environments (workspace_id, id);
`;

interface EnvironmentDbRow {
  id: string;
  workspace_id: string;
  type: "environment";
  name: string;
  config: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export class SqliteEnvironmentStore implements EnvironmentStore {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly retrieveActiveStmt: StatementSync;
  private readonly listActiveStmt: StatementSync;
  private readonly listAllStmt: StatementSync;
  private readonly listActiveSinceStmt: StatementSync;
  private readonly listAllSinceStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    this.insertStmt = this.db.prepare(
      `INSERT INTO environments (
        id, workspace_id, type, name, config, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.retrieveActiveStmt = this.db.prepare(
      `SELECT * FROM environments
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
    );
    this.listActiveStmt = this.db.prepare(
      `SELECT * FROM environments
       WHERE workspace_id = ? AND archived_at IS NULL
       ORDER BY id ASC
       LIMIT ?`,
    );
    this.listAllStmt = this.db.prepare(
      `SELECT * FROM environments
       WHERE workspace_id = ?
       ORDER BY id ASC
       LIMIT ?`,
    );
    this.listActiveSinceStmt = this.db.prepare(
      `SELECT * FROM environments
       WHERE workspace_id = ? AND id > ? AND archived_at IS NULL
       ORDER BY id ASC
       LIMIT ?`,
    );
    this.listAllSinceStmt = this.db.prepare(
      `SELECT * FROM environments
       WHERE workspace_id = ? AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
    );
  }

  static open(path = ":memory:"): SqliteEnvironmentStore {
    return new SqliteEnvironmentStore(new DatabaseSync(path));
  }

  create(record: CreateEnvironmentRecord): EnvironmentRow {
    const e = record.row;
    this.insertStmt.run(
      e.id,
      e.workspace_id,
      e.type,
      e.name,
      JSON.stringify(e.config),
      e.created_at,
      e.updated_at,
      e.archived_at,
    );
    return e;
  }

  retrieve(
    workspaceId: string,
    environmentId: string,
  ): EnvironmentRow | undefined {
    const row = this.retrieveActiveStmt.get(
      workspaceId,
      environmentId,
    ) as unknown as EnvironmentDbRow | undefined;
    return row ? deserialize(row) : undefined;
  }

  list(
    workspaceId: string,
    opts: ListEnvironmentsOptions = {},
  ): ManagedAgentsListPage<EnvironmentRow> {
    if (opts.page === "") {
      return { data: [], has_more: false, next_page: null };
    }
    const limit = normalizeLimit(opts.limit);
    const queryLimit = limit + 1;
    const includeArchived = opts.includeArchived ?? false;
    const rows = this.listStmt(includeArchived, opts.page !== undefined).all(
      ...selectListArgs(workspaceId, queryLimit, opts.page),
    ) as unknown as EnvironmentDbRow[];
    const pageRows = rows.slice(0, limit);
    const data = pageRows.map(deserialize);
    return {
      data,
      has_more: rows.length > limit,
      next_page: rows.length > limit ? data[data.length - 1]?.id ?? null : null,
    };
  }

  close(): void {
    this.db.close();
  }

  private listStmt(includeArchived: boolean, hasPage: boolean): StatementSync {
    if (includeArchived) {
      return hasPage ? this.listAllSinceStmt : this.listAllStmt;
    }
    return hasPage ? this.listActiveSinceStmt : this.listActiveStmt;
  }
}

function selectListArgs(
  workspaceId: string,
  limit: number,
  page: string | undefined,
): [string, number] | [string, string, number] {
  return page === undefined ? [workspaceId, limit] : [workspaceId, page, limit];
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isSafeInteger(limit) || limit <= 0) return 20;
  return Math.min(limit, 100);
}

function deserialize(row: EnvironmentDbRow): EnvironmentRow {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    type: "environment",
    name: row.name,
    config: JSON.parse(row.config) as EnvironmentRow["config"],
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
}
