import { newAgentId } from "../ids.ts";
import { invalidRequest, notFound } from "../errors.ts";
import type {
  AgentService,
  AgentRow,
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
import type { SkillsStore } from "../skills/types.ts";

const MAX_SKILLS = 20;
const CMA_BUILTIN_TOOL_NAMES = [
  "bash",
  "edit",
  "glob",
  "grep",
  "read",
  "web_fetch",
  "web_search",
  "write",
] as const;
const CMA_PERMISSION_POLICY_TYPES = ["always_allow", "always_ask"] as const;

export class DefaultAgentService implements AgentService {
  constructor(
    private readonly store: AgentStore,
    private readonly skills: Pick<SkillsStore, "getSkill" | "getVersion"> | undefined,
  ) {}

  create(
    workspaceId: WorkspaceId,
    input: unknown,
  ): ManagedAgentsAgent {
    const req = parseCreateAgent(input);
    this.assertSkillAttachments(workspaceId, req.skills ?? []);
    const now = new Date().toISOString();
    const id = newAgentId();
    const row: AgentRow = {
      id,
      workspace_id: workspaceId,
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
    return toManagedAgent(this.store.create({ row }));
  }

  private assertSkillAttachments(
    workspaceId: WorkspaceId,
    attachments: ManagedAgentsSkill[],
  ): void {
    for (const attachment of attachments) {
      if (attachment.type === "anthropic") {
        throw invalidRequest(
          "anthropic prebuilt skills are not available on this deployment",
        );
      }
      if (!this.skills?.getSkill(workspaceId, attachment.skill_id)) {
        throw invalidRequest(`Unknown custom skill_id: ${attachment.skill_id}`);
      }
      const version = attachment.version ?? "latest";
      if (!this.skills.getVersion(workspaceId, attachment.skill_id, version)) {
        throw invalidRequest(
          `Agent has invalid configuration: \`skill_id\` \`${attachment.skill_id}\` version \`${version}\` not found`,
        );
      }
    }
  }

  retrieve(
    workspaceId: WorkspaceId,
    agentId: string,
  ): ManagedAgentsAgent {
    const row = this.store.retrieveAny(workspaceId, agentId);
    if (!row) {
      throw notFound(`Agent ${agentId} not found`);
    }
    return toManagedAgent(row);
  }

  archive(
    workspaceId: WorkspaceId,
    agentId: string,
  ): ManagedAgentsAgent {
    const archivedAt = new Date().toISOString();
    const row = this.store.archive(workspaceId, agentId, archivedAt);
    if (!row) {
      throw notFound(`Agent ${agentId} not found`);
    }
    return toManagedAgent(row);
  }

  list(
    workspaceId: WorkspaceId,
    opts: ListAgentsOptions = {},
  ): ManagedAgentsListPage<ManagedAgentsAgent> {
    const page = this.store.list(workspaceId, opts);
    return {
      data: page.data.map(toManagedAgent),
      has_more: page.has_more,
      next_page: page.next_page,
    };
  }
}

function toManagedAgent(row: AgentRow): ManagedAgentsAgent {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    model: row.model,
    system: row.system,
    description: row.description,
    tools: row.tools,
    skills: row.skills,
    mcp_servers: row.mcp_servers,
    metadata: row.metadata,
    multiagent: row.multiagent,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
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
  assertMcpServerToolsetCrossReferences(mcpServers, tools);
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
  const tools = value.map(parseTool);
  const agentToolsetCount = tools.filter(
    (tool) => tool.type === "agent_toolset_20260401",
  ).length;
  if (agentToolsetCount > 1) {
    throw invalidRequest(
      "`tools` may contain at most one `agent_toolset_20260401` entry",
    );
  }
  return tools;
}

function parseTool(value: unknown): ManagedAgentsTool {
  const tool = jsonObjectField(value, "tools");
  const type = stringField(tool, "type", { required: true });
  if (type === "agent_toolset_20260401") {
    // Probe 63 shows a narrow precedence distinction: a structurally
    // malformed default policy yields to config validation, while a
    // semantically unknown default policy wins before configs are inspected.
    const parseConfigsFirst = hasStructurallyMalformedDefaultPolicy(tool);
    const defaultConfig = parseConfigsFirst
      ? undefined
      : optionalDefaultConfigSpread(tool, { materialize: true });
    const configs = optionalToolConfigsSpread(tool, {
      builtin: true,
      materialize: true,
    });
    return {
      type,
      ...(parseConfigsFirst
        ? optionalDefaultConfigSpread(tool, { materialize: true })
        : defaultConfig),
      ...configs,
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
  if (value.length > MAX_SKILLS) {
    throw invalidRequest(`\`${field}\` may contain at most ${MAX_SKILLS} skills`);
  }
  const seen = new Set<string>();
  return value.map((v) => {
    const skill = jsonObjectField(v, field);
    const type = stringField(skill, "type", { required: true });
    if (type !== "custom" && type !== "anthropic") {
      throw invalidRequest("`skills[].type` must be `custom` or `anthropic`");
    }
    const skillId = stringField(skill, "skill_id", { required: true });
    if (seen.has(skillId)) {
      throw invalidRequest(
        `Agent has invalid configuration: duplicate skill_id "${skillId}"`,
      );
    }
    seen.add(skillId);
    const version = optionalStringField(skill, "version");
    return version === undefined
      ? { type, skill_id: skillId }
      : { type, skill_id: skillId, version };
  });
}

const MAX_MCP_SERVERS = 20;
const MAX_MCP_SERVER_NAME_LENGTH = 255;
const MAX_MCP_SERVER_URL_LENGTH = 2048;

function mcpServerArrayField(
  obj: Record<string, unknown>,
  field: string,
): ManagedAgentsMcpServer[] | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalidRequest(`\`${field}\` must be an array`);
  if (value.length > MAX_MCP_SERVERS) {
    throw invalidRequest(
      `\`${field}\` may contain at most ${MAX_MCP_SERVERS} servers`,
    );
  }
  const seenNames = new Set<string>();
  return value.map((v) => {
    const server = jsonObjectField(v, field);
    rejectUnknownMcpServerFields(server, field);
    const type = stringField(server, "type", { required: true });
    if (type !== "url") {
      throw invalidRequest("Only url MCP server definitions are supported in MVP");
    }
    const name = stringField(server, "name", { required: true });
    if (name.length > MAX_MCP_SERVER_NAME_LENGTH) {
      throw invalidRequest(
        `\`${field}[].name\` must be at most ${MAX_MCP_SERVER_NAME_LENGTH} characters`,
      );
    }
    // Name comparisons are case-sensitive throughout (uniqueness here,
    // toolset cross-references below, config tool matching at runtime).
    if (seenNames.has(name)) {
      throw invalidRequest(`\`${field}\` contains duplicate server name: ${name}`);
    }
    seenNames.add(name);
    // `url` is validated via `new URL` but the RAW input string is what gets
    // stored: URL normalization (port stripping, host lowercasing, trailing
    // slash) would silently break M2's byte-exact credential matching.
    const url = stringField(server, "url", { required: true });
    if (url.length > MAX_MCP_SERVER_URL_LENGTH) {
      throw invalidRequest(
        `\`${field}[].url\` must be at most ${MAX_MCP_SERVER_URL_LENGTH} characters`,
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw invalidRequest(`\`${field}[].url\` must be a valid URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw invalidRequest(
        `\`${field}[].url\` must use http or https: ${url}`,
      );
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw invalidRequest(
        `\`${field}[].url\` must not embed credentials; use vault credentials instead`,
      );
    }
    return { type, name, url };
  });
}

function rejectUnknownMcpServerFields(
  server: Record<string, unknown>,
  field: string,
): void {
  for (const key of Object.keys(server)) {
    if (key === "type" || key === "name" || key === "url") continue;
    throw invalidRequest(`Unsupported \`${field}[]\` field: ${key}`);
  }
}

// Upstream rejects agent definitions with unreferenced servers, dangling
// toolsets (both-ways referencing), and duplicate toolsets per server — all
// confirmed against hosted by live probe 47 (scratch/47-mcp-hosted-probe.md).
// The userinfo-URL rejection below is a deliberate OMA deviation (hosted
// accepts embedded credentials; we refuse the leak class).
function assertMcpServerToolsetCrossReferences(
  servers: ManagedAgentsMcpServer[] | undefined,
  tools: ManagedAgentsTool[] | undefined,
): void {
  const serverNames = new Set((servers ?? []).map((server) => server.name));
  const referenced = new Set<string>();
  for (const tool of tools ?? []) {
    if (tool.type !== "mcp_toolset") continue;
    if (!serverNames.has(tool.mcp_server_name)) {
      throw invalidRequest(
        `\`tools[]\` mcp_toolset references undeclared MCP server: ${tool.mcp_server_name}`,
      );
    }
    if (referenced.has(tool.mcp_server_name)) {
      throw invalidRequest(
        `\`tools\` may contain at most one mcp_toolset per server: ${tool.mcp_server_name}`,
      );
    }
    referenced.add(tool.mcp_server_name);
  }
  // Covers both a `tools` array without a matching toolset and a request
  // with `tools` absent entirely — an unreferenced server either way.
  for (const name of serverNames) {
    if (referenced.has(name)) continue;
    throw invalidRequest(
      `\`mcp_servers\` entry is not referenced by any mcp_toolset: ${name}`,
    );
  }
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
  opts: { materialize?: boolean } = {},
): {
  default_config?: {
    enabled?: boolean;
    permission_policy?: ManagedAgentsPermissionPolicy;
  };
} {
  const value = obj.default_config;
  if (value === undefined) {
    return opts.materialize
      ? {
          default_config: {
            enabled: true,
            permission_policy: { type: "always_allow" },
          },
        }
      : {};
  }
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

function hasStructurallyMalformedDefaultPolicy(
  obj: Record<string, unknown>,
): boolean {
  const defaultConfig = obj.default_config;
  if (!isJsonObject(defaultConfig)) return defaultConfig !== undefined;
  const policy = defaultConfig.permission_policy;
  if (policy === undefined) return false;
  if (typeof policy === "string") return policy.length === 0;
  if (!isJsonObject(policy)) return true;
  return typeof policy.type !== "string" || policy.type.length === 0;
}

function optionalToolConfigsSpread(
  obj: Record<string, unknown>,
  opts: { builtin?: boolean; materialize?: boolean } = {},
): { configs?: ManagedAgentsToolConfig[] } {
  const value = obj.configs;
  if (value === undefined) return opts.materialize ? { configs: [] } : {};
  if (!Array.isArray(value)) {
    throw invalidRequest("`configs` must be an array");
  }
  const configs = value.map((v) => {
    const config = jsonObjectField(v, "configs");
    const enabled = config.enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw invalidRequest("`configs[].enabled` must be a boolean");
    }
    // Parse policy before the name so an unknown policy wins over an unknown
    // name in the same config, matching the observed hosted precedence.
    const permissionPolicy =
      config.permission_policy === undefined
        ? undefined
        : parsePermissionPolicy(config.permission_policy);
    const name = stringField(config, "name", { required: true });
    if (opts.builtin && !isCmaBuiltinToolName(name)) {
      throw invalidRequest(
        `\`configs[].name\` "${name}" is not a valid value; expected one of ${CMA_BUILTIN_TOOL_NAMES.join(", ")}`,
      );
    }
    return {
      name,
      ...(enabled === undefined ? {} : { enabled }),
      ...(permissionPolicy === undefined
        ? {}
        : { permission_policy: permissionPolicy }),
    };
  });
  if (opts.builtin) {
    const seen = new Set<string>();
    for (const config of configs) {
      if (seen.has(config.name)) {
        throw invalidRequest(
          `\`configs\` contains duplicate builtin tool config: ${config.name}`,
        );
      }
      seen.add(config.name);
    }
  }
  return { configs };
}

function isCmaBuiltinToolName(value: string): boolean {
  return (CMA_BUILTIN_TOOL_NAMES as readonly string[]).includes(value);
}

function parsePermissionPolicy(value: unknown): ManagedAgentsPermissionPolicy {
  const type =
    typeof value === "string" && value.length > 0
      ? value
      : stringField(jsonObjectField(value, "permission_policy"), "type", {
          required: true,
        });
  if (!(CMA_PERMISSION_POLICY_TYPES as readonly string[]).includes(type)) {
    throw invalidRequest(
      `\`permission_policy.type\` "${type}" is not a valid value; expected one of ${CMA_PERMISSION_POLICY_TYPES.join(", ")}`,
    );
  }
  return { type: type as ManagedAgentsPermissionPolicy["type"] };
}

function normalizeModel(model: ManagedAgentsModel): ManagedAgentsModelConfig {
  if (typeof model === "string") {
    return { id: model, speed: "standard" };
  }
  return { id: model.id, speed: model.speed ?? "standard" };
}
