import { createHash } from "node:crypto";
import type { ManagedAgentsListPage } from "../../types/common.ts";
import type {
  CreateManagedSessionRequest,
  CreateManagedSessionResourceInput,
  ManagedAgentsDeletedSession,
  ManagedAgentsSession,
  ManagedAgentsSessionFileResource,
} from "../../types/sessions.ts";
import { isJsonObject } from "../../types/json.ts";
import type { AgentStore } from "../agents/types.ts";
import type { EnvironmentStore } from "../environments/types.ts";
import { invalidRequest, notFound } from "../errors.ts";
import type { FileStorage, FileStorageRecord } from "../files/types.ts";
import { newSessionId, newSessionResourceId } from "../ids.ts";
import type { WorkspaceId } from "../workspace.ts";
import {
  normalizeSessionFileResources,
  type SessionFileResourceMountInput,
} from "./resources.ts";
import type {
  ListSessionsOptions,
  SessionFileMountSnapshotRow,
  SessionRow,
  SessionService,
  SessionStore,
} from "./types.ts";

const MAX_SESSION_FILE_RESOURCES = 10;
const MAX_SESSION_MOUNTED_BYTES = 50 * 1024 * 1024;

export interface DefaultSessionServiceOptions {
  maxFileResources?: number;
  maxMountedBytes?: number;
}

export class DefaultSessionService implements SessionService {
  private readonly maxFileResources: number;
  private readonly maxMountedBytes: number;

  constructor(
    private readonly store: SessionStore,
    private readonly agents: AgentStore,
    private readonly environments: EnvironmentStore,
    private readonly files?: FileStorage,
    opts: DefaultSessionServiceOptions = {},
  ) {
    this.maxFileResources = opts.maxFileResources ?? MAX_SESSION_FILE_RESOURCES;
    this.maxMountedBytes = opts.maxMountedBytes ?? MAX_SESSION_MOUNTED_BYTES;
  }

