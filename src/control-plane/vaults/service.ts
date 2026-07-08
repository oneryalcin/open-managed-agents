import { newVaultCredentialId, newVaultId } from "../ids.ts";
import { conflict, invalidRequest, notFound } from "../errors.ts";
import type { WorkspaceId } from "../workspace.ts";
import type {
  ListVaultCredentialsOptions,
  ListVaultsOptions,
  ManagedDeletedVault,
  ManagedVault,
  ManagedVaultCredential,
  VaultCredentialResolution,
  VaultCredentialRow,
  VaultRow,
  VaultService,
  VaultStore,
} from "./types.ts";

const MAX_DISPLAY_NAME_LENGTH = 255;
const MAX_METADATA_PAIRS = 16;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_VALUE_LENGTH = 512;
const MAX_CREDENTIALS_PER_VAULT = 20;

export class DefaultVaultService implements VaultService {
  constructor(private readonly store: VaultStore) {}

  createVault(workspaceId: WorkspaceId, input: unknown): ManagedVault {
    const req = parseVaultCreate(input);
    const now = new Date().toISOString();
    return toManagedVault(
      this.store.createVault({
        row: {
          id: newVaultId(),
          workspace_id: workspaceId,
          type: "vault",
          display_name: req.displayName,
          metadata: req.metadata,
          created_at: now,
          updated_at: now,
          archived_at: null,
        },
      }),
    );
  }

  retrieveVault(workspaceId: WorkspaceId, vaultId: string): ManagedVault {
    const row = this.store.retrieveVaultAny(workspaceId, vaultId);
    if (!row) throw notFound(`Vault ${vaultId} not found`);
    return toManagedVault(row);
  }

  listVaults(workspaceId: WorkspaceId, opts: ListVaultsOptions = {}) {
    const page = this.store.listVaults(workspaceId, opts);
    return {
      data: page.data.map(toManagedVault),
      has_more: page.has_more,
      next_page: page.next_page,
    };
  }

  updateVault(
    workspaceId: WorkspaceId,
    vaultId: string,
    input: unknown,
  ): ManagedVault {
    const updates = parseVaultUpdate(input);
    const row = this.store.updateVault(
      workspaceId,
      vaultId,
      updates,
      new Date().toISOString(),
    );
    if (!row) throw notFound(`Vault ${vaultId} not found`);
    return toManagedVault(row);
  }

  archiveVault(workspaceId: WorkspaceId, vaultId: string): ManagedVault {
    const row = this.store.archiveVault(
      workspaceId,
      vaultId,
      new Date().toISOString(),
    );
    if (!row) throw notFound(`Vault ${vaultId} not found`);
    return toManagedVault(row);
  }

  deleteVault(workspaceId: WorkspaceId, vaultId: string): ManagedDeletedVault {
    if (!this.store.deleteVault(workspaceId, vaultId)) {
      throw notFound(`Vault ${vaultId} not found`);
    }
    return { id: vaultId, type: "vault_deleted" };
  }

  createCredential(
    workspaceId: WorkspaceId,
    vaultId: string,
    input: unknown,
  ): ManagedVaultCredential {
    const vault = this.store.retrieveVault(workspaceId, vaultId);
    if (!vault) throw notFound(`Vault ${vaultId} not found`);
    if (
      this.store.countActiveCredentials(workspaceId, vaultId) >=
      MAX_CREDENTIALS_PER_VAULT
    ) {
      throw invalidRequest(
        `Vault ${vaultId} cannot have more than ${MAX_CREDENTIALS_PER_VAULT} active credentials`,
      );
    }
    const req = parseCredentialCreate(input);
    const now = new Date().toISOString();
    try {
      return toManagedCredential(
        this.store.createCredential({
          row: {
            id: newVaultCredentialId(),
            workspace_id: workspaceId,
            vault_id: vault.id,
            type: "vault_credential",
            display_name: req.displayName,
            metadata: req.metadata,
            auth: {
              type: "static_bearer",
              mcp_server_url: req.mcpServerUrl,
            },
            created_at: now,
            updated_at: now,
            archived_at: null,
          },
          token: req.token,
        }),
      );
    } catch (error) {
      if (isSqliteUniqueConstraint(error)) {
        throw conflict(
          `An active credential for that MCP server already exists in vault ${vaultId}`,
        );
      }
      if (error instanceof Error && error.message.startsWith("Secrets require")) {
        throw invalidRequest(error.message);
      }
      throw error;
    }
  }

