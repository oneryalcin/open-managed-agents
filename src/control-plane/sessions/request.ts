import type {
  CreateManagedSessionRequest,
  CreateManagedSessionResourceInput,
} from "../../types/sessions.ts";
import { isJsonObject } from "../../types/json.ts";
import { invalidRequest } from "../errors.ts";

const MAX_SESSION_VAULT_IDS = 20;

export function parseCreateSession(input: unknown): CreateManagedSessionRequest {
  const obj = objectInput(input);
  rejectUnsupportedField(obj, "sandbox");
  rejectUnsupportedField(obj, "sandbox_provider");
  rejectUnsupportedField(obj, "sandboxProviderSelection");
  rejectUnsupportedField(obj, "sandboxProviderSelectionOptions");
  rejectUnsupportedField(obj, "sandboxProviderFactory");
  rejectUnknownFields(obj, [
    "agent",
    "environment_id",
    "vault_ids",
    "title",
    "metadata",
    "resources",
  ]);
  return {
    agent: agentField(obj),
    environment_id: stringField(obj, "environment_id", { required: true }),
    vault_ids: vaultIdsField(obj),
    title: nullableStringField(obj, "title") ?? undefined,
    metadata: metadataField(obj) ?? undefined,
    resources: resourcesField(obj),
  };
}

function vaultIdsField(obj: Record<string, unknown>): string[] | undefined {
  const value = obj.vault_ids;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw invalidRequest("`vault_ids` must be an array of vault ids");
  }
  if (value.length > MAX_SESSION_VAULT_IDS) {
    throw invalidRequest(
      `\`vault_ids\` must contain at most ${MAX_SESSION_VAULT_IDS} vaults`,
    );
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.startsWith("vlt_")) {
      throw invalidRequest("`vault_ids` entries must be vault ids");
    }
    return item;
  });
}

export function parseAgentRef(agent: CreateManagedSessionRequest["agent"]): {
  id: string;
  version?: number;
} {
  if (typeof agent === "string") return { id: agent };
  return agent.version === undefined
    ? { id: agent.id }
    : { id: agent.id, version: agent.version };
}

function rejectUnsupportedField(obj: Record<string, unknown>, field: string): void {
  if (obj[field] !== undefined) {
    throw invalidRequest(`Field \`${field}\` is not yet supported by this server.`);
  }
}

function rejectUnknownFields(
  obj: Record<string, unknown>,
  allowedFields: string[],
): void {
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(obj)) {
    if (allowed.has(field)) continue;
    throw invalidRequest(`Unsupported session create field: \`${field}\`.`);
  }
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!isJsonObject(input)) {
    throw invalidRequest("Request body must be a JSON object");
  }
  return input;
}

function agentField(obj: Record<string, unknown>): CreateManagedSessionRequest["agent"] {
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

function resourcesField(
  obj: Record<string, unknown>,
): CreateManagedSessionResourceInput[] | undefined {
  const value = obj.resources;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw invalidRequest("`resources` must be an array");
  }
  return value.map((entry, index) => resourceField(entry, index));
}

function resourceField(
  value: unknown,
  index: number,
): CreateManagedSessionResourceInput {
  if (!isJsonObject(value)) {
    throw invalidRequest(`\`resources[${index}]\` must be an object`);
  }
  const type = stringField(value, "type", { required: true });
  if (type !== "file") {
    throw invalidRequest(`Unsupported session resource type: ${type}.`);
  }
  rejectUnknownFields(value, ["type", "file_id", "mount_path"]);
  const mountPath = nullableStringField(value, "mount_path");
  return {
    type,
    file_id: resourceStringField(value, "file_id", index),
    ...(mountPath === undefined || mountPath === null ? {} : { mount_path: mountPath }),
  };
}

function resourceStringField(
  obj: Record<string, unknown>,
  field: string,
  index: number,
): string {
  const value = obj[field];
  if (typeof value === "string" && value.length > 0) return value;
  throw invalidRequest(`\`resources[${index}].${field}\` must be a non-empty string`);
}
