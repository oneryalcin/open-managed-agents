import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ManagedAgentsListPage } from "../../types/common.ts";
import type {
  CreateSessionRecord,
  ListSessionsOptions,
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
`;

interface SessionDbRow {
  id: string;
  workspace_id: string;
  type: "session";
  agent_id: string;
  agent_version: number;
  environment_id: string;
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
  private readonly retrieveActiveStmt: StatementSync;
  private readonly listStmts: Map<string, StatementSync> = new Map();

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    this.insertStmt = this.db.prepare(
      `INSERT INTO sessions (
        id, workspace_id, type, agent_id, agent_version, environment_id,
        status, title, metadata, created_at, updated_at, archived_at, usage
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.retrieveActiveStmt = this.db.prepare(
      `SELECT * FROM sessions
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
    );
  }

  static open(path = ":memory:"): SqliteSessionStore {
    return new SqliteSessionStore(new DatabaseSync(path));
  }

  create(record: CreateSessionRecord): SessionRow {
    const s = record.row;
    this.insertStmt.run(
      s.id,
      s.workspace_id,
      s.type,
      s.agent.id,
      s.agent.version,
      s.environment_id,
      s.status,
      s.title,
      JSON.stringify(s.metadata),
      s.created_at,
      s.updated_at,
      s.archived_at,
      s.usage,
    );
    return s;
  }

  retrieve(workspaceId: string, sessionId: string): SessionRow | undefined {
    const row = this.retrieveActiveStmt.get(
      workspaceId,
      sessionId,
    ) as unknown as SessionDbRow | undefined;
    return row ? deserialize(row) : undefined;
  }

  list(
    workspaceId: string,
    opts: ListSessionsOptions = {},
  ): ManagedAgentsListPage<SessionRow> {
    if (opts.page === "") {
      return { data: [], has_more: false, next_page: null };
    }
    const limit = normalizeLimit(opts.limit);
    const order = opts.order ?? "desc";
    const queryLimit = limit + 1;
    const stmt = this.listStmt({
      includeArchived: opts.includeArchived ?? false,
      hasAgent: opts.agentId !== undefined,
      hasPage: opts.page !== undefined,
      order,
    });
    const rows = stmt.all(
      ...selectListArgs(workspaceId, queryLimit, opts.agentId, opts.page),
    ) as unknown as SessionDbRow[];
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

function deserialize(row: SessionDbRow): SessionRow {
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
    status: row.status,
    title: row.title,
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
    // B.1 has no runtime usage source yet; Cycle C/D should deserialize this column.
    usage: null,
  };
}
