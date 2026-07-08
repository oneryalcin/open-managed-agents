// Minimal workspace-scoped secrets management surface (plan 0117e-2, ADR
// 0016 §4). Values are WRITE-ONLY at this layer: no method ever returns a
// secret's plaintext — `reveal` stays exclusive to the egress injection
// boundary (0117c). Authorization is the single workspace tier every other
// managed-agents route uses (plan 0117e §"Authorization model"): the
// sandboxed agent never holds the workspace key, so it structurally cannot
// reach this service.
import { invalidRequest, notFound } from "../errors.ts";
import type { WorkspaceId } from "../workspace.ts";
import type { SecretMetadata, SecretsStore } from "./types.ts";
import { VAULT_SECRET_PREFIX } from "../vaults/store.ts";

// Wire shape: metadata only, workspace implied by the caller's key.
export interface ManagedSecret {
  id: string;
  type: "secret";
  name: string;
  created_at: string;
  updated_at: string;
}

export interface SecretsService {
  create(workspaceId: WorkspaceId, input: unknown): ManagedSecret;
  list(workspaceId: WorkspaceId): ManagedSecret[];
  delete(workspaceId: WorkspaceId, name: string): void;
}

export const MAX_SECRET_NAME_LENGTH = 256;

export class DefaultSecretsService implements SecretsService {
  // undefined = no master key configured; every route then fails with a
  // clear 400 instead of pretending secrets exist.
  constructor(private readonly store: SecretsStore | undefined) {}

  create(workspaceId: WorkspaceId, input: unknown): ManagedSecret {
    const store = this.requireStore();
    const { name, value } = parseCreateSecret(input);
    if (name.startsWith(VAULT_SECRET_PREFIX)) {
      throw invalidRequest(
        `Secret names starting with ${JSON.stringify(VAULT_SECRET_PREFIX)} are reserved`,
      );
    }
    return toManagedSecret(store.put(workspaceId, name, value));
  }

  list(workspaceId: WorkspaceId): ManagedSecret[] {
    return this.requireStore()
      .list(workspaceId)
      .filter((row) => !row.name.startsWith(VAULT_SECRET_PREFIX))
      .map(toManagedSecret);
  }

  delete(workspaceId: WorkspaceId, name: string): void {
    if (name.startsWith(VAULT_SECRET_PREFIX)) {
      throw invalidRequest(
        `Secret names starting with ${JSON.stringify(VAULT_SECRET_PREFIX)} are reserved`,
      );
    }
    if (!this.requireStore().delete(workspaceId, name)) {
      throw notFound(`Secret ${name} not found`);
    }
  }

  private requireStore(): SecretsStore {
    if (this.store === undefined) {
      throw invalidRequest(
        "Secrets require a master key: set OMA_MASTER_KEY or OMA_MASTER_KEY_FILE on the deployment",
      );
    }
    return this.store;
  }
}

function parseCreateSecret(input: unknown): { name: string; value: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRequest("Request body must be a JSON object");
  }
  const { name, value } = input as { name?: unknown; value?: unknown };
  if (typeof name !== "string" || name.length === 0) {
    throw invalidRequest("`name` must be a non-empty string");
  }
  if (name.length > MAX_SECRET_NAME_LENGTH) {
    throw invalidRequest(
      `\`name\` must be at most ${MAX_SECRET_NAME_LENGTH} characters`,
    );
  }
  if (typeof value !== "string" || value.length === 0) {
    throw invalidRequest("`value` must be a non-empty string");
  }
  return { name, value };
}

function toManagedSecret(row: SecretMetadata): ManagedSecret {
  return {
    id: row.id,
    type: "secret",
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