  async create(
    workspaceId: WorkspaceId,
    input: unknown,
  ): Promise<ManagedAgentsSession> {
    const req = parseCreateSession(input);
    const agentRef = parseAgentRef(req.agent);
    const agent = this.agents.retrieve(workspaceId, agentRef.id);
    if (!agent) {
      throw invalidRequest(`Agent ${agentRef.id} not found`);
    }
    if (agentRef.version !== undefined && agentRef.version !== agent.version) {
      throw invalidRequest(
        `Agent ${agentRef.id} has version ${agent.version}; requested version ${agentRef.version} not found`,
      );
    }
    const environment = this.environments.retrieve(workspaceId, req.environment_id);
    if (!environment) {
      throw invalidRequest(`Environment ${req.environment_id} not found`);
    }

    const now = new Date().toISOString();
    const { resources, snapshots } = await this.prepareFileResources(
      workspaceId,
      req.resources ?? [],
      now,
    );
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
      resources,
    };
    const sessionSnapshots = snapshots.map((snapshot) => ({
      ...snapshot,
      session_id: row.id,
    }));
    try {
      return toManagedSession(this.store.create({ row, snapshots: sessionSnapshots }));
    } catch (error) {
      await this.deleteSnapshotsBestEffort(workspaceId, sessionSnapshots);
      throw error;
    }
  }

  retrieve(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): ManagedAgentsSession {
    const row = this.store.retrieveAny(workspaceId, sessionId);
    if (!row) {
      throw notFound(`Session ${sessionId} not found`);
    }
    return toManagedSession(row);
  }

  archive(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): ManagedAgentsSession {
    const archivedAt = new Date().toISOString();
    const row = this.store.archive(workspaceId, sessionId, archivedAt);
    if (!row) {
      throw notFound(`Session ${sessionId} not found`);
    }
    return toManagedSession(row);
  }

  async delete(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<ManagedAgentsDeletedSession> {
    const snapshots = this.store.getFileMountSnapshots(workspaceId, sessionId);
    const row = this.store.delete(workspaceId, sessionId);
    if (!row) {
      throw notFound(`Session ${sessionId} not found`);
    }
    await this.deleteSnapshotsBestEffort(workspaceId, snapshots);
    return { id: row.id, type: "session_deleted" };
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

  private async prepareFileResources(
    workspaceId: WorkspaceId,
    resources: CreateManagedSessionResourceInput[],
    now: string,
  ): Promise<{
    resources: ManagedAgentsSessionFileResource[];
    snapshots: Array<Omit<SessionFileMountSnapshotRow, "session_id">>;
  }> {
    if (resources.length === 0) return { resources: [], snapshots: [] };
    if (!this.files) {
      throw invalidRequest("File resources are not supported by this server.");
    }
    if (resources.length > this.maxFileResources) {
      throw invalidRequest(
        `Session file resources exceed the ${this.maxFileResources} file limit`,
      );
    }

    const normalized = normalizeSessionFileResources(
      resources.map(
        (resource): SessionFileResourceMountInput => ({
          fileId: resource.file_id,
          mountPath: resource.mount_path,
        }),
      ),
    );
    const prepared: Array<{
      source: FileStorageRecord;
      bytes: Uint8Array;
      resourceId: string;
      mountPath: string;
    }> = [];
    let totalBytes = 0;
    for (const resource of normalized) {
      const source = await this.files.retrieveMetadata(workspaceId, resource.fileId);
      if (!source) {
        throw invalidRequest(`File ${resource.fileId} not found`);
      }
      const stream = await this.files.openBytes(workspaceId, resource.fileId);
      if (!stream) {
        throw invalidRequest(`File ${resource.fileId} not found`);
      }
      const bytes = await consumeBytes(stream);
      const sha256 = sha256Hex(bytes);
      if (sha256 !== source.sha256) {
        throw invalidRequest(`File ${resource.fileId} failed integrity validation`);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > this.maxMountedBytes) {
        throw invalidRequest(
          `Session file resources exceed the ${limitLabel(this.maxMountedBytes)} mounted byte limit`,
        );
      }
      prepared.push({
        source,
        bytes,
        resourceId: newSessionResourceId(),
        mountPath: resource.mountPath,
      });
    }

    const createdSnapshots: Array<Omit<SessionFileMountSnapshotRow, "session_id">> = [];
    try {
      for (const item of prepared) {
        const snapshot = await this.files.createInternalSnapshot(workspaceId, {
          filename: item.source.metadata.filename,
          mimeType: item.source.metadata.mime_type,
          scopeId: item.resourceId,
          body: item.bytes,
        });
        createdSnapshots.push({
          workspace_id: workspaceId,
          resource_id: item.resourceId,
          file_id: item.source.metadata.id,
          mount_path: item.mountPath,
          snapshot_file_id: snapshot.metadata.id,
          sha256: snapshot.sha256,
          size_bytes: snapshot.metadata.size_bytes,
        });
      }
    } catch (error) {
      await this.deleteSnapshotsBestEffort(workspaceId, createdSnapshots);
      throw error;
    }

    return {
      resources: prepared.map((item) => ({
        id: item.resourceId,
        type: "file",
        file_id: item.source.metadata.id,
        mount_path: item.mountPath,
        created_at: now,
        updated_at: now,
      })),
      snapshots: createdSnapshots,
    };
  }

  private async deleteSnapshotsBestEffort(
    workspaceId: WorkspaceId,
    snapshots: Array<Pick<SessionFileMountSnapshotRow, "snapshot_file_id">>,
  ): Promise<void> {
    if (!this.files) return;
    await Promise.all(
      snapshots.map(async (snapshot) => {
        try {
          await this.files?.deleteInternalSnapshot(workspaceId, snapshot.snapshot_file_id);
        } catch {
          // Best-effort cleanup; a durable backend can add orphan sweeping.
        }
      }),
    );
  }
}

function parseCreateSession(input: unknown): CreateManagedSessionRequest {
  const obj = objectInput(input);
  rejectUnsupportedField(obj, "sandbox");
  rejectUnsupportedField(obj, "sandbox_provider");
  rejectUnsupportedField(obj, "sandboxProviderSelection");
  rejectUnsupportedField(obj, "sandboxProviderSelectionOptions");
  rejectUnsupportedField(obj, "sandboxProviderFactory");
  rejectUnsupportedField(obj, "vault_ids");
  rejectUnknownFields(obj, ["agent", "environment_id", "title", "metadata", "resources"]);
  return {
    agent: agentField(obj),
    environment_id: stringField(obj, "environment_id", { required: true }),
    title: nullableStringField(obj, "title") ?? undefined,
    metadata: metadataField(obj) ?? undefined,
    resources: resourcesField(obj),
  };
}

function parseAgentRef(agent: CreateManagedSessionRequest["agent"]): {
  id: string;
  version?: number;
} {
  if (typeof agent === "string") return { id: agent };
  return agent.version === undefined
    ? { id: agent.id }
    : { id: agent.id, version: agent.version };
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
    resources: row.resources.map((resource) => ({
      id: resource.id,
      type: resource.type,
      file_id: resource.file_id,
      mount_path: resource.mount_path,
      created_at: resource.created_at,
      updated_at: resource.updated_at,
    })),
  };
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

async function consumeBytes(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    totalLength += chunk.byteLength;
  }
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function limitLabel(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  return `${bytes} bytes`;
}
