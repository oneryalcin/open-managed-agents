import { newAgentId } from "../ids.ts";
import { invalidRequest, notFound } from "../errors.ts";
import type {
  AgentService,
  AgentStore,
  CreateManagedAgentRequest,
  ListAgentsOptions,
  WorkspaceId,
} from "./types.ts";
import type {
  ManagedAgentsAgent,
  ManagedAgentsListPage,
  ManagedAgentsModel,
  ManagedAgentsModelConfig,
  ManagedAgentsMcpServer,
  ManagedAgentsMultiagent,
  ManagedAgentsPermissionPolicy,
  ManagedAgentsSkill,
  ManagedAgentsToolConfig,
  ManagedAgentsTool,
} from "../../types/agents.ts";
import { isJsonObject, isJsonValue, type JsonObject } from "../../types/json.ts";

export class DefaultAgentService implements AgentService {
  constructor(private readonly store: AgentStore) {}

  create(
    workspaceId: WorkspaceId,
    input: unknown,
  ): ManagedAgentsAgent {
    const req = parseCreateAgent(input);
    const now = new Date().toISOString();
    const id = newAgentId();
    const agent: ManagedAgentsAgent = {
      id,
      type: "agent",
      name: req.name,
      model: normalizeModel(req.model),
      system: req.system ?? null,
      description: req.description ?? null,
      tools: req.tools ?? [],
      skills: req.skills ?? [],
      mcp_servers: req.mcp_servers ?? [],
      metadata: req.metadata ?? {},
      multiagent: req.multiagent ?? null,
      version: 1,
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    return this.store.create({
      id,
      workspace_id: workspaceId,
      agent,
    });
  }

  retrieve(
    workspaceId: WorkspaceId,
    agentId: string,
  ): ManagedAgentsAgent {
    const agent = this.store.retrieve(workspaceId, agentId);
    if (!agent) {
      throw notFound(`Agent ${agentId} not found`);
    }
    return agent;
  }

  list(
    workspaceId: WorkspaceId,
    opts: ListAgentsOptions = {},
  ): ManagedAgentsListPage<ManagedAgentsAgent> {
    return this.store.list(workspaceId, opts);
  }
}

function parseCreateAgent(input: unknown): CreateManagedAgentRequest {
  const obj = objectInput(input);
  const name = stringField(obj, "name", { required: true });
  const system = nullableStringField(obj, "system");
  const description = nullableStringField(obj, "description");
  const model = modelField(obj);
  const tools = toolArrayField(obj, "tools");
  const skills = skillArrayField(obj, "skills");
  const mcpServers = mcpServerArrayField(obj, "mcp_servers");
  const metadata = metadataField(obj);
  const multiagent = multiagentField(obj);

  return {
    name,
    model,
    system,
    description,
    tools,
    skills,
    mcp_servers: mcpServers,
    metadata,
    multiagent,
  };
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!isJsonObject(input)) {
    throw invalidRequest("Request body must be a JSON object");
  }
  return input;
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

function modelField(obj: Record<string, unknown>): ManagedAgentsModel {
  const value = obj.model;
  if (typeof value === "string" && value.length > 0) return value;
  if (isJsonObject(value)) {
    const modelObj = value;
    const id = stringField(modelObj, "id", { required: true });
    const speed = modelObj.speed;
    if (
      speed !== undefined &&
      speed !== "standard" &&
      speed !== "fast"
    ) {
      throw invalidRequest("`model.speed` must be `standard` or `fast`");
    }
    return speed === undefined ? { id } : { id, speed };
  }
  throw invalidRequest("`model` must be a non-empty string or model object");
}

function toolArrayField(
  obj: Record<string, unknown>,
  field: string,
): ManagedAgentsTool[] | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalidRequest(`\`${field}\` must be an array`);
  return value.map(parseTool);
}

function parseTool(value: unknown): ManagedAgentsTool {
  const tool = jsonObjectField(value, "tools");
  const type = stringField(tool, "type", { required: true });
  if (type === "agent_toolset_20260401") {
    return {
      type,
      ...optionalDefaultConfigSpread(tool),
      ...optionalToolConfigsSpread(tool),
    };
  }
  if (type === "mcp_toolset") {
    return {
      type,
      mcp_server_name: stringField(tool, "mcp_server_name", {
        required: true,
      }),
      ...optionalDefaultConfigSpread(tool),
      ...optionalToolConfigsSpread(tool),
    };
  }
  if (type === "custom") {
    const inputSchema = jsonObjectRequired(tool, "input_schema");
    const description = optionalStringField(tool, "description");
    return description === undefined
      ? {
          type,
          name: stringField(tool, "name", { required: true }),
          input_schema: inputSchema,
        }
      : {
          type,
          name: stringField(tool, "name", { required: true }),
          description,
          input_schema: inputSchema,
        };
  }
  throw invalidRequest(
    "`tools[].type` must be `agent_toolset_20260401`, `mcp_toolset`, or `custom`",
  );
}

function skillArrayField(
  obj: Record<string, unknown>,
  field: string,
): ManagedAgentsSkill[] | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalidRequest(`\`${field}\` must be an array`);
  return value.map((v) => {
    const skill = jsonObjectField(v, field);
    const type = stringField(skill, "type", { required: true });
    const skillId = stringField(skill, "skill_id", { required: true });
    const version = optionalStringField(skill, "version");
    return version === undefined
      ? { type, skill_id: skillId }
      : { type, skill_id: skillId, version };
  });
}

