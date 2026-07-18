import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { withSqliteTransaction } from "../sqlite-transaction.ts";
import type {
  AgentStore,
  AgentRow,
  CreateAgentRecord,
  ListAgentVersionsOptions,
  ListAgentsOptions,
  UpdateAgentRecord,
} from "./types.ts";
import type {
  ManagedAgentsListPage,
  ManagedAgentsModelConfig,
} from "../../types/agents.ts";

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
CREATE TABLE IF NOT EXISTS agent_versions (
  workspace_id TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  version      INTEGER NOT NULL,
  name         TEXT NOT NULL,
  model        TEXT NOT NULL,
  system       TEXT,
  description  TEXT,
  tools        TEXT NOT NULL,
  skills       TEXT NOT NULL,
  mcp_servers  TEXT NOT NULL,
  metadata     TEXT NOT NULL,
  multiagent   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_id, version)
);
CREATE INDEX IF NOT EXISTS agent_versions_newest
  ON agent_versions (workspace_id, agent_id, version DESC);
`;

interface AgentVersionDbRow {
  workspace_id: string;
  agent_id: string;
  version: number;
  name: string;
  model: string;
  system: string | null;
  description: string | null;
  tools: string;
  skills: string;
  mcp_servers: string;
  metadata: string;
  multiagent: string | null;
  created_at: string;
  updated_at: string;
}

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
  private readonly cursorSigningKey = randomBytes(32);
  private readonly insertStmt: StatementSync;
  private readonly insertVersionStmt: StatementSync;
  private readonly updateHeadStmt: StatementSync;
  private readonly retrieveVersionStmt: StatementSync;
  private readonly listVersionsFirstStmt: StatementSync;
  private readonly listVersionsAfterStmt: StatementSync;
  private readonly retrieveActiveStmt: StatementSync;
  private readonly retrieveAnyStmt: StatementSync;
  private readonly archiveStmt: StatementSync;
  private readonly listActiveStmt: StatementSync;
  private readonly listAllStmt: StatementSync;
  private readonly listActiveSinceStmt: StatementSync;
  private readonly listAllSinceStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    withSqliteTransaction(this.db, () => {
      migratePersistedModels(this.db);
      this.db.exec(`INSERT OR IGNORE INTO agent_versions (
        workspace_id, agent_id, version, name, model, system, description,
        tools, skills, mcp_servers, metadata, multiagent, created_at, updated_at
      ) SELECT workspace_id, id, version, name, model, system, description,
        tools, skills, mcp_servers, metadata, multiagent, created_at, updated_at
        FROM agents`);
      assertAllPersistedModelsNormalized(this.db);
    });
    this.insertStmt = this.db.prepare(
      `INSERT INTO agents (
        id, workspace_id, type, name, model, system, description, tools, skills,
        mcp_servers, metadata, multiagent, version, created_at, updated_at,
        archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertVersionStmt = this.db.prepare(
      `INSERT INTO agent_versions (
        workspace_id, agent_id, version, name, model, system, description,
        tools, skills, mcp_servers, metadata, multiagent, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateHeadStmt = this.db.prepare(
      `UPDATE agents SET
        name = ?, model = ?, system = ?, description = ?, tools = ?, skills = ?,
        mcp_servers = ?, metadata = ?, multiagent = ?, version = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND version = ? AND archived_at IS NULL`,
    );
    this.retrieveVersionStmt = this.db.prepare(
      `SELECT * FROM agent_versions
       WHERE workspace_id = ? AND agent_id = ? AND version = ?`,
    );
    this.listVersionsFirstStmt = this.db.prepare(
      `SELECT * FROM agent_versions
       WHERE workspace_id = ? AND agent_id = ?
       ORDER BY version DESC LIMIT ?`,
    );
    this.listVersionsAfterStmt = this.db.prepare(
      `SELECT * FROM agent_versions
       WHERE workspace_id = ? AND agent_id = ? AND version < ?
       ORDER BY version DESC LIMIT ?`,
    );
    this.retrieveActiveStmt = this.db.prepare(
      `SELECT * FROM agents
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
    );
    this.retrieveAnyStmt = this.db.prepare(
      `SELECT * FROM agents
       WHERE workspace_id = ? AND id = ?`,
    );
    this.archiveStmt = this.db.prepare(
      `UPDATE agents
       SET archived_at = COALESCE(archived_at, ?),
           updated_at = CASE WHEN archived_at IS NULL THEN ? ELSE updated_at END
       WHERE workspace_id = ? AND id = ?`,
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
    return withSqliteTransaction(this.db, () => {
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
      this.insertVersion(a);
      return a;
    });
  }

  update(record: UpdateAgentRecord): AgentRow {
    const next = record.row;
    return withSqliteTransaction(this.db, () => {
      const current = this.retrieveAny(next.workspace_id, next.id);
      if (!current) throw new AgentUpdateMissingError();
      if (current.archived_at !== null) throw new AgentUpdateArchivedError();
      if (current.version !== record.expectedVersion) {
        throw new AgentUpdateConflictError();
      }
      if (next.version !== current.version + 1) {
        throw new Error("Agent update must allocate exactly one version");
      }
      this.insertVersion(next);
      const result = this.updateHeadStmt.run(
        next.name,
        JSON.stringify(next.model),
        next.system,
        next.description,
        JSON.stringify(next.tools),
        JSON.stringify(next.skills),
        JSON.stringify(next.mcp_servers),
        JSON.stringify(next.metadata),
        next.multiagent === null ? null : JSON.stringify(next.multiagent),
        next.version,
        next.updated_at,
        next.workspace_id,
        next.id,
        record.expectedVersion,
      );
      if (result.changes !== 1) throw new AgentUpdateConflictError();
      return next;
    });
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

  retrieveAny(
    workspaceId: string,
    agentId: string,
  ): AgentRow | undefined {
    const row = this.retrieveAnyStmt.get(
      workspaceId,
      agentId,
    ) as unknown as AgentDbRow | undefined;
    return row ? deserialize(row) : undefined;
  }

  retrieveVersion(
    workspaceId: string,
    agentId: string,
    version: number,
  ): AgentRow | undefined {
    const owner = this.retrieveAny(workspaceId, agentId);
    if (!owner) return undefined;
    const row = this.retrieveVersionStmt.get(
      workspaceId,
      agentId,
      version,
    ) as unknown as AgentVersionDbRow | undefined;
    return row ? deserializeVersion(row, owner.archived_at) : undefined;
  }

  listVersions(
    workspaceId: string,
    agentId: string,
    opts: ListAgentVersionsOptions = {},
  ): { data: AgentRow[]; next_page: string | null } {
    const owner = this.retrieveAny(workspaceId, agentId);
    if (!owner) throw new AgentUpdateMissingError();
    const limit = normalizeLimit(opts.limit);
    const anchor = opts.page === undefined
      ? undefined
      : decodeVersionCursor(
        opts.page,
        workspaceId,
        agentId,
        this.cursorSigningKey,
      );
    const rows = (anchor === undefined
      ? this.listVersionsFirstStmt.all(workspaceId, agentId, limit + 1)
      : this.listVersionsAfterStmt.all(workspaceId, agentId, anchor, limit + 1)
    ) as unknown as AgentVersionDbRow[];
    const selected = rows.slice(0, limit);
    const data = selected.map((row) => deserializeVersion(row, owner.archived_at));
    return {
      data,
      next_page: rows.length > limit && data.length > 0
        ? encodeVersionCursor(
          data[data.length - 1]!.version,
          workspaceId,
          agentId,
          this.cursorSigningKey,
        )
        : null,
    };
  }

  archive(
    workspaceId: string,
    agentId: string,
    archivedAt: string,
  ): AgentRow | undefined {
    this.archiveStmt.run(archivedAt, archivedAt, workspaceId, agentId);
    return this.retrieveAny(workspaceId, agentId);
  }

  list(
    workspaceId: string,
    opts: ListAgentsOptions = {},
  ): ManagedAgentsListPage<AgentRow> {
    if (opts.page === "") {
      return { data: [], has_more: false, next_page: null };
    }
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

  private insertVersion(row: AgentRow): void {
    this.insertVersionStmt.run(
      row.workspace_id,
      row.id,
      row.version,
      row.name,
      JSON.stringify(row.model),
      row.system,
      row.description,
      JSON.stringify(row.tools),
      JSON.stringify(row.skills),
      JSON.stringify(row.mcp_servers),
      JSON.stringify(row.metadata),
      row.multiagent === null ? null : JSON.stringify(row.multiagent),
      row.created_at,
      row.updated_at,
    );
  }

  private listStmt(includeArchived: boolean, hasPage: boolean): StatementSync {
    if (includeArchived) {
      return hasPage ? this.listAllSinceStmt : this.listAllStmt;
    }
    return hasPage ? this.listActiveSinceStmt : this.listActiveStmt;
  }
}

export class AgentUpdateMissingError extends Error {}
export class AgentUpdateArchivedError extends Error {}
export class AgentUpdateConflictError extends Error {}

interface AgentVersionCursor {
  v: 1;
  anchor: number;
  agentId: string;
}

function encodeVersionCursor(
  anchor: number,
  workspaceId: string,
  agentId: string,
  signingKey: Buffer,
): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, anchor, agentId }), "utf8")
    .toString("base64url");
  const signature = signVersionCursor(payload, workspaceId, signingKey);
  return `${payload}.${signature.toString("base64url")}`;
}

