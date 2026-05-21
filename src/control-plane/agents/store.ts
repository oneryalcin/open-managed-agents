import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  AgentStore,
  AgentRow,
  CreateAgentRecord,
  ListAgentsOptions,
} from "./types.ts";
import type { ManagedAgentsListPage } from "../../types/agents.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  model        TEXT NOT NULL,
  system       TEXT,
  description  TEXT,
  tools        TEXT NOT NULL,
  skills       TEXT NOT NULL,
  mcp_servers  TEXT NOT NULL,
  metadata     TEXT NOT NULL,
  multiagent   TEXT,
  version      INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived_at  TEXT
);
CREATE INDEX IF NOT EXISTS agents_by_workspace ON agents (workspace_id, id);
`;

interface AgentDbRow {
  id: string;
  workspace_id: string;
  type: "agent";
  name: string;
  model: string;
  system: string | null;
  description: string | null;
  tools: string;
  skills: string;
  mcp_servers: string;
  metadata: string;
  multiagent: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export class SqliteAgentStore implements AgentStore {
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
      `INSERT INTO agents (
        id, workspace_id, type, name, model, system, description, tools, skills,
        mcp_servers, metadata, multiagent, version, created_at, updated_at,
        archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.retrieveActiveStmt = this.db.prepare(
      `SELECT * FROM agents
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
    );
    this.listActiveStmt = this.db.prepare(
      `SELECT * FROM agents
       WHERE workspace_id = ? AND archived_at IS NULL
       ORDER BY id ASC
       LIMIT ?`,
    );
    this.listAllStmt = this.db.prepare(
      `SELECT * FROM agents
       WHERE workspace_id = ?
       ORDER BY id ASC
       LIMIT ?`,
    );
    this.listActiveSinceStmt = this.db.prepare(
      `SELECT * FROM agents
       WHERE workspace_id = ? AND id > ? AND archived_at IS NULL
       ORDER BY id ASC
       LIMIT ?`,
    );
    this.listAllSinceStmt = this.db.prepare(
      `SELECT * FROM agents
       WHERE workspace_id = ? AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
    );
  }

  static open(path = ":memory:"): SqliteAgentStore {
    return new SqliteAgentStore(new DatabaseSync(path));
  }

  create(record: CreateAgentRecord): AgentRow {
    const a = record.row;
    this.insertStmt.run(
      a.id,
      a.workspace_id,
      a.type,
      a.name,
      JSON.stringify(a.model),
      a.system,
      a.description,
      JSON.stringify(a.tools),
      JSON.stringify(a.skills),
      JSON.stringify(a.mcp_servers),
      JSON.stringify(a.metadata),
      a.multiagent === null ? null : JSON.stringify(a.multiagent),
      a.version,
      a.created_at,
      a.updated_at,
      a.archived_at,
    );
    return a;
  }

  retrieve(
    workspaceId: string,
    agentId: string,
  ): AgentRow | undefined {
    const row = this.retrieveActiveStmt.get(
      workspaceId,
      agentId,
    ) as unknown as AgentDbRow | undefined;
    return row ? deserialize(row) : undefined;
  }

  list(
    workspaceId: string,
    opts: ListAgentsOptions = {},
  ): ManagedAgentsListPage<AgentRow> {
    const limit = normalizeLimit(opts.limit);
    const queryLimit = limit + 1;
    const includeArchived = opts.includeArchived ?? false;
    const rows = this.listStmt(includeArchived, opts.page !== undefined).all(
      ...selectListArgs(workspaceId, queryLimit, opts.page),
    ) as unknown as AgentDbRow[];
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

function deserialize(row: AgentDbRow): AgentRow {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    type: "agent",
    name: row.name,
    model: JSON.parse(row.model) as AgentRow["model"],
    system: row.system,
    description: row.description,
    tools: JSON.parse(row.tools) as AgentRow["tools"],
    skills: JSON.parse(row.skills) as AgentRow["skills"],
    mcp_servers: JSON.parse(row.mcp_servers) as AgentRow["mcp_servers"],
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    multiagent:
      row.multiagent === null
        ? null
        : (JSON.parse(row.multiagent) as AgentRow["multiagent"]),
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
}
