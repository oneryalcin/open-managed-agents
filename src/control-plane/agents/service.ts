import { isDeepStrictEqual } from "node:util";
import { newAgentId } from "../ids.ts";
import { conflict, invalidRequest, notFound } from "../errors.ts";
import type {
  AgentService,
  AgentRow,
  AgentStore,
  CreateManagedAgentRequest,
  ListAgentVersionsOptions,
  ListAgentsOptions,
  WorkspaceId,
} from "./types.ts";
import type {
  ManagedAgentsAgent,
  ManagedAgentsAgentVersionsPage,
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
import {
  AgentUpdateArchivedError,
  AgentUpdateConflictError,
  AgentUpdateMissingError,
} from "./store.ts";

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
const OMA_UNSUPPORTED_BUILTIN_TOOL_NAMES = [
  "grep",
  "web_fetch",
  "web_search",
] as const;
const MULTIAGENT_UNSUPPORTED_MESSAGE =
  "The `multiagent` configuration is not supported by this deployment.";

export interface AgentModelAvailability {
  assertAvailable(modelId: string): void;
}

const ACCEPT_ANY_MODEL: AgentModelAvailability = { assertAvailable: () => {} };

export class DefaultAgentService implements AgentService {
  constructor(
    private readonly store: AgentStore,
    private readonly skills: Pick<SkillsStore, "getSkill" | "getVersion"> | undefined,
    private readonly models: AgentModelAvailability = ACCEPT_ANY_MODEL,
  ) {}

  create(
    workspaceId: WorkspaceId,
    input: unknown,
  ): ManagedAgentsAgent {
    const req = parseCreateAgent(input);
    const model = normalizeModel(req.model);
    this.models.assertAvailable(model.id);
    this.assertSkillAttachments(workspaceId, req.skills ?? []);
    const now = new Date().toISOString();
    const id = newAgentId();
    const row: AgentRow = {
      id,
      workspace_id: workspaceId,
      type: "agent",
      name: req.name,
      model,
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

  update(
    workspaceId: WorkspaceId,
    agentId: string,
    input: unknown,
  ): ManagedAgentsAgent {
    const current = this.store.retrieveAny(workspaceId, agentId);
    if (!current) throw notFound(`Agent ${agentId} not found`);
    if (current.archived_at !== null) {
      throw invalidRequest("Cannot modify archived agent");
    }
    const patch = objectInput(input);
    const expectedVersion = positiveIntegerField(patch, "version");
    if (expectedVersion !== current.version) {
      throw conflict(
        "Concurrent modification detected. Please fetch the latest version and retry.",
      );
    }
    const mergedMetadata = patchMetadata(current.metadata, patch.metadata);
    const mergedInput: Record<string, unknown> = {
      name: patch.name === undefined ? current.name : patch.name,
      model: patch.model === undefined ? current.model : patch.model,
      system: patch.system === undefined ? current.system : patch.system,
      description: patch.description === undefined
        ? current.description
        : patch.description,
      tools: patch.tools === undefined ? current.tools : (patch.tools ?? []),
      skills: patch.skills === undefined ? current.skills : (patch.skills ?? []),
      mcp_servers: patch.mcp_servers === undefined
        ? current.mcp_servers
        : (patch.mcp_servers ?? []),
      metadata: mergedMetadata,
      multiagent: patch.multiagent === undefined
        ? current.multiagent
        : patch.multiagent,
    };
    const req = parseCreateAgent(mergedInput, {
      allowUnsupportedMultiagent:
        patch.multiagent === undefined && current.multiagent !== null,
    });
    const model = normalizeModel(req.model);
    this.models.assertAvailable(model.id);
    this.assertSkillAttachments(workspaceId, req.skills ?? []);
    const candidate = {
      ...current,
      name: req.name,
      model,
      system: req.system ?? null,
      description: req.description ?? null,
      tools: req.tools ?? [],
      skills: req.skills ?? [],
      mcp_servers: req.mcp_servers ?? [],
      metadata: req.metadata ?? {},
      multiagent: req.multiagent ?? null,
    };
    if (sameAgentConfiguration(current, candidate)) return toManagedAgent(current);
    const now = new Date().toISOString();
    const next: AgentRow = {
      ...candidate,
      version: current.version + 1,
      updated_at: now,
    };
    try {
      return toManagedAgent(this.store.update({ expectedVersion, row: next }));
    } catch (error) {
      if (error instanceof AgentUpdateMissingError) {
        throw notFound(`Agent ${agentId} not found`);
      }
      if (error instanceof AgentUpdateArchivedError) {
        throw invalidRequest("Cannot modify archived agent");
      }
      if (error instanceof AgentUpdateConflictError) {
        throw conflict(
          "Concurrent modification detected. Please fetch the latest version and retry.",
        );
      }
      throw error;
    }
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
    version?: number,
  ): ManagedAgentsAgent {
    const owner = this.store.retrieveAny(workspaceId, agentId);
    if (!owner) throw notFound(`Agent ${agentId} not found`);
    if (version === undefined) return toManagedAgent(owner);
    const row = this.store.retrieveVersion(workspaceId, agentId, version);
    if (!row) throw notFound("Agent version not found.");
    return toManagedAgent(row);
  }

  listVersions(
    workspaceId: WorkspaceId,
    agentId: string,
    opts: ListAgentVersionsOptions = {},
  ): ManagedAgentsAgentVersionsPage {
    try {
      const page = this.store.listVersions(workspaceId, agentId, opts);
      return { data: page.data.map(toManagedAgent), next_page: page.next_page };
    } catch (error) {
      if (error instanceof AgentUpdateMissingError) {
        throw notFound(`Agent ${agentId} not found`);
      }
      if (error instanceof Error && error.message === "invalid page cursor") {
        throw invalidRequest("invalid page cursor");
      }
      throw error;
    }
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

function parseCreateAgent(
  input: unknown,
  opts: { allowUnsupportedMultiagent?: boolean } = {},
): CreateManagedAgentRequest {
  const obj = objectInput(input);
  if (
    obj.multiagent !== undefined &&
    obj.multiagent !== null &&
    opts.allowUnsupportedMultiagent !== true
  ) {
    // Do this before parsing the other agent fields: a non-null config must
    // never be accepted as a durable promise for a runtime we do not have.
    throw invalidRequest(MULTIAGENT_UNSUPPORTED_MESSAGE);
  }
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
    const configsSpread = optionalToolConfigsSpread(tool, {
      builtin: true,
      materialize: true,
    });
    const defaultConfigSpread = parseConfigsFirst
      ? optionalDefaultConfigSpread(tool, { materialize: true })
      : defaultConfig;
    const explicitConfigs = configsSpread.configs ?? [];
    const builtinToolset = {
      type,
      ...defaultConfigSpread,
      configs: materializeDeploymentBuiltinDefaults(explicitConfigs),
    } as ManagedAgentsTool & {
      type: "agent_toolset_20260401";
      default_config: { enabled?: boolean };
      configs: ManagedAgentsToolConfig[];
    };
    assertUnsupportedBuiltinToolsDisabled({
      default_config: builtinToolset.default_config,
      configs: explicitConfigs,
    });
    return builtinToolset;
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
  // Non-null values are rejected at the start of parseCreateAgent. Retain the
  // null/absent distinction for the public response and legacy row shape.
  return obj.multiagent === null ? null : undefined;
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

function assertUnsupportedBuiltinToolsDisabled(toolset: {
  default_config: { enabled?: boolean };
  configs: ManagedAgentsToolConfig[];
}): void {
  const enabledByDefault = toolset.default_config.enabled ?? true;
  for (const name of OMA_UNSUPPORTED_BUILTIN_TOOL_NAMES) {
    const override = toolset.configs.find((config) => config.name === name);
    // Omitted unsupported tools use deployment defaults (disabled). An explicit
    // config opts into CMA inheritance and therefore follows default_config.
    const effectivelyEnabled = override === undefined
      ? false
      : override.enabled ?? enabledByDefault;
    if (effectivelyEnabled) {
      throw invalidRequest(
        `Builtin tool \`${name}\` is not supported by this deployment yet; explicitly disable it to use this toolset`,
      );
    }
  }
}

function materializeDeploymentBuiltinDefaults(
  configs: ManagedAgentsToolConfig[],
): ManagedAgentsToolConfig[] {
  const names = new Set(configs.map((config) => config.name));
  return [
    ...configs,
    ...OMA_UNSUPPORTED_BUILTIN_TOOL_NAMES
      .filter((name) => !names.has(name))
      .map((name) => ({ name, enabled: false })),
  ];
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

function positiveIntegerField(obj: Record<string, unknown>, field: string): number {
  const value = obj[field];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw invalidRequest(`\`${field}\` must be a positive integer`);
  }
  return value as number;
}

function patchMetadata(
  current: Record<string, string>,
  patch: unknown,
): Record<string, string> {
  if (patch === undefined) return { ...current };
  if (!isJsonObject(patch)) throw invalidRequest("`metadata` must be an object");
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (typeof value === "string") next[key] = value;
    else throw invalidRequest("`metadata` values must be strings or null");
  }
  return next;
}

function sameAgentConfiguration(a: AgentRow, b: AgentRow): boolean {
  return isDeepStrictEqual(
    {
      name: a.name, model: a.model, system: a.system, description: a.description,
      tools: a.tools, skills: a.skills, mcp_servers: a.mcp_servers,
      metadata: a.metadata, multiagent: a.multiagent,
    },
    {
      name: b.name, model: b.model, system: b.system, description: b.description,
      tools: b.tools, skills: b.skills, mcp_servers: b.mcp_servers,
      metadata: b.metadata, multiagent: b.multiagent,
    },
  );
}

function normalizeModel(model: ManagedAgentsModel): ManagedAgentsModelConfig {
  if (typeof model === "string") {
    return { id: model, speed: "standard" };
  }
  return { id: model.id, speed: model.speed ?? "standard" };
}