function decodeVersionCursor(
  cursor: string,
  workspaceId: string,
  agentId: string,
  signingKey: Buffer,
): number {
  try {
    const parts = cursor.split(".");
    if (parts.length !== 2) throw new Error("invalid cursor");
    const payloadBytes = decodeCanonicalBase64url(parts[0]!);
    const signature = decodeCanonicalBase64url(parts[1]!);
    const expected = signVersionCursor(parts[0]!, workspaceId, signingKey);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw new Error("invalid signature");
    }
    const parsed = JSON.parse(payloadBytes.toString("utf8")) as Partial<AgentVersionCursor>;
    if (
      parsed.v !== 1 ||
      !Number.isSafeInteger(parsed.anchor) ||
      (parsed.anchor ?? 0) <= 0 ||
      parsed.agentId !== agentId
    ) throw new Error("invalid payload");
    return parsed.anchor!;
  } catch {
    throw new Error("invalid page cursor");
  }
}

function signVersionCursor(payload: string, workspaceId: string, key: Buffer): Buffer {
  return createHmac("sha256", key)
    .update("oma-agent-versions-page-v1\0", "utf8")
    .update(workspaceId, "utf8")
    .update("\0", "utf8")
    .update(payload, "utf8")
    .digest();
}

function decodeCanonicalBase64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("invalid base64url");
  return decoded;
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