function mcpServerArrayField(
  obj: Record<string, unknown>,
  field: string,
): ManagedAgentsMcpServer[] | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalidRequest(`\`${field}\` must be an array`);
  return value.map((v) => {
    const server = jsonObjectField(v, field);
    const type = stringField(server, "type", { required: true });
    if (type !== "url") {
      throw invalidRequest("Only url MCP server definitions are supported in MVP");
    }
    return {
      type,
      name: stringField(server, "name", { required: true }),
      url: stringField(server, "url", { required: true }),
    };
  });
}

function metadataField(
  obj: Record<string, unknown>,
): Record<string, string> | undefined {
  const value = obj.metadata;
  if (value === undefined) return undefined;
  if (
    !isJsonObject(value)
  ) {
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

function multiagentField(
  obj: Record<string, unknown>,
): ManagedAgentsMultiagent | null | undefined {
  const value = obj.multiagent;
  if (value === undefined) return undefined;
  if (value === null) return null;
  const multiagent = jsonObjectField(value, "multiagent");
  const type = stringField(multiagent, "type", { required: true });
  if (type !== "coordinator") {
    throw invalidRequest("`multiagent.type` must be `coordinator`");
  }
  const agents = multiagent.agents;
  if (!Array.isArray(agents)) {
    throw invalidRequest("`multiagent.agents` must be an array");
  }
  return {
    type,
    agents: agents.map((v) => {
      const agent = jsonObjectField(v, "multiagent.agents");
      const agentType = stringField(agent, "type", { required: true });
      if (agentType !== "agent") {
        throw invalidRequest("`multiagent.agents[].type` must be `agent`");
      }
      const version = agent.version;
      if (version !== undefined && typeof version !== "number") {
        throw invalidRequest("`multiagent.agents[].version` must be a number");
      }
      if (version !== undefined && (!Number.isSafeInteger(version) || version <= 0)) {
        throw invalidRequest("`multiagent.agents[].version` must be a positive integer");
      }
      return version === undefined
        ? {
            type: agentType,
            id: stringField(agent, "id", { required: true }),
          }
        : {
            type: agentType,
            id: stringField(agent, "id", { required: true }),
            version,
          };
    }),
  };
}

function optionalStringField(
  obj: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw invalidRequest(`\`${field}\` must be a string`);
}

function jsonObjectField(value: unknown, field: string): JsonObject {
  if (!isJsonObject(value)) {
    throw invalidRequest(`\`${field}\` entries must be JSON objects`);
  }
  if (!isJsonValue(value)) {
    throw invalidRequest(`\`${field}\` entries must be JSON-compatible`);
  }
  return value;
}

function jsonObjectRequired(
  obj: Record<string, unknown>,
  field: string,
): JsonObject {
  const value = obj[field];
  if (value === undefined) {
    throw invalidRequest(`\`${field}\` is required`);
  }
  return jsonObjectField(value, field);
}

function optionalDefaultConfigSpread(
  obj: Record<string, unknown>,
): {
  default_config?: {
    enabled?: boolean;
    permission_policy?: ManagedAgentsPermissionPolicy;
  };
} {
  const value = obj.default_config;
  if (value === undefined) return {};
  const config = jsonObjectField(value, "default_config");
  const enabled = config.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw invalidRequest("`default_config.enabled` must be a boolean");
  }
  const permissionPolicy =
    config.permission_policy === undefined
      ? undefined
      : parsePermissionPolicy(config.permission_policy);
  return {
    default_config: {
      ...(enabled === undefined ? {} : { enabled }),
      ...(permissionPolicy === undefined
        ? {}
        : { permission_policy: permissionPolicy }),
    },
  };
}

function optionalToolConfigsSpread(
  obj: Record<string, unknown>,
): { configs?: ManagedAgentsToolConfig[] } {
  const value = obj.configs;
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    throw invalidRequest("`configs` must be an array");
  }
  return {
    configs: value.map((v) => {
      const config = jsonObjectField(v, "configs");
      const enabled = config.enabled;
      if (enabled !== undefined && typeof enabled !== "boolean") {
        throw invalidRequest("`configs[].enabled` must be a boolean");
      }
      const permissionPolicy =
        config.permission_policy === undefined
          ? undefined
          : parsePermissionPolicy(config.permission_policy);
      return {
        name: stringField(config, "name", { required: true }),
        ...(enabled === undefined ? {} : { enabled }),
        ...(permissionPolicy === undefined
          ? {}
          : { permission_policy: permissionPolicy }),
      };
    }),
  };
}

function parsePermissionPolicy(value: unknown): ManagedAgentsPermissionPolicy {
  const obj = jsonObjectField(value, "permission_policy");
  return {
    type: stringField(obj, "type", { required: true }),
  };
}

function normalizeModel(model: ManagedAgentsModel): ManagedAgentsModelConfig {
  if (typeof model === "string") {
    return { id: model, speed: "standard" };
  }
  return { id: model.id, speed: model.speed ?? "standard" };
}
