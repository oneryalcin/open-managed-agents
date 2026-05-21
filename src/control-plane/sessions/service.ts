import type { ManagedAgentsListPage } from "../../types/common.ts";
import type {
  CreateManagedSessionAgentInput,
  CreateManagedSessionRequest,
  ManagedAgentsSession,
} from "../../types/sessions.ts";
import { isJsonObject } from "../../types/json.ts";
import type { AgentStore } from "../agents/types.ts";
import type { EnvironmentStore } from "../environments/types.ts";
import { invalidRequest, notFound } from "../errors.ts";
import { newSessionId } from "../ids.ts";
import type { WorkspaceId } from "../workspace.ts";
import type {
  ListSessionsOptions,
  SessionRow,
  SessionService,
  SessionStore,
} from "./types.ts";

export class DefaultSessionService implements SessionService {
  constructor(
    private readonly store: SessionStore,
    private readonly agents: AgentStore,
    private readonly environments: EnvironmentStore,
  ) {}

  create(
    workspaceId: WorkspaceId,
    input: unknown,
  ): ManagedAgentsSession {
    const req = parseCreateSession(input);
    const agentId = parseAgentId(req.agent);
    const agent = this.agents.retrieve(workspaceId, agentId);
    if (!agent) {
      throw invalidRequest(`Agent ${agentId} not found`);
    }
    const environment = this.environments.retrieve(workspaceId, req.environment_id);
    if (!environment) {
      throw invalidRequest(`Environment ${req.environment_id} not found`);
    }

    const now = new Date().toISOString();
    const row: SessionRow = {
      id: newSessionId(),
      workspace_id: workspaceId,
      type: "session",
      agent: {
        type: "agent",
        id: agent.id,
        version: agent.version,
      },
      environment_id: environment.id,
      status: "idle",
      title: req.title ?? null,
      metadata: req.metadata ?? {},
      created_at: now,
      updated_at: now,
      archived_at: null,
      usage: null,
    };
    return toManagedSession(this.store.create({ row }));
  }

  retrieve(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): ManagedAgentsSession {
    const row = this.store.retrieve(workspaceId, sessionId);
    if (!row) {
      throw notFound(`Session ${sessionId} not found`);
    }
    return toManagedSession(row);
  }

  list(
    workspaceId: WorkspaceId,
    opts: ListSessionsOptions = {},
  ): ManagedAgentsListPage<ManagedAgentsSession> {
    const page = this.store.list(workspaceId, opts);
    return {
      data: page.data.map(toManagedSession),
      has_more: page.has_more,
      next_page: page.next_page,
    };
  }
}

function parseCreateSession(input: unknown): CreateManagedSessionRequest {
  const obj = objectInput(input);
  rejectUnsupportedField(obj, "resources");
  rejectUnsupportedField(obj, "vault_ids");
  return {
    agent: agentField(obj),
    environment_id: stringField(obj, "environment_id", { required: true }),
    title: nullableStringField(obj, "title") ?? undefined,
    metadata: metadataField(obj) ?? undefined,
  };
}

function parseAgentId(agent: CreateManagedSessionAgentInput): string {
  if (typeof agent === "string") return agent;
  return agent.id;
}

function toManagedSession(row: SessionRow): ManagedAgentsSession {
  return {
    id: row.id,
    type: row.type,
    agent: row.agent,
    environment_id: row.environment_id,
    status: row.status,
    title: row.title,
    metadata: row.metadata,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
    usage: row.usage,
  };
}

function rejectUnsupportedField(obj: Record<string, unknown>, field: string): void {
  if (obj[field] !== undefined) {
    throw invalidRequest(`Field \`${field}\` is not yet supported by this server.`);
  }
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!isJsonObject(input)) {
    throw invalidRequest("Request body must be a JSON object");
  }
  return input;
}

function agentField(obj: Record<string, unknown>): CreateManagedSessionAgentInput {
  const value = obj.agent;
  if (typeof value === "string" && value.length > 0) return value;
  if (isJsonObject(value)) {
    const type = stringField(value, "type", { required: true });
    if (type !== "agent") {
      throw invalidRequest("`agent.type` must be `agent`");
    }
    const version = value.version;
    if (version !== undefined) {
      if (
        typeof version !== "number" ||
        !Number.isSafeInteger(version) ||
        version <= 0
      ) {
        throw invalidRequest("`agent.version` must be a positive integer");
      }
      return {
        type,
        id: stringField(value, "id", { required: true }),
        version,
      };
    }
    return {
      type,
      id: stringField(value, "id", { required: true }),
    };
  }
  throw invalidRequest("`agent` must be a non-empty string or agent object");
}

function stringField(
  obj: Record<string, unknown>,
  field: string,
  opts: { required?: boolean } = {},
): string {
  const value = obj[field];
  if (typeof value === "string" && value.length > 0) return value;
  if (value === undefined && opts.required !== true) return "";
  throw invalidRequest(`\`${field}\` must be a non-empty string`);
}

function nullableStringField(
  obj: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw invalidRequest(`\`${field}\` must be a string or null`);
}

function metadataField(
  obj: Record<string, unknown>,
): Record<string, string> | undefined {
  const value = obj.metadata;
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    throw invalidRequest("`metadata` must be an object");
  }
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      throw invalidRequest("`metadata` values must be strings");
    }
    metadata[k] = v;
  }
  return metadata;
}
