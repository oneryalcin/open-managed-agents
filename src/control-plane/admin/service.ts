import { invalidRequest, notFound } from "../errors.ts";
import type { WorkspaceId } from "../workspace.ts";
import type {
  MintedWorkspaceApiKey,
  SqliteWorkspaceStore,
  WorkspaceApiKeyRow,
  WorkspaceRow,
} from "../workspaces/store.ts";

export interface AdminWorkspace {
  id: string;
  name: string;
  created_at: string;
}

export interface AdminMintedKey {
  workspace_id: string;
  label: string;
  key_sha256: string;
  api_key: string;
}

export interface AdminKeyMetadata {
  key_sha256: string;
  workspace_id: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
}

export interface AdminService {
  createWorkspace(input: unknown): AdminWorkspace;
  listWorkspaces(): AdminWorkspace[];
  getWorkspace(workspaceId: WorkspaceId): AdminWorkspace;
  mintKey(workspaceId: WorkspaceId, input: unknown): AdminMintedKey;
  listKeys(workspaceId: WorkspaceId): AdminKeyMetadata[];
  revokeKey(keySha256: string): AdminKeyMetadata;
}

export class DefaultAdminService implements AdminService {
  constructor(private readonly workspaces: SqliteWorkspaceStore) {}

  createWorkspace(input: unknown): AdminWorkspace {
    const { name } = parseCreateWorkspace(input);
    return toAdminWorkspace(this.workspaces.createWorkspace(name));
  }

  listWorkspaces(): AdminWorkspace[] {
    return this.workspaces.listWorkspaces().map(toAdminWorkspace);
  }

  getWorkspace(workspaceId: WorkspaceId): AdminWorkspace {
    const row = this.workspaces.getWorkspace(workspaceId);
    if (!row) throw notFound(`Workspace not found: ${workspaceId}`);
    return toAdminWorkspace(row);
  }

  mintKey(workspaceId: WorkspaceId, input: unknown): AdminMintedKey {
    const { label } = parseMintKey(input);
    try {
      return toAdminMintedKey(this.workspaces.mintKey(workspaceId, label));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Workspace not found:")) {
        throw notFound(error.message);
      }
      throw error;
    }
  }

  listKeys(workspaceId: WorkspaceId): AdminKeyMetadata[] {
    if (!this.workspaces.getWorkspace(workspaceId)) {
      throw notFound(`Workspace not found: ${workspaceId}`);
    }
    return this.workspaces.listKeys(workspaceId).map(toAdminKeyMetadata);
  }

  revokeKey(keySha256: string): AdminKeyMetadata {
    const existing = this.workspaces.getKey(keySha256);
    if (!existing) throw notFound(`Key not found: ${keySha256}`);
    if (existing.revoked_at !== null) return toAdminKeyMetadata(existing);
    this.workspaces.revokeKey(keySha256);
    return toAdminKeyMetadata(this.workspaces.getKey(keySha256) ?? existing);
  }
}

function parseCreateWorkspace(input: unknown): { name: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRequest("Request body must be a JSON object");
  }
  const { name } = input as { name?: unknown };
  if (typeof name !== "string" || name.trim().length === 0) {
    throw invalidRequest("`name` must be a non-empty string");
  }
  return { name: name.trim() };
}

function parseMintKey(input: unknown): { label: string } {
  if (input === undefined) return { label: "default" };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRequest("Request body must be a JSON object");
  }
  const { label = "default" } = input as { label?: unknown };
  if (typeof label !== "string" || label.trim().length === 0) {
    throw invalidRequest("`label` must be a non-empty string");
  }
  return { label: label.trim() };
}

function toAdminWorkspace(row: WorkspaceRow): AdminWorkspace {
  return {
    id: row.workspace_id,
    name: row.name,
    created_at: row.created_at,
  };
}

function toAdminMintedKey(row: MintedWorkspaceApiKey): AdminMintedKey {
  return {
    workspace_id: row.workspaceId,
    label: row.label,
    key_sha256: row.keySha256,
    api_key: row.plaintextKey,
  };
}

function toAdminKeyMetadata(row: WorkspaceApiKeyRow): AdminKeyMetadata {
  return {
    key_sha256: row.key_sha256,
    workspace_id: row.workspace_id,
    label: row.label,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}
