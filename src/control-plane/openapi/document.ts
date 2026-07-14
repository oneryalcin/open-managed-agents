import {
  FILES_API_BETA,
  MANAGED_AGENTS_BETA,
  SKILLS_API_BETA,
} from "../api-constants.ts";
import { EVENT_TYPES } from "../../types/events.ts";

// `agent.thinking` remains declared in the wire union for compatibility but
// is not emitted by the runtime. Plan 0135 documents shipped behavior only.
const DOCUMENTED_EVENT_TYPES = EVENT_TYPES.filter((type) => type !== "agent.thinking");

const TAG_DESCRIPTIONS: Record<OpenApiTag, string> = {
  Agents: "Versioned Managed Agents definitions.",
  Environments: "Sandbox execution environment configuration.",
  Files: "Workspace uploads, session outputs, and downloads.",
  Skills: "Custom reusable skill bundles and immutable versions.",
  "Secrets (OMA)": "OMA-specific write-only workspace secrets.",
  Vaults: "Vault and MCP credential lifecycle.",
  Sessions: "Managed Agent session lifecycle.",
  "Session events": "User input, event history, and SSE streaming.",
  "Administration (OMA)": "OMA-specific local workspace and API-key administration.",
  "Operations (OMA)": "OMA-specific health and metrics endpoints.",
};

export type OpenApiHttpMethod = "delete" | "get" | "post";
export type OpenApiTag =
  | "Agents"
  | "Environments"
  | "Files"
  | "Skills"
  | "Secrets (OMA)"
  | "Vaults"
  | "Sessions"
  | "Session events"
  | "Administration (OMA)"
  | "Operations (OMA)";

type JsonSchema = Record<string, unknown>;
type OpenApiParameter = Record<string, unknown>;
type OpenApiResponse = Record<string, unknown>;

export interface OpenApiRouteContract {
  method: OpenApiHttpMethod;
  /** OpenAPI form (`/v1/agents/{id}`), not Hono's `:id` form. */
  path: string;
  operationId: string;
  tag: OpenApiTag;
  summary: string;
  auth: "workspace" | "admin" | "none" | "metrics";
  beta?: "managed" | "files" | "skills";
  parameters?: OpenApiParameter[];
  requestBody?: Record<string, unknown>;
  responses: Record<string, OpenApiResponse>;
}

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (schema: JsonSchema, example?: unknown) => ({
  "application/json": { schema, ...(example === undefined ? {} : { example }) },
});
const jsonResponse = (description: string, schema: JsonSchema, example?: unknown): OpenApiResponse => ({
  description,
  content: jsonContent(schema, example),
});
const noContent = (description: string): OpenApiResponse => ({ description });
const jsonBody = (schema: JsonSchema, required = true, example?: unknown) => ({
  required,
  content: jsonContent(schema, example),
});
const multipartBody = (properties: Record<string, JsonSchema>, required: string[]) => ({
  required: true,
  content: {
    "multipart/form-data": {
      schema: { type: "object", properties, required, additionalProperties: false },
    },
  },
});
const pathParam = (name: string, description?: string): OpenApiParameter => ({
  name,
  in: "path",
  required: true,
  ...(description === undefined ? {} : { description }),
  schema: { type: "string", minLength: 1 },
});
const queryParam = (name: string, schema: JsonSchema, description?: string): OpenApiParameter => ({
  name,
  in: "query",
  required: false,
  ...(description === undefined ? {} : { description }),
  schema,
});
const headerParam = (name: string, schema: JsonSchema, required: boolean, description?: string): OpenApiParameter => ({
  name,
  in: "header",
  required,
  ...(description === undefined ? {} : { description }),
  schema,
});
const limit = queryParam("limit", { type: "integer", minimum: 1, maximum: 100 });
const page = queryParam("page", { type: "string", minLength: 1 }, "Opaque cursor; return it unchanged.");
const includeArchived = queryParam("include_archived", { type: "boolean", default: false });
const idempotencyKey = headerParam(
  "idempotency-key",
  { type: "string", minLength: 1, maxLength: 255 },
  false,
  "Optional idempotency key for safely retrying this write.",
);

const commonErrors: Record<string, OpenApiResponse> = {
  "400": jsonResponse("Invalid request", ref("Error")),
  "401": jsonResponse("Authentication failed", ref("Error")),
  "404": jsonResponse("Resource or route not found", ref("Error")),
  "409": jsonResponse("Concurrent modification or idempotency conflict", ref("Error")),
  "413": jsonResponse("Request too large", ref("Error")),
  "429": jsonResponse("Workspace admission limit exceeded", ref("Error")),
  "500": jsonResponse("Internal server error", ref("Error")),
};

function responses(status: number, schema?: JsonSchema, description = "Success"): Record<string, OpenApiResponse> {
  return {
    [String(status)]: schema === undefined ? noContent(description) : jsonResponse(description, schema),
    ...commonErrors,
  };
}