  retrieveCredential(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): ManagedVaultCredential {
    this.assertVaultExists(workspaceId, vaultId);
    const row = this.store.retrieveCredentialAny(
      workspaceId,
      vaultId,
      credentialId,
    );
    if (!row) throw notFound(`Vault credential ${credentialId} not found`);
    return toManagedCredential(row);
  }

  listCredentials(
    workspaceId: WorkspaceId,
    vaultId: string,
    opts: ListVaultCredentialsOptions = {},
  ) {
    this.assertVaultExists(workspaceId, vaultId);
    const page = this.store.listCredentials(workspaceId, vaultId, opts);
    return {
      data: page.data.map(toManagedCredential),
      has_more: page.has_more,
      next_page: page.next_page,
    };
  }

  updateCredential(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
    input: unknown,
  ): ManagedVaultCredential {
    this.assertVaultExists(workspaceId, vaultId);
    const req = parseCredentialUpdate(input);
    try {
      const row = this.store.updateCredential(
        workspaceId,
        vaultId,
        credentialId,
        req,
        new Date().toISOString(),
      );
      if (!row) throw notFound(`Vault credential ${credentialId} not found`);
      return toManagedCredential(row);
    } catch (error) {
      if (isSqliteUniqueConstraint(error)) {
        throw conflict(
          `An active credential for that MCP server already exists in vault ${vaultId}`,
        );
      }
      if (error instanceof Error && error.message.startsWith("Secrets require")) {
        throw invalidRequest(error.message);
      }
      throw error;
    }
  }

  archiveCredential(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): ManagedVaultCredential {
    this.assertVaultExists(workspaceId, vaultId);
    const row = this.store.archiveCredential(
      workspaceId,
      vaultId,
      credentialId,
      new Date().toISOString(),
    );
    if (!row) throw notFound(`Vault credential ${credentialId} not found`);
    return toManagedCredential(row);
  }

  deleteCredential(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): void {
    this.assertVaultExists(workspaceId, vaultId);
    if (!this.store.deleteCredential(workspaceId, vaultId, credentialId)) {
      throw notFound(`Vault credential ${credentialId} not found`);
    }
  }

  assertVaultsUsable(workspaceId: WorkspaceId, vaultIds: readonly string[]): void {
    const seen = new Set<string>();
    for (const vaultId of vaultIds) {
      if (seen.has(vaultId)) continue;
      seen.add(vaultId);
      const row = this.store.retrieveVault(workspaceId, vaultId);
      if (!row) throw invalidRequest(`Vault ${vaultId} not found`);
    }
  }

  resolveCredential(
    workspaceId: WorkspaceId,
    vaultIds: readonly string[],
    serverUrl: string,
  ): VaultCredentialResolution | undefined {
    return this.store.resolveCredential(workspaceId, vaultIds, serverUrl);
  }

  private assertVaultExists(workspaceId: WorkspaceId, vaultId: string): VaultRow {
    const row = this.store.retrieveVaultAny(workspaceId, vaultId);
    if (!row) throw notFound(`Vault ${vaultId} not found`);
    return row;
  }
}

function parseVaultCreate(input: unknown): {
  displayName: string;
  metadata: Record<string, string>;
} {
  const obj = objectInput(input);
  return {
    displayName: displayNameField(obj, "display_name", { required: true }),
    metadata: metadataField(obj.metadata),
  };
}

function parseVaultUpdate(input: unknown): {
  displayName?: string;
  metadata?: Record<string, string>;
} {
  const obj = objectInput(input);
  const updates: { displayName?: string; metadata?: Record<string, string> } = {};
  if (obj.display_name !== undefined) {
    updates.displayName = displayNameField(obj, "display_name", { required: true });
  }
  if (obj.metadata !== undefined) {
    updates.metadata = metadataField(obj.metadata);
  }
  return updates;
}