interface PersistedModelRow {
  workspace_id: string;
  id: string;
  version: number;
  model: string;
}

function migratePersistedModels(db: DatabaseSync): void {
  const updateHead = db.prepare(
    "UPDATE agents SET model = ? WHERE workspace_id = ? AND id = ?",
  );
  const updateVersion = db.prepare(
    `UPDATE agent_versions SET model = ?
     WHERE workspace_id = ? AND agent_id = ? AND version = ?`,
  );
  const heads = db.prepare(
    "SELECT workspace_id, id, version, model FROM agents",
  ).all() as unknown as PersistedModelRow[];
  for (const row of heads) {
    const parsed = parsePersistedModel(row.model, `agent ${row.id}`);
    if (parsed.legacy) {
      updateHead.run(JSON.stringify(parsed.model), row.workspace_id, row.id);
    }
  }

  const versions = db.prepare(
    `SELECT workspace_id, agent_id AS id, version, model
     FROM agent_versions`,
  ).all() as unknown as PersistedModelRow[];
  for (const row of versions) {
    const parsed = parsePersistedModel(
      row.model,
      `agent version ${row.id}@${row.version}`,
    );
    if (parsed.legacy) {
      updateVersion.run(
        JSON.stringify(parsed.model),
        row.workspace_id,
        row.id,
        row.version,
      );
    }
  }
}

function assertAllPersistedModelsNormalized(db: DatabaseSync): void {
  const heads = db.prepare(
    "SELECT workspace_id, id, version, model FROM agents",
  ).all() as unknown as PersistedModelRow[];
  const versions = db.prepare(
    `SELECT workspace_id, agent_id AS id, version, model FROM agent_versions`,
  ).all() as unknown as PersistedModelRow[];
  const rows = [...heads, ...versions];
  for (const row of rows) {
    const parsed = parsePersistedModel(
      row.model,
      `agent revision ${row.id}@${row.version}`,
    );
    if (parsed.legacy) {
      throw new Error(`Agent model migration left a legacy row: ${row.id}@${row.version}`);
    }
  }
}

function parsePersistedModel(
  raw: string,
  location: string,
): { model: ManagedAgentsModelConfig; legacy: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid persisted model JSON for ${location}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid persisted model for ${location}`);
  }
  const model = value as Record<string, unknown>;
  const legacy = model.provider === undefined;
  const allowedKeys = legacy
    ? new Set(["id", "speed"])
    : new Set(["provider", "id", "speed"]);
  if (Object.keys(model).some((key) => !allowedKeys.has(key))) {
    throw new Error(`Invalid persisted model fields for ${location}`);
  }
  if (typeof model.id !== "string" || model.id.length === 0) {
    throw new Error(`Invalid persisted model id for ${location}`);
  }
  if (model.speed !== "standard" && model.speed !== "fast") {
    throw new Error(`Invalid persisted model speed for ${location}`);
  }
  if (!legacy && (typeof model.provider !== "string" || model.provider.length === 0)) {
    throw new Error(`Invalid persisted model provider for ${location}`);
  }
  return {
    model: {
      provider: legacy ? "anthropic" : model.provider as string,
      id: model.id,
      speed: model.speed,
    },
    legacy,
  };
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

function deserializeVersion(
  row: AgentVersionDbRow,
  archivedAt: string | null,
): AgentRow {
  return {
    id: row.agent_id,
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
    multiagent: row.multiagent === null
      ? null
      : JSON.parse(row.multiagent) as AgentRow["multiagent"],
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: archivedAt,
  };
}