function route(
  contract: Omit<OpenApiRouteContract, "responses"> & {
    success?: {
      status?: number;
      schema?: JsonSchema;
      description?: string;
      mediaType?: string;
    };
  },
): OpenApiRouteContract {
  const { success, ...rest } = contract;
  return {
    ...rest,
    responses: success?.mediaType === undefined
      ? responses(
          success?.status ?? 200,
          success?.schema,
          success?.description ?? "Success",
        )
      : {
          [String(success.status ?? 200)]: {
            description: success.description ?? "Success",
            content: {
              [success.mediaType]: { schema: success.schema ?? { type: "string" } },
            },
          },
          ...commonErrors,
        },
  };
}

const agentId = pathParam("id", "Agent ID.");
const vaultId = pathParam("vaultId", "Vault ID.");
const credentialId = pathParam("credentialId", "Vault credential ID.");
const sessionId = pathParam("sessionId", "Session ID.");

export const OPENAPI_ROUTE_CONTRACTS: readonly OpenApiRouteContract[] = [
  route({ method: "get", path: "/health", operationId: "getHealth", tag: "Operations (OMA)", summary: "Check appliance health", auth: "none", success: { schema: ref("Health") } }),
  route({ method: "get", path: "/metrics", operationId: "getMetrics", tag: "Operations (OMA)", summary: "Read Prometheus metrics when enabled", auth: "metrics", success: { schema: { type: "string" }, mediaType: "text/plain", description: "Prometheus exposition" } }),

  route({ method: "post", path: "/v1/agents", operationId: "createAgent", tag: "Agents", summary: "Create an agent", auth: "workspace", beta: "managed", requestBody: jsonBody(ref("CreateAgentRequest"), true, { name: "Coding agent", model: "claude-sonnet-5" }), success: { schema: ref("Agent") } }),
  route({ method: "get", path: "/v1/agents", operationId: "listAgents", tag: "Agents", summary: "List agents", auth: "workspace", beta: "managed", parameters: [limit, page, includeArchived], success: { schema: ref("ForwardAgentPage") } }),
  route({ method: "get", path: "/v1/agents/{id}/versions", operationId: "listAgentVersions", tag: "Agents", summary: "List immutable agent versions", auth: "workspace", beta: "managed", parameters: [agentId, limit, page], success: { schema: ref("AgentVersionsPage") } }),
  route({ method: "get", path: "/v1/agents/{id}", operationId: "getAgent", tag: "Agents", summary: "Retrieve an agent or historical version", auth: "workspace", beta: "managed", parameters: [agentId, queryParam("version", { type: "integer", minimum: 1 })], success: { schema: ref("Agent") } }),
  route({ method: "post", path: "/v1/agents/{id}", operationId: "updateAgent", tag: "Agents", summary: "Create a new immutable agent version", auth: "workspace", beta: "managed", parameters: [agentId], requestBody: jsonBody(ref("UpdateAgentRequest")), success: { schema: ref("Agent") } }),
  route({ method: "post", path: "/v1/agents/{id}/archive", operationId: "archiveAgent", tag: "Agents", summary: "Archive an agent", auth: "workspace", beta: "managed", parameters: [agentId], success: { schema: ref("Agent") } }),

  route({ method: "post", path: "/v1/environments", operationId: "createEnvironment", tag: "Environments", summary: "Create an environment", auth: "workspace", beta: "managed", requestBody: jsonBody(ref("CreateEnvironmentRequest")), success: { schema: ref("Environment") } }),
  route({ method: "get", path: "/v1/environments", operationId: "listEnvironments", tag: "Environments", summary: "List environments", auth: "workspace", beta: "managed", parameters: [limit, page], success: { schema: ref("ForwardEnvironmentPage") } }),
  route({ method: "get", path: "/v1/environments/{id}", operationId: "getEnvironment", tag: "Environments", summary: "Retrieve an environment", auth: "workspace", beta: "managed", parameters: [pathParam("id", "Environment ID.")], success: { schema: ref("Environment") } }),

  route({ method: "post", path: "/v1/files", operationId: "uploadFile", tag: "Files", summary: "Upload a file", auth: "workspace", beta: "files", requestBody: multipartBody({ file: { type: "string", format: "binary" } }, ["file"]), success: { schema: ref("File") } }),
  route({ method: "get", path: "/v1/files", operationId: "listFiles", tag: "Files", summary: "List files", auth: "workspace", beta: "files", parameters: [limit, queryParam("after_id", { type: "string" }), queryParam("before_id", { type: "string" }), queryParam("scope_id", { type: "string" })], success: { schema: ref("FilePage") } }),
  route({ method: "get", path: "/v1/files/{id}", operationId: "getFile", tag: "Files", summary: "Retrieve file metadata", auth: "workspace", beta: "files", parameters: [pathParam("id", "File ID.")], success: { schema: ref("File") } }),
  route({ method: "get", path: "/v1/files/{id}/content", operationId: "downloadFile", tag: "Files", summary: "Download file content", auth: "workspace", beta: "files", parameters: [pathParam("id", "File ID.")], success: { schema: { type: "string", format: "binary" }, mediaType: "application/octet-stream", description: "Raw file bytes" } }),
  route({ method: "delete", path: "/v1/files/{id}", operationId: "deleteFile", tag: "Files", summary: "Delete a file", auth: "workspace", beta: "files", parameters: [pathParam("id", "File ID.")], success: { schema: ref("DeletedFile") } }),

  route({ method: "post", path: "/v1/skills", operationId: "createSkill", tag: "Skills", summary: "Create a custom skill", auth: "workspace", beta: "skills", requestBody: multipartBody({ display_title: { type: "string" }, "files[]": { type: "array", items: { type: "string", format: "binary" }, minItems: 1 } }, ["files[]"]), success: { schema: ref("Skill") } }),
  route({ method: "get", path: "/v1/skills", operationId: "listSkills", tag: "Skills", summary: "List skills", auth: "workspace", beta: "skills", parameters: [limit, page], success: { schema: ref("SkillPage") } }),
  route({ method: "get", path: "/v1/skills/{id}", operationId: "getSkill", tag: "Skills", summary: "Retrieve a skill", auth: "workspace", beta: "skills", parameters: [pathParam("id", "Skill ID.")], success: { schema: ref("Skill") } }),
  route({ method: "delete", path: "/v1/skills/{id}", operationId: "deleteSkill", tag: "Skills", summary: "Delete a skill", auth: "workspace", beta: "skills", parameters: [pathParam("id", "Skill ID.")], success: { schema: ref("DeletedSkill") } }),
  route({ method: "post", path: "/v1/skills/{id}/versions", operationId: "createSkillVersion", tag: "Skills", summary: "Create a skill version", auth: "workspace", beta: "skills", parameters: [pathParam("id", "Skill ID.")], requestBody: multipartBody({ "files[]": { type: "array", items: { type: "string", format: "binary" }, minItems: 1 } }, ["files[]"]), success: { schema: ref("SkillVersion") } }),
  route({ method: "get", path: "/v1/skills/{id}/versions", operationId: "listSkillVersions", tag: "Skills", summary: "List skill versions", auth: "workspace", beta: "skills", parameters: [pathParam("id", "Skill ID."), limit, page], success: { schema: ref("SkillVersionPage") } }),
  route({ method: "get", path: "/v1/skills/{id}/versions/{version}", operationId: "getSkillVersion", tag: "Skills", summary: "Retrieve a skill version", auth: "workspace", beta: "skills", parameters: [pathParam("id", "Skill ID."), pathParam("version", "Version or latest.")], success: { schema: ref("SkillVersion") } }),
  route({ method: "delete", path: "/v1/skills/{id}/versions/{version}", operationId: "deleteSkillVersion", tag: "Skills", summary: "Delete a skill version", auth: "workspace", beta: "skills", parameters: [pathParam("id", "Skill ID."), pathParam("version", "Version or latest.")], success: { schema: ref("DeletedSkillVersion") } }),

  route({ method: "post", path: "/v1/secrets", operationId: "upsertSecret", tag: "Secrets (OMA)", summary: "Create or replace a write-only secret", auth: "workspace", beta: "managed", requestBody: jsonBody(ref("CreateSecretRequest")), success: { status: 201, schema: ref("Secret") } }),
  route({ method: "get", path: "/v1/secrets", operationId: "listSecrets", tag: "Secrets (OMA)", summary: "List secret metadata", auth: "workspace", beta: "managed", success: { schema: { type: "array", items: ref("Secret") } } }),
  route({ method: "delete", path: "/v1/secrets/{name}", operationId: "deleteSecret", tag: "Secrets (OMA)", summary: "Delete a secret", auth: "workspace", beta: "managed", parameters: [pathParam("name", "Secret name.")], success: { status: 204, description: "Deleted" } }),

  route({ method: "post", path: "/v1/vaults", operationId: "createVault", tag: "Vaults", summary: "Create a vault", auth: "workspace", beta: "managed", requestBody: jsonBody(ref("CreateVaultRequest")), success: { schema: ref("Vault") } }),
  route({ method: "get", path: "/v1/vaults", operationId: "listVaults", tag: "Vaults", summary: "List vaults", auth: "workspace", beta: "managed", parameters: [limit, page, includeArchived], success: { schema: ref("ForwardVaultPage") } }),
  route({ method: "get", path: "/v1/vaults/{vaultId}", operationId: "getVault", tag: "Vaults", summary: "Retrieve a vault", auth: "workspace", beta: "managed", parameters: [vaultId], success: { schema: ref("Vault") } }),
  route({ method: "post", path: "/v1/vaults/{vaultId}/archive", operationId: "archiveVault", tag: "Vaults", summary: "Archive a vault", auth: "workspace", beta: "managed", parameters: [vaultId], success: { schema: ref("Vault") } }),
  route({ method: "post", path: "/v1/vaults/{vaultId}", operationId: "updateVault", tag: "Vaults", summary: "Update a vault", auth: "workspace", beta: "managed", parameters: [vaultId], requestBody: jsonBody(ref("UpdateVaultRequest")), success: { schema: ref("Vault") } }),
  route({ method: "delete", path: "/v1/vaults/{vaultId}", operationId: "deleteVault", tag: "Vaults", summary: "Delete a vault", auth: "workspace", beta: "managed", parameters: [vaultId], success: { schema: ref("DeletedVault") } }),
  route({ method: "post", path: "/v1/vaults/{vaultId}/credentials", operationId: "createVaultCredential", tag: "Vaults", summary: "Create a vault credential", auth: "workspace", beta: "managed", parameters: [vaultId], requestBody: jsonBody(ref("CreateCredentialRequest")), success: { schema: ref("VaultCredential") } }),
  route({ method: "get", path: "/v1/vaults/{vaultId}/credentials", operationId: "listVaultCredentials", tag: "Vaults", summary: "List vault credentials", auth: "workspace", beta: "managed", parameters: [vaultId, limit, page, includeArchived], success: { schema: ref("ForwardCredentialPage") } }),
  route({ method: "post", path: "/v1/vaults/{vaultId}/credentials/{credentialId}/archive", operationId: "archiveVaultCredential", tag: "Vaults", summary: "Archive a vault credential", auth: "workspace", beta: "managed", parameters: [vaultId, credentialId], success: { schema: ref("VaultCredential") } }),
  route({ method: "post", path: "/v1/vaults/{vaultId}/credentials/{credentialId}/mcp_oauth_validate", operationId: "validateVaultCredential", tag: "Vaults", summary: "Validate an MCP OAuth credential", auth: "workspace", beta: "managed", parameters: [vaultId, credentialId], success: { schema: { type: "object", additionalProperties: true } } }),
  route({ method: "get", path: "/v1/vaults/{vaultId}/credentials/{credentialId}", operationId: "getVaultCredential", tag: "Vaults", summary: "Retrieve vault credential metadata", auth: "workspace", beta: "managed", parameters: [vaultId, credentialId], success: { schema: ref("VaultCredential") } }),
  route({ method: "post", path: "/v1/vaults/{vaultId}/credentials/{credentialId}", operationId: "updateVaultCredential", tag: "Vaults", summary: "Update a vault credential", auth: "workspace", beta: "managed", parameters: [vaultId, credentialId], requestBody: jsonBody(ref("UpdateCredentialRequest")), success: { schema: ref("VaultCredential") } }),
  route({ method: "delete", path: "/v1/vaults/{vaultId}/credentials/{credentialId}", operationId: "deleteVaultCredential", tag: "Vaults", summary: "Delete a vault credential", auth: "workspace", beta: "managed", parameters: [vaultId, credentialId], success: { status: 204, description: "Deleted" } }),

  route({ method: "post", path: "/v1/sessions", operationId: "createSession", tag: "Sessions", summary: "Create a session", auth: "workspace", beta: "managed", parameters: [idempotencyKey], requestBody: jsonBody(ref("CreateSessionRequest")), success: { schema: ref("Session") } }),
  route({ method: "get", path: "/v1/sessions", operationId: "listSessions", tag: "Sessions", summary: "List sessions with forward/backward cursors", auth: "workspace", beta: "managed", parameters: [limit, page, queryParam("order", { type: "string", enum: ["asc", "desc"], default: "desc" }), queryParam("agent_id", { type: "string" }), includeArchived], success: { schema: ref("SessionPage") } }),
  route({ method: "get", path: "/v1/sessions/{id}", operationId: "getSession", tag: "Sessions", summary: "Retrieve a session", auth: "workspace", beta: "managed", parameters: [pathParam("id", "Session ID.")], success: { schema: ref("Session") } }),
  route({ method: "post", path: "/v1/sessions/{id}/archive", operationId: "archiveSession", tag: "Sessions", summary: "Archive an idle session", auth: "workspace", beta: "managed", parameters: [pathParam("id", "Session ID.")], success: { schema: ref("Session") } }),
  route({ method: "delete", path: "/v1/sessions/{id}", operationId: "deleteSession", tag: "Sessions", summary: "Delete an idle session", auth: "workspace", beta: "managed", parameters: [pathParam("id", "Session ID.")], success: { schema: ref("DeletedSession") } }),

  route({ method: "post", path: "/v1/sessions/{sessionId}/events", operationId: "sendSessionEvents", tag: "Session events", summary: "Send user events to a session", auth: "workspace", beta: "managed", parameters: [sessionId, idempotencyKey], requestBody: jsonBody(ref("SendEventsRequest"), true, { events: [{ type: "user.message", content: [{ type: "text", text: "Hello" }] }] }), success: { schema: ref("EventPage") } }),
  route({ method: "get", path: "/v1/sessions/{sessionId}/events", operationId: "listSessionEvents", tag: "Session events", summary: "List session events", auth: "workspace", beta: "managed", parameters: [sessionId, limit, page, queryParam("order", { type: "string", enum: ["asc", "desc"] }), queryParam("types[]", { type: "array", items: { type: "string", enum: DOCUMENTED_EVENT_TYPES } }, "Repeat to filter by an event type currently emitted by OMA.")], success: { schema: ref("EventPage") } }),
  route({ method: "get", path: "/v1/sessions/{sessionId}/events/stream", operationId: "streamSessionEvents", tag: "Session events", summary: "Stream session events over SSE", auth: "workspace", beta: "managed", parameters: [sessionId, headerParam("last-event-id", { type: "string" }, false, "Resume after this event ID.")], success: { schema: { type: "string", description: "SSE frames with id, event, and JSON data fields." }, mediaType: "text/event-stream", description: "SSE stream" } }),

  route({ method: "post", path: "/admin/workspaces", operationId: "adminCreateWorkspace", tag: "Administration (OMA)", summary: "Create a workspace", auth: "admin", requestBody: jsonBody(ref("AdminCreateWorkspaceRequest")), success: { status: 201, schema: ref("AdminWorkspace") } }),
  route({ method: "get", path: "/admin/workspaces", operationId: "adminListWorkspaces", tag: "Administration (OMA)", summary: "List workspaces", auth: "admin", success: { schema: { type: "array", items: ref("AdminWorkspace") } } }),
  route({ method: "get", path: "/admin/workspaces/{id}", operationId: "adminGetWorkspace", tag: "Administration (OMA)", summary: "Retrieve a workspace", auth: "admin", parameters: [pathParam("id", "Workspace ID.")], success: { schema: ref("AdminWorkspace") } }),
  route({ method: "post", path: "/admin/workspaces/{id}/keys", operationId: "adminMintWorkspaceKey", tag: "Administration (OMA)", summary: "Mint a workspace API key", auth: "admin", parameters: [pathParam("id", "Workspace ID.")], requestBody: jsonBody(ref("AdminMintKeyRequest"), false), success: { status: 201, schema: ref("AdminMintedKey") } }),
  route({ method: "get", path: "/admin/workspaces/{id}/keys", operationId: "adminListWorkspaceKeys", tag: "Administration (OMA)", summary: "List workspace API key metadata", auth: "admin", parameters: [pathParam("id", "Workspace ID.")], success: { schema: { type: "array", items: ref("AdminKeyMetadata") } } }),
  route({ method: "get", path: "/admin/workspaces/{id}/mcp-credentials", operationId: "adminListWorkspaceMcpCredentials", tag: "Administration (OMA)", summary: "List token-free MCP credential operational metadata", auth: "admin", parameters: [pathParam("id", "Workspace ID."), limit, page], success: { schema: ref("GenericForwardPage") } }),
  route({ method: "delete", path: "/admin/keys/{sha256}", operationId: "adminRevokeWorkspaceKey", tag: "Administration (OMA)", summary: "Revoke a workspace API key", auth: "admin", parameters: [pathParam("sha256", "SHA-256 key fingerprint.")], success: { schema: ref("AdminKeyMetadata") } }),
];

