import type { ManagedAgentsListPage } from "../../types/common.ts";
import type { WorkspaceId } from "../workspace.ts";

export interface VaultRow {
  id: string;
  workspace_id: WorkspaceId;
  type: "vault";
  display_name: string;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface VaultCredentialRow {
  id: string;
  workspace_id: WorkspaceId;
  vault_id: string;
  type: "vault_credential";
  display_name: string | null;
  metadata: Record<string, string>;
  auth: {
    type: "static_bearer";
    mcp_server_url: string;
  };
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ManagedVault {
  id: string;
  type: "vault";
  display_name: string;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ManagedVaultCredential {
  id: string;
  type: "vault_credential";
  vault_id: string;
  display_name?: string | null;
  metadata: Record<string, string>;
  auth: {
    type: "static_bearer";
    mcp_server_url: string;
  };
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface VaultCredentialResolution {
  credentialId: string;
  updatedAt: string;
  token: string;
}

export interface ListVaultsOptions {
  page?: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface ListVaultCredentialsOptions {
  page?: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface CreateVaultRecord {
  row: VaultRow;
}

export interface CreateVaultCredentialRecord {
  row: VaultCredentialRow;
  token: string;
}

export interface VaultStore {
  createVault(record: CreateVaultRecord): VaultRow;
  retrieveVault(
    workspaceId: WorkspaceId,
    vaultId: string,
  ): VaultRow | undefined;
  retrieveVaultAny(
    workspaceId: WorkspaceId,
    vaultId: string,
  ): VaultRow | undefined;
  listVaults(
    workspaceId: WorkspaceId,
    opts?: ListVaultsOptions,
  ): ManagedAgentsListPage<VaultRow>;
  updateVault(
    workspaceId: WorkspaceId,
    vaultId: string,
    updates: { displayName?: string; metadata?: Record<string, string> },
    updatedAt: string,
  ): VaultRow | undefined;
  archiveVault(
    workspaceId: WorkspaceId,
    vaultId: string,
    archivedAt: string,
  ): VaultRow | undefined;
  deleteVault(workspaceId: WorkspaceId, vaultId: string): VaultRow | undefined;
  createCredential(record: CreateVaultCredentialRecord): VaultCredentialRow;
  retrieveCredential(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): VaultCredentialRow | undefined;
  retrieveCredentialAny(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): VaultCredentialRow | undefined;
  listCredentials(
    workspaceId: WorkspaceId,
    vaultId: string,
    opts?: ListVaultCredentialsOptions,
  ): ManagedAgentsListPage<VaultCredentialRow>;
  updateCredential(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
    updates: {
      displayName?: string | null;
      metadata?: Record<string, string>;
      token?: string;
    },
    updatedAt: string,
  ): VaultCredentialRow | undefined;
  archiveCredential(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
    archivedAt: string,
  ): VaultCredentialRow | undefined;
  deleteCredential(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): VaultCredentialRow | undefined;
  countActiveCredentials(workspaceId: WorkspaceId, vaultId: string): number;
  resolveCredential(
    workspaceId: WorkspaceId,
    vaultIds: readonly string[],
    serverUrl: string,
  ): VaultCredentialResolution | undefined;
  close?(): void;
}

export interface VaultService {
  createVault(workspaceId: WorkspaceId, input: unknown): ManagedVault;
  retrieveVault(workspaceId: WorkspaceId, vaultId: string): ManagedVault;
  listVaults(
    workspaceId: WorkspaceId,
    opts?: ListVaultsOptions,
  ): ManagedAgentsListPage<ManagedVault>;
  updateVault(
    workspaceId: WorkspaceId,
    vaultId: string,
    input: unknown,
  ): ManagedVault;
  archiveVault(workspaceId: WorkspaceId, vaultId: string): ManagedVault;
  deleteVault(workspaceId: WorkspaceId, vaultId: string): void;
  createCredential(
    workspaceId: WorkspaceId,
    vaultId: string,
    input: unknown,
  ): ManagedVaultCredential;
  retrieveCredential(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): ManagedVaultCredential;
  listCredentials(
    workspaceId: WorkspaceId,
    vaultId: string,
    opts?: ListVaultCredentialsOptions,
  ): ManagedAgentsListPage<ManagedVaultCredential>;
  updateCredential(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
    input: unknown,
  ): ManagedVaultCredential;
  archiveCredential(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): ManagedVaultCredential;
  deleteCredential(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): void;
  assertVaultsUsable(workspaceId: WorkspaceId, vaultIds: readonly string[]): void;
  resolveCredential(
    workspaceId: WorkspaceId,
    vaultIds: readonly string[],
    serverUrl: string,
  ): VaultCredentialResolution | undefined;
}
