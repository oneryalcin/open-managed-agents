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
  auth: VaultCredentialAuth;
  auth_version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export type VaultCredentialAuth =
  | {
      type: "static_bearer";
      mcp_server_url: string;
    }
  | {
      type: "mcp_oauth";
      mcp_server_url: string;
      expires_at?: string;
      refresh?: {
        token_endpoint: string;
        client_id: string;
        scope?: string;
        token_endpoint_auth: {
          type:
            | "none"
            | "client_secret_basic"
            | "client_secret_post";
        };
      };
    };

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
  auth: VaultCredentialAuth;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ManagedDeletedVault {
  id: string;
  type: "vault_deleted";
}

export interface VaultCredentialResolution {
  vaultId: string;
  credentialId: string;
  authType: VaultCredentialAuth["type"];
  authVersion: number;
  expiresAt?: string;
  refreshStatus: VaultOauthRefreshStatus | null;
  authHintAt: string | null;
  updatedAt: string;
  token: string;
}

export type VaultOauthRefreshStatus = "ok" | "invalid" | "transient";

export interface VaultCredentialRuntimeMetadata {
  vaultId: string;
  credentialId: string;
  authType: VaultCredentialAuth["type"];
  hasRefresh: boolean;
  authVersion: number;
  expiresAt?: string;
  refreshStatus: VaultOauthRefreshStatus | null;
  authHintAt: string | null;
  nextRefreshAt: string | null;
  refreshAttempts: number;
}

export interface PersistAuthHintInput {
  workspaceId: WorkspaceId;
  vaultId: string;
  credentialId: string;
  expectedAuthVersion: number;
  authHintAt: string;
}

export type PersistAuthHintResult =
  | { status: "updated"; metadata: VaultCredentialRuntimeMetadata }
  | { status: "stale"; metadata: VaultCredentialRuntimeMetadata | undefined };

export interface VaultOauthRefreshState {
  workspaceId: WorkspaceId;
  vaultId: string;
  credentialId: string;
  authVersion: number;
  mcpServerUrl: string;
  expiresAt?: string;
  refresh?: {
    tokenEndpoint: string;
    clientId: string;
    scope?: string;
    tokenEndpointAuth: {
      type:
        | "none"
        | "client_secret_basic"
        | "client_secret_post";
    };
  };
  secrets: {
    accessToken?: string;
    refreshToken?: string;
    clientSecret?: string;
  };
  refreshStatus: VaultOauthRefreshStatus | null;
  refreshAttempts: number;
  nextRefreshAt: string | null;
  authHintAt: string | null;
}

export interface PersistOauthRefreshSuccessInput {
  workspaceId: WorkspaceId;
  vaultId: string;
  credentialId: string;
  expectedAuthVersion: number;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string | null;
  scope?: string | null;
  nextRefreshAt?: string | null;
  updatedAt: string;
}

export interface PersistOauthRefreshFailureInput {
  workspaceId: WorkspaceId;
  vaultId: string;
  credentialId: string;
  expectedAuthVersion: number;
  status: Exclude<VaultOauthRefreshStatus, "ok">;
  refreshAttempts: number;
  nextRefreshAt: string | null;
}

export interface OauthRefreshDueCredential {
  workspaceId: WorkspaceId;
  vaultId: string;
  credentialId: string;
  authVersion: number;
  nextRefreshAt: string;
}

export type PersistOauthRefreshResult =
  | { status: "updated"; state: VaultOauthRefreshState }
  | { status: "stale"; state: VaultOauthRefreshState | undefined };

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
  nextRefreshAt?: string | null;
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
      auth?:
        | { type: "static_bearer"; token: string }
        | {
            type: "mcp_oauth";
            expiresAt?: string | null;
            accessToken?: string;
            refreshToken?: string;
          };
    },
    updatedAt: string,
    scheduling?: { nextRefreshAt: string | null },
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
  readCredentialRuntimeMetadata(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): VaultCredentialRuntimeMetadata | undefined;
  persistAuthHint(input: PersistAuthHintInput): PersistAuthHintResult;
  readOauthRefreshState(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): VaultOauthRefreshState | undefined;
  persistOauthRefreshSuccess(
    input: PersistOauthRefreshSuccessInput,
  ): PersistOauthRefreshResult;
  persistOauthRefreshFailure(
    input: PersistOauthRefreshFailureInput,
  ): PersistOauthRefreshResult;
  listDueRefreshes(now: string, limit?: number): OauthRefreshDueCredential[];
  nextDueRefreshAt(now: string): string | null;
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
  deleteVault(workspaceId: WorkspaceId, vaultId: string): ManagedDeletedVault;
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
  readCredentialRuntimeMetadata(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): VaultCredentialRuntimeMetadata | undefined;
  /** Internal validation snapshot; contains secrets and must never be serialized. */
  readOauthValidationSnapshot(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): VaultOauthRefreshState | undefined;
}