const schemas: Record<string, JsonSchema> = {
  Error: { type: "object", required: ["type", "error", "request_id"], properties: { type: { const: "error" }, error: { type: "object", required: ["type", "message"], properties: { type: { type: "string" }, message: { type: "string" } }, additionalProperties: true }, request_id: { type: "string" } }, additionalProperties: false },
  JsonObject: { type: "object", additionalProperties: true },
  StringMap: { type: "object", additionalProperties: { type: "string" } },
  NullableString: { type: ["string", "null"] },
  ModelInput: { oneOf: [{ type: "string" }, { type: "object", required: ["id"], properties: { id: { type: "string" }, speed: { type: "string", enum: ["standard", "fast"] } }, additionalProperties: false }] },
  CreateAgentRequest: { type: "object", required: ["name", "model"], properties: { name: { type: "string", minLength: 1 }, model: ref("ModelInput"), system: ref("NullableString"), description: ref("NullableString"), tools: { type: "array", items: ref("JsonObject") }, skills: { type: "array", items: ref("JsonObject") }, mcp_servers: { type: "array", items: ref("JsonObject") }, metadata: ref("StringMap"), multiagent: { type: ["object", "null"] } }, additionalProperties: false },
  UpdateAgentRequest: { type: "object", required: ["version"], properties: { version: { type: "integer", minimum: 1 }, name: { type: "string", minLength: 1 }, model: ref("ModelInput"), system: ref("NullableString"), description: ref("NullableString"), tools: { type: ["array", "null"], items: ref("JsonObject") }, skills: { type: ["array", "null"], items: ref("JsonObject") }, mcp_servers: { type: ["array", "null"], items: ref("JsonObject") }, metadata: { type: "object", additionalProperties: { type: ["string", "null"] } }, multiagent: { type: ["object", "null"] } }, additionalProperties: false },
  Agent: { type: "object", required: ["id", "type", "name", "model", "version", "created_at", "updated_at", "archived_at"], properties: { id: { type: "string" }, type: { const: "agent" }, name: { type: "string" }, model: { type: "object", required: ["id", "speed"], properties: { id: { type: "string" }, speed: { enum: ["standard", "fast"] } } }, system: ref("NullableString"), description: ref("NullableString"), tools: { type: "array", items: ref("JsonObject") }, skills: { type: "array", items: ref("JsonObject") }, mcp_servers: { type: "array", items: ref("JsonObject") }, metadata: ref("StringMap"), multiagent: { type: ["object", "null"] }, version: { type: "integer", minimum: 1 }, created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" }, archived_at: { type: ["string", "null"], format: "date-time" } }, additionalProperties: false },
  CreateEnvironmentRequest: { type: "object", required: ["name", "config"], properties: { name: { type: "string", minLength: 1 }, config: ref("JsonObject") }, additionalProperties: false },
  Environment: { type: "object", required: ["id", "type", "name", "config", "created_at", "updated_at", "archived_at"], properties: { id: { type: "string" }, type: { const: "environment" }, name: { type: "string" }, config: ref("JsonObject"), created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" }, archived_at: { type: ["string", "null"], format: "date-time" } } },
  File: { type: "object", required: ["id", "type", "filename", "mime_type", "size_bytes", "created_at", "downloadable", "scope"], properties: { id: { type: "string" }, type: { const: "file" }, filename: { type: "string" }, mime_type: { type: "string" }, size_bytes: { type: "integer", minimum: 0 }, downloadable: { type: "boolean" }, scope: { type: ["object", "null"] }, created_at: { type: "string", format: "date-time" } }, additionalProperties: false },
  DeletedFile: { type: "object", required: ["id", "type"], properties: { id: { type: "string" }, type: { const: "file_deleted" } }, additionalProperties: false },
  Skill: { type: "object", required: ["id", "type", "display_title", "source", "latest_version", "created_at", "updated_at"], properties: { id: { type: "string" }, type: { const: "skill" }, display_title: { type: "string" }, source: { const: "custom" }, latest_version: { type: ["string", "null"] }, created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" } }, additionalProperties: false },
  SkillVersion: { type: "object", required: ["id", "type", "skill_id", "version", "name", "description", "directory", "created_at"], properties: { id: { type: "string" }, type: { const: "skill_version" }, skill_id: { type: "string" }, version: { type: "string" }, name: { type: "string" }, description: { type: "string" }, directory: { type: "string" }, created_at: { type: "string", format: "date-time" } }, additionalProperties: false },
  DeletedSkill: { type: "object", required: ["id", "type"], properties: { id: { type: "string" }, type: { const: "skill_deleted" } }, additionalProperties: false },
  DeletedSkillVersion: { type: "object", required: ["id", "type"], properties: { id: { type: "string" }, type: { const: "skill_version_deleted" } }, additionalProperties: false },
  CreateSecretRequest: { type: "object", required: ["name", "value"], properties: { name: { type: "string", minLength: 1, maxLength: 256 }, value: { type: "string", minLength: 1, writeOnly: true } }, additionalProperties: false },
  Secret: { type: "object", required: ["id", "type", "name", "created_at", "updated_at"], properties: { id: { type: "string" }, type: { const: "secret" }, name: { type: "string" }, created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" } }, additionalProperties: false },
  CreateVaultRequest: { type: "object", required: ["display_name"], properties: { display_name: { type: "string", minLength: 1 }, metadata: ref("StringMap") }, additionalProperties: false },
  UpdateVaultRequest: { type: "object", properties: { display_name: { type: "string", minLength: 1 }, metadata: ref("StringMap") }, additionalProperties: false },
  Vault: { type: "object", required: ["id", "type", "display_name", "metadata", "created_at", "updated_at", "archived_at"], properties: { id: { type: "string" }, type: { const: "vault" }, display_name: { type: "string" }, metadata: ref("StringMap"), created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" }, archived_at: { type: ["string", "null"], format: "date-time" } } },
  DeletedVault: { type: "object", required: ["id", "type"], properties: { id: { type: "string" }, type: { const: "vault_deleted" } } },
  CreateCredentialRequest: { type: "object", required: ["auth"], properties: { display_name: ref("NullableString"), metadata: ref("StringMap"), auth: ref("JsonObject") }, additionalProperties: false },
  UpdateCredentialRequest: { type: "object", properties: { display_name: ref("NullableString"), metadata: ref("StringMap"), auth: ref("JsonObject") }, additionalProperties: false },
  VaultCredential: { type: "object", required: ["id", "type", "vault_id", "metadata", "auth", "created_at", "updated_at", "archived_at"], properties: { id: { type: "string" }, type: { const: "vault_credential" }, vault_id: { type: "string" }, display_name: ref("NullableString"), metadata: ref("StringMap"), auth: ref("JsonObject"), created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" }, archived_at: { type: ["string", "null"], format: "date-time" } }, additionalProperties: false },
  CreateSessionRequest: { type: "object", required: ["agent", "environment_id"], properties: { agent: { oneOf: [{ type: "string" }, { type: "object", required: ["type", "id"], properties: { type: { const: "agent" }, id: { type: "string" }, version: { type: "integer", minimum: 1 } }, additionalProperties: false }] }, environment_id: { type: "string" }, vault_ids: { type: "array", items: { type: "string" } }, title: ref("NullableString"), metadata: ref("StringMap"), resources: { type: "array", items: ref("JsonObject") } }, additionalProperties: false },
  Session: { type: "object", required: ["id", "type", "agent", "environment_id", "vault_ids", "status", "metadata", "created_at", "updated_at", "archived_at", "resources"], properties: { id: { type: "string" }, type: { const: "session" }, agent: { type: "object", required: ["type", "id", "version"], properties: { type: { const: "agent" }, id: { type: "string" }, version: { type: "integer" } } }, environment_id: { type: "string" }, vault_ids: { type: "array", items: { type: "string" } }, status: { enum: ["idle", "running", "rescheduling", "terminated"] }, title: ref("NullableString"), metadata: ref("StringMap"), created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" }, archived_at: { type: ["string", "null"], format: "date-time" }, usage: { type: "null" }, resources: { type: "array", items: ref("JsonObject") } }, additionalProperties: false },
  DeletedSession: { type: "object", required: ["id", "type"], properties: { id: { type: "string" }, type: { const: "session_deleted" } }, additionalProperties: false },
  Event: { type: "object", required: ["id", "type", "processed_at"], properties: { id: { type: "string" }, type: { type: "string", enum: DOCUMENTED_EVENT_TYPES }, processed_at: { type: ["string", "null"], format: "date-time" } }, additionalProperties: true },
  SendEventsRequest: { type: "object", required: ["events"], properties: { events: { type: "array", minItems: 1, maxItems: 200, items: { oneOf: [{ type: "object", required: ["type", "content"], properties: { type: { const: "user.message" }, content: { type: "array", items: ref("JsonObject") } }, additionalProperties: false }, { type: "object", required: ["type"], properties: { type: { const: "user.interrupt" } }, additionalProperties: false }, { type: "object", required: ["type", "custom_tool_use_id"], properties: { type: { const: "user.custom_tool_result" }, custom_tool_use_id: { type: "string" }, content: { type: "array", items: ref("JsonObject") }, is_error: { type: "boolean" } }, additionalProperties: false }, { type: "object", required: ["type", "tool_use_id", "result"], properties: { type: { const: "user.tool_confirmation" }, tool_use_id: { type: "string" }, result: { enum: ["allow", "deny"] }, deny_message: ref("NullableString") }, additionalProperties: false }] } } }, additionalProperties: false },
  AdminCreateWorkspaceRequest: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 } }, additionalProperties: false },
  AdminMintKeyRequest: { type: "object", properties: { label: { type: "string", minLength: 1, default: "default" } }, additionalProperties: false },
  AdminWorkspace: { type: "object", required: ["id", "name", "created_at"], properties: { id: { type: "string" }, name: { type: "string" }, created_at: { type: "string", format: "date-time" } }, additionalProperties: false },
  AdminMintedKey: { type: "object", required: ["workspace_id", "label", "key_sha256", "api_key"], properties: { workspace_id: { type: "string" }, label: { type: "string" }, key_sha256: { type: "string" }, api_key: { type: "string", writeOnly: true } }, additionalProperties: false },
  AdminKeyMetadata: { type: "object", required: ["key_sha256", "workspace_id", "label", "created_at", "revoked_at"], properties: { key_sha256: { type: "string" }, workspace_id: { type: "string" }, label: { type: "string" }, created_at: { type: "string", format: "date-time" }, revoked_at: { type: ["string", "null"], format: "date-time" } }, additionalProperties: false },
  Health: { type: "object", required: ["status", "version", "uptime_seconds", "checks"], properties: { status: { enum: ["ok", "degraded"] }, version: { type: "string" }, uptime_seconds: { type: "integer", minimum: 0 }, checks: { type: "object", required: ["storage", "runtime"], properties: { storage: ref("HealthCheck"), runtime: ref("HealthCheck") }, additionalProperties: false } }, additionalProperties: false },
  HealthCheck: { type: "object", required: ["status"], properties: { status: { enum: ["ok", "failed"] }, detail: { type: "string" } }, additionalProperties: false },
};

for (const [name, item] of [
  ["ForwardAgentPage", "Agent"],
  ["AgentVersionsPage", "Agent"],
  ["ForwardEnvironmentPage", "Environment"],
  ["SkillPage", "Skill"],
  ["SkillVersionPage", "SkillVersion"],
  ["ForwardVaultPage", "Vault"],
  ["ForwardCredentialPage", "VaultCredential"],
] as const) {
  schemas[name] = {
    type: "object",
    required: ["data", "next_page"],
    properties: {
      data: { type: "array", items: ref(item) },
      next_page: { type: ["string", "null"] },
      ...(name === "SkillPage" || name === "SkillVersionPage" ? { has_more: { type: "boolean" } } : {}),
    },
    additionalProperties: false,
  };
}
schemas.FilePage = { type: "object", required: ["data", "has_more", "first_id", "last_id"], properties: { data: { type: "array", items: ref("File") }, has_more: { type: "boolean" }, first_id: { type: ["string", "null"] }, last_id: { type: ["string", "null"] } }, additionalProperties: false };
schemas.SessionPage = { type: "object", required: ["data", "next_page", "prev_page"], properties: { data: { type: "array", items: ref("Session") }, next_page: { type: ["string", "null"] }, prev_page: { type: ["string", "null"] } }, additionalProperties: false };
schemas.EventPage = { type: "object", required: ["data"], properties: { data: { type: "array", items: ref("Event") }, next_page: { type: ["string", "null"] } }, additionalProperties: false };
schemas.GenericForwardPage = { type: "object", required: ["data", "has_more", "next_page"], properties: { data: { type: "array", items: ref("JsonObject") }, has_more: { type: "boolean" }, next_page: { type: ["string", "null"] } }, additionalProperties: false };

function betaParameter(kind: NonNullable<OpenApiRouteContract["beta"]>): OpenApiParameter {
  const feature = kind === "files" ? FILES_API_BETA : kind === "skills" ? SKILLS_API_BETA : MANAGED_AGENTS_BETA;
  const alternative = kind === "managed" ? "" : ` The general ${MANAGED_AGENTS_BETA} beta is also accepted.`;
  return headerParam(
    "anthropic-beta",
    { type: "string", example: feature },
    true,
    `Required beta feature header. Multiple features are comma-separated.${alternative}`,
  );
}

export function createOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const contract of OPENAPI_ROUTE_CONTRACTS) {
    const parameters = [
      ...(contract.beta === undefined ? [] : [betaParameter(contract.beta)]),
      ...(contract.parameters ?? []),
    ];
    const operation = {
      operationId: contract.operationId,
      tags: [contract.tag],
      summary: contract.summary,
      security: contract.auth === "none"
        ? []
        : contract.auth === "metrics"
          ? [{}, { MetricsBearer: [] }]
          : [{ [contract.auth === "workspace" ? "WorkspaceApiKey" : "AdminApiKey"]: [] }],
      ...(parameters.length === 0 ? {} : { parameters }),
      ...(contract.requestBody === undefined ? {} : { requestBody: contract.requestBody }),
      responses: contract.responses,
    };
    (paths[contract.path] ??= {})[contract.method] = operation;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Open Managed Agents API",
      version: "0.0.1-alpha",
      description: "The currently shipped OMA API surface. Unsupported Claude Managed Agents operations are intentionally omitted.",
    },
    servers: [{ url: "/", description: "This OMA appliance" }],
    tags: [...new Set(OPENAPI_ROUTE_CONTRACTS.map((contract) => contract.tag))]
      .map((name) => ({ name, description: TAG_DESCRIPTIONS[name] })),
    paths,
    components: {
      securitySchemes: {
        WorkspaceApiKey: { type: "apiKey", in: "header", name: "x-api-key", description: "Workspace-scoped API key." },
        AdminApiKey: { type: "apiKey", in: "header", name: "x-admin-key", description: "Local appliance administrator key. Keep it out of URLs, cookies, and persistent browser storage." },
        MetricsBearer: { type: "http", scheme: "bearer", description: "Optional deployment-configured metrics bearer token." },
      },
      schemas,
    },
  };
}

export function openApiContractRouteKeys(): string[] {
  return OPENAPI_ROUTE_CONTRACTS.map((contract) => `${contract.method.toUpperCase()} ${contract.path}`).sort();
}
