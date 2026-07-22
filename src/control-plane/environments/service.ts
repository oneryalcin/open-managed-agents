import { newEnvironmentId } from "../ids.ts";
import { conflict, invalidRequest, notFound } from "../errors.ts";
import {
  canonicalizeNetworkingConfig,
  EgressPolicyError,
} from "../egress/policy.ts";
import type { ManagedAgentsListPage } from "../../types/common.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import { isJsonObject, isJsonValue } from "../../types/json.ts";
import type {
  CreateManagedEnvironmentRequest,
  EnvironmentRow,
  EnvironmentService,
  EnvironmentStore,
  ListEnvironmentsOptions,
} from "./types.ts";
import type { WorkspaceId } from "../workspace.ts";
import type { SessionStore } from "../sessions/types.ts";

export class DefaultEnvironmentService implements EnvironmentService {
  constructor(
    private readonly store: EnvironmentStore,
    private readonly sessions?: Pick<SessionStore, "hasEnvironmentReference">,
  ) {}

  create(
    workspaceId: WorkspaceId,
    input: unknown,
  ): ManagedAgentsEnvironment {
    const req = parseCreateEnvironment(input);
    const now = new Date().toISOString();
    const row: EnvironmentRow = {
      id: newEnvironmentId(),
      workspace_id: workspaceId,
      type: "environment",
      name: req.name,
      config: req.config,
      metadata: req.metadata ?? {},
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    return toManagedEnvironment(this.store.create({ row }));
  }

  retrieve(
    workspaceId: WorkspaceId,
    environmentId: string,
  ): ManagedAgentsEnvironment {
    const row = this.store.retrieveAny(workspaceId, environmentId);
    if (!row) {
      throw notFound(`Environment ${environmentId} not found`);
    }
    return toManagedEnvironment(row);
  }

  list(
    workspaceId: WorkspaceId,
    opts: ListEnvironmentsOptions = {},
  ): ManagedAgentsListPage<ManagedAgentsEnvironment> {
    const page = this.store.list(workspaceId, opts);
    return {
      data: page.data.map(toManagedEnvironment),
      has_more: page.has_more,
      next_page: page.next_page,
    };
  }

  archive(
    workspaceId: WorkspaceId,
    environmentId: string,
  ): ManagedAgentsEnvironment {
    const row = this.store.archive(
      workspaceId,
      environmentId,
      new Date().toISOString(),
    );
    if (!row) {
      throw notFound(`Environment ${environmentId} not found`);
    }
    return toManagedEnvironment(row);
  }

  delete(
    workspaceId: WorkspaceId,
    environmentId: string,
  ): { type: "environment_deleted"; id: string } {
    const existing = this.store.retrieveAny(workspaceId, environmentId);
    if (!existing) {
      throw notFound(`Environment ${environmentId} not found`);
    }
    if (!this.sessions) {
      throw conflict("Environment deletion is unavailable without session reference checks");
    }
    if (this.sessions.hasEnvironmentReference(workspaceId, environmentId)) {
      throw conflict("Environment cannot be deleted while sessions reference it");
    }
    this.store.delete(workspaceId, environmentId);
    return { type: "environment_deleted", id: environmentId };
  }
}

function parseCreateEnvironment(input: unknown): CreateManagedEnvironmentRequest {
  const obj = objectInput(input);
  const name = stringField(obj, "name", { required: true });
  const config = obj.config;
  if (!isJsonObject(config)) {
    throw invalidRequest("`config` must be a JSON object");
  }
  if (!isJsonValue(config)) {
    throw invalidRequest("`config` must be JSON-compatible");
  }
  let canonicalConfig: typeof config;
  try {
    // Validate before the row is built or handed to the store. This keeps
    // unsupported hosted shapes from becoming durable, silently inert config.
    canonicalConfig = canonicalizeNetworkingConfig(config);
  } catch (error) {
    if (error instanceof EgressPolicyError) {
      throw invalidRequest(`Invalid environment networking config: ${error.message}`);
    }
    throw error;
  }
  return { name, config: canonicalConfig, metadata: metadataField(obj) };
}

function toManagedEnvironment(row: EnvironmentRow): ManagedAgentsEnvironment {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    config: row.config,
    metadata: row.metadata ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
}

function metadataField(obj: Record<string, unknown>): Record<string, string> | undefined {
  const value = obj.metadata;
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) throw invalidRequest("`metadata` must be an object");
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw invalidRequest("`metadata` values must be strings");
    metadata[key] = item;
  }
  return metadata;
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