function parseCredentialCreate(input: unknown): {
  displayName: string | null;
  metadata: Record<string, string>;
  mcpServerUrl: string;
  token: string;
} {
  const obj = objectInput(input);
  const auth = authObject(obj.auth);
  return {
    displayName:
      obj.display_name === undefined
        ? null
        : nullableDisplayNameField(obj, "display_name"),
    metadata: metadataField(obj.metadata),
    mcpServerUrl: mcpServerUrlField(auth, "mcp_server_url", { required: true }),
    token: stringField(auth, "token", { required: true }),
  };
}

function parseCredentialUpdate(input: unknown): {
  displayName?: string | null;
  metadata?: Record<string, string>;
  token?: string;
} {
  const obj = objectInput(input);
  const updates: {
    displayName?: string | null;
    metadata?: Record<string, string>;
    token?: string;
  } = {};
  if (obj.display_name !== undefined) {
    updates.displayName = nullableDisplayNameField(obj, "display_name");
  }
  if (obj.metadata !== undefined) {
    updates.metadata = metadataField(obj.metadata);
  }
  if (obj.auth !== undefined) {
    const auth = authObject(obj.auth);
    if (auth.mcp_server_url !== undefined) {
      throw invalidRequest("`auth.mcp_server_url` is immutable");
    }
    updates.token = stringField(auth, "token", { required: true });
  }
  return updates;
}

function authObject(input: unknown): Record<string, unknown> {
  if (!isObject(input)) throw invalidRequest("`auth` must be a JSON object");
  const type = stringField(input, "type", { required: true });
  if (type !== "static_bearer") {
    throw invalidRequest("Only `static_bearer` credentials are supported");
  }
  return input;
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!isObject(input)) throw invalidRequest("Request body must be a JSON object");
  return input;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayNameField(
  obj: Record<string, unknown>,
  field: string,
  opts: { required?: boolean } = {},
): string {
  const value = stringField(obj, field, opts);
  if (value.length > MAX_DISPLAY_NAME_LENGTH) {
    throw invalidRequest(
      `\`${field}\` must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
    );
  }
  return value;
}

function nullableDisplayNameField(
  obj: Record<string, unknown>,
  field: string,
): string | null {
  const value = obj[field];
  if (value === null) return null;
  return displayNameField(obj, field, { required: true });
}

function mcpServerUrlField(
  obj: Record<string, unknown>,
  field: string,
  opts: { required?: boolean } = {},
): string {
  const value = stringField(obj, field, opts);
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw invalidRequest(`\`${field}\` must be an http(s) URL`);
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.name === "ApiError") throw error;
    throw invalidRequest(`\`${field}\` must be an http(s) URL`);
  }
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

function metadataField(input: unknown): Record<string, string> {
  if (input === undefined) return {};
  if (!isObject(input)) throw invalidRequest("`metadata` must be a JSON object");
  const entries = Object.entries(input);
  if (entries.length > MAX_METADATA_PAIRS) {
    throw invalidRequest(`\`metadata\` must have at most ${MAX_METADATA_PAIRS} pairs`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_METADATA_KEY_LENGTH) {
      throw invalidRequest(
        `\`metadata\` keys must be 1-${MAX_METADATA_KEY_LENGTH} characters`,
      );
    }
    if (typeof value !== "string") {
      throw invalidRequest("`metadata` values must be strings");
    }
    if (value.length > MAX_METADATA_VALUE_LENGTH) {
      throw invalidRequest(
        `\`metadata\` values must be at most ${MAX_METADATA_VALUE_LENGTH} characters`,
      );
    }
    out[key] = value;
  }
  return out;
}

function toManagedVault(row: VaultRow): ManagedVault {
  return {
    id: row.id,
    type: "vault",
    display_name: row.display_name,
    metadata: row.metadata,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
}

function toManagedCredential(row: VaultCredentialRow): ManagedVaultCredential {
  return {
    id: row.id,
    type: "vault_credential",
    vault_id: row.vault_id,
    display_name: row.display_name,
    metadata: row.metadata,
    auth: row.auth,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
}

function isSqliteUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE" ||
      error.message.includes("UNIQUE constraint failed"))
  );
}
