import { isIP } from "node:net";
import { isBlockedAddress } from "../egress/ssrf.ts";
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
  VaultCredentialRuntimeMetadata,
  VaultCredentialAuth,
  VaultCredentialRow,
  VaultRow,
  VaultService,
  VaultStore,
} from "./types.ts";
import {
  nextRefreshAt,
  OAUTH_REFRESH_LONG_LIVED_RECHECK_MS,
} from "./oauth-refresh.ts";

const MAX_DISPLAY_NAME_LENGTH = 255;
const MAX_METADATA_PAIRS = 16;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_VALUE_LENGTH = 512;
const MAX_CREDENTIALS_PER_VAULT = 20;
const MAX_TOKEN_ENDPOINT_LENGTH = 2048;
// Floor matches scrubKnownSecrets' MIN_KNOWN_SECRET_LENGTH (logging.ts):
// a token the scrubber cannot safely redact must not be storable, or a
// hostile server echoing the bare token would bypass the #170 scrub
// (review #170, Codex). OMA tightening; real bearer tokens are far longer.
const MIN_TOKEN_LENGTH = 8;

type CredentialAuthInput = Record<string, unknown> & {
  type: "static_bearer" | "mcp_oauth";
};

export class DefaultVaultService implements VaultService {
  constructor(
    private readonly store: VaultStore,
    private readonly opts: {
      onSchedulingChanged?: () => void;
      allowInsecureTokenEndpoint?: (url: URL) => boolean;
    } = {},
  ) {}

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
    const req = parseCredentialCreate(input, this.opts.allowInsecureTokenEndpoint);
    const now = new Date().toISOString();
    try {
      const created = toManagedCredential(
        this.store.createCredential({
          row: {
            id: newVaultCredentialId(),
            workspace_id: workspaceId,
            vault_id: vault.id,
            type: "vault_credential",
            display_name: req.displayName,
            metadata: req.metadata,
            auth: req.auth,
            auth_version: 1,
            created_at: now,
            updated_at: now,
            archived_at: null,
          },
          token: req.secretValue,
          nextRefreshAt: oauthSchedule(
            new Date(now),
            req.auth,
            req.auth.type === "mcp_oauth" && req.auth.refresh !== undefined,
          ),
        }),
      );
      if (req.auth.type === "mcp_oauth" && req.auth.refresh !== undefined) {
        this.opts.onSchedulingChanged?.();
      }
      return created;
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
    const existing = this.store.retrieveCredential(
      workspaceId,
      vaultId,
      credentialId,
    );
    if (!existing) throw notFound(`Vault credential ${credentialId} not found`);
    const req = parseCredentialUpdate(input, existing);
    try {
      const currentOauth = this.store.readOauthRefreshState(
        workspaceId,
        vaultId,
        credentialId,
      );
      const updatedAt = new Date().toISOString();
      const nextAuth = req.auth?.type === "mcp_oauth"
        ? {
            ...existing.auth,
            ...(req.auth.expiresAt === undefined
              ? {}
              : req.auth.expiresAt === null
                ? { expires_at: undefined }
                : { expires_at: req.auth.expiresAt }),
          }
        : existing.auth;
      const row = this.store.updateCredential(
        workspaceId,
        vaultId,
        credentialId,
        req,
        updatedAt,
        req.auth === undefined
          ? undefined
          : {
              nextRefreshAt: oauthSchedule(
                new Date(updatedAt),
                nextAuth,
                req.auth.type === "mcp_oauth" &&
                  (req.auth.refreshToken !== undefined ||
                    currentOauth?.secrets.refreshToken !== undefined),
              ),
            },
      );
      if (!row) throw notFound(`Vault credential ${credentialId} not found`);
      if (req.auth !== undefined) this.opts.onSchedulingChanged?.();
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

  readCredentialRuntimeMetadata(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ): VaultCredentialRuntimeMetadata | undefined {
    return this.store.readCredentialRuntimeMetadata(
      workspaceId,
      vaultId,
      credentialId,
    );
  }

  readOauthValidationSnapshot(
    workspaceId: WorkspaceId,
    vaultId: string,
    credentialId: string,
  ) {
    return this.store.readOauthRefreshState(workspaceId, vaultId, credentialId);
  }

  private assertVaultExists(workspaceId: WorkspaceId, vaultId: string): VaultRow {
    const row = this.store.retrieveVaultAny(workspaceId, vaultId);
    if (!row) throw notFound(`Vault ${vaultId} not found`);
    return row;
  }
}

function oauthSchedule(
  now: Date,
  auth: VaultCredentialAuth,
  hasRefreshToken: boolean,
): string | null {
  if (auth.type !== "mcp_oauth" || auth.refresh === undefined || !hasRefreshToken) {
    return null;
  }
  return auth.expires_at === undefined
    ? new Date(now.getTime() + OAUTH_REFRESH_LONG_LIVED_RECHECK_MS).toISOString()
    : nextRefreshAt(now, new Date(auth.expires_at)).toISOString();
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

function parseCredentialCreate(
  input: unknown,
  allowInsecureTokenEndpoint?: (url: URL) => boolean,
): {
  displayName: string | null;
  metadata: Record<string, string>;
  auth: VaultCredentialRow["auth"];
  secretValue: string;
} {
  const obj = objectInput(input);
  const parsed = parseCredentialAuthCreate(obj.auth, allowInsecureTokenEndpoint);
  return {
    displayName:
      obj.display_name === undefined
        ? null
        : nullableDisplayNameField(obj, "display_name"),
    metadata: metadataField(obj.metadata),
    auth: parsed.auth,
    secretValue: parsed.secretValue,
  };
}

function parseCredentialUpdate(
  input: unknown,
  existing: VaultCredentialRow,
): {
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
} {
  const obj = objectInput(input);
  const updates: {
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
  } = {};
  if (obj.display_name !== undefined) {
    updates.displayName = nullableDisplayNameField(obj, "display_name");
  }
  if (obj.metadata !== undefined) {
    updates.metadata = metadataField(obj.metadata);
  }
  if (obj.auth !== undefined) {
    updates.auth = parseCredentialAuthUpdate(obj.auth, existing);
  }
  return updates;
}

function parseCredentialAuthCreate(
  input: unknown,
  allowInsecureTokenEndpoint?: (url: URL) => boolean,
): {
  auth: VaultCredentialRow["auth"];
  secretValue: string;
} {
  const auth = authObject(input);
  const type = auth.type;
  if (type === "static_bearer") {
    return {
      auth: {
        type,
        mcp_server_url: mcpServerUrlField(auth, "mcp_server_url", {
          required: true,
        }),
      },
      secretValue: staticBearerTokenField(auth),
    };
  }
  const refresh = oauthRefreshCreate(auth.refresh, allowInsecureTokenEndpoint);
  const accessToken = secretField(auth, "access_token", { required: true });
  const expiresAt = expiresAtField(auth.expires_at);
  return {
    auth: {
      type,
      mcp_server_url: mcpServerUrlField(auth, "mcp_server_url", {
        required: true,
      }),
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
      ...(refresh === undefined ? {} : { refresh: refresh.metadata }),
    },
    secretValue: JSON.stringify({
      access_token: accessToken,
      ...(refresh?.refreshToken === undefined
        ? {}
        : { refresh_token: refresh.refreshToken }),
      ...(refresh?.clientSecret === undefined
        ? {}
        : { client_secret: refresh.clientSecret }),
    }),
  };
}

function parseCredentialAuthUpdate(
  input: unknown,
  existing: VaultCredentialRow,
): NonNullable<ReturnType<typeof parseCredentialUpdate>["auth"]> {
  const auth = authObject(input);
  if (auth.type !== existing.auth.type) {
    throw invalidRequest("`auth.type` is immutable");
  }
  if (auth.mcp_server_url !== undefined) {
    throw invalidRequest("`auth.mcp_server_url` is immutable");
  }
  if (auth.type === "static_bearer") {
    return { type: auth.type, token: staticBearerTokenField(auth) };
  }
  if (auth.token_endpoint !== undefined) {
    throw invalidRequest("`auth.token_endpoint` is immutable");
  }
  if (auth.client_id !== undefined) {
    throw invalidRequest("`auth.client_id` is immutable");
  }
  const out: {
    type: "mcp_oauth";
    expiresAt?: string | null;
    accessToken?: string;
    refreshToken?: string;
  } = { type: "mcp_oauth" };
  if (auth.access_token !== undefined) {
    out.accessToken = secretField(auth, "access_token", { required: true });
  }
  if (auth.expires_at !== undefined) {
    out.expiresAt = expiresAtField(auth.expires_at) ?? null;
  }
  if (auth.refresh !== undefined) {
    const refresh = objectField(auth, "refresh");
    for (const field of [
      "token_endpoint",
      "client_id",
      "scope",
      "token_endpoint_auth",
    ]) {
      if (refresh[field] !== undefined) {
        throw invalidRequest(`\`auth.refresh.${field}\` is immutable`);
      }
    }
    out.refreshToken = secretField(refresh, "refresh_token", { required: true });
  }
  if (
    out.accessToken === undefined &&
    out.expiresAt === undefined &&
    out.refreshToken === undefined
  ) {
    throw invalidRequest("`auth` must include an updateable field");
  }
  return out;
}

function staticBearerTokenField(auth: Record<string, unknown>): string {
  return secretField(auth, "token", { required: true });
}

function secretField(
  obj: Record<string, unknown>,
  field: string,
  opts: { required?: boolean } = {},
): string {
  const value = stringField(obj, field, opts);
  if (value.length < MIN_TOKEN_LENGTH) {
    throw invalidRequest(
      `\`${field}\` must be at least ${MIN_TOKEN_LENGTH} characters`,
    );
  }
  return value;
}

function oauthRefreshCreate(
  input: unknown,
  allowInsecureTokenEndpoint?: (url: URL) => boolean,
):
  | {
      metadata: NonNullable<Extract<VaultCredentialAuth, { type: "mcp_oauth" }>["refresh"]>;
      refreshToken: string;
      clientSecret?: string;
    }
  | undefined {
  if (input === undefined) return undefined;
  const refresh = objectField({ refresh: input }, "refresh");
  const tokenEndpoint = tokenEndpointField(
    refresh,
    "token_endpoint",
    allowInsecureTokenEndpoint,
  );
  const clientId = stringField(refresh, "client_id", { required: true });
  const scope =
    refresh.scope === undefined
      ? undefined
      : stringField(refresh, "scope", { required: true });
  const tokenEndpointAuth = objectField(refresh, "token_endpoint_auth");
  const authType = stringField(tokenEndpointAuth, "type", { required: true });
  if (
    authType !== "none" &&
    authType !== "client_secret_basic" &&
    authType !== "client_secret_post"
  ) {
    throw invalidRequest(
      "`auth.refresh.token_endpoint_auth.type` must be one of `none`, `client_secret_basic`, or `client_secret_post`",
    );
  }
  const refreshToken = secretField(refresh, "refresh_token", { required: true });
  const clientSecret =
    authType === "none"
      ? clientSecretAbsent(tokenEndpointAuth)
      : secretField(tokenEndpointAuth, "client_secret", { required: true });
  return {
    metadata: {
      token_endpoint: tokenEndpoint,
      client_id: clientId,
      ...(scope === undefined ? {} : { scope }),
      token_endpoint_auth: { type: authType },
    },
    refreshToken,
    ...(clientSecret === undefined ? {} : { clientSecret }),
  };
}

function tokenEndpointField(
  obj: Record<string, unknown>,
  field: string,
  allowInsecureTokenEndpoint?: (url: URL) => boolean,
): string {
  const value = stringField(obj, field, { required: true });
  if (value.length > MAX_TOKEN_ENDPOINT_LENGTH) {
    throw invalidRequest(
      `\`${field}\` must be at most ${MAX_TOKEN_ENDPOINT_LENGTH} characters`,
    );
  }
  try {
    const url = new URL(value);
    const explicitlyAllowed = allowInsecureTokenEndpoint?.(url) === true;
    if (url.protocol !== "https:" && !explicitlyAllowed) {
      throw invalidRequest(`\`${field}\` must be an https URL`);
    }
    if (url.username || url.password || url.hash) {
      throw invalidRequest(
        `\`${field}\` must not include userinfo or fragments`,
      );
    }
    if (isBlockedIpLiteral(url.hostname) && !explicitlyAllowed) {
      throw invalidRequest(`\`${field}\` host is not allowed`);
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.name === "ApiError") throw error;
    throw invalidRequest(`\`${field}\` must be an https URL`);
  }
}

function clientSecretAbsent(obj: Record<string, unknown>): undefined {
  if (obj.client_secret !== undefined) {
    throw invalidRequest(
      "`auth.refresh.token_endpoint_auth.client_secret` is not allowed when type is `none`",
    );
  }
  return undefined;
}

function isBlockedIpLiteral(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  if (family !== 0) return isBlockedAddress(normalized, family);
  return false;
}

function expiresAtField(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || input.length === 0) {
    throw invalidRequest("`auth.expires_at` must be a non-empty string");
  }
  const time = Date.parse(input);
  if (!Number.isFinite(time)) {
    throw invalidRequest("`auth.expires_at` must be an ISO-8601 timestamp");
  }
  if (time <= Date.now()) {
    throw invalidRequest("auth.expires_at must be in the future.");
  }
  return input;
}

function objectField(
  obj: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = obj[field];
  if (!isObject(value)) throw invalidRequest(`\`${field}\` must be a JSON object`);
  return value;
}

function authObject(input: unknown): CredentialAuthInput {
  if (!isObject(input)) throw invalidRequest("`auth` must be a JSON object");
  const type = stringField(input, "type", { required: true });
  if (type !== "static_bearer" && type !== "mcp_oauth") {
    throw invalidRequest(
      "Only `static_bearer` and `mcp_oauth` credentials are supported",
    );
  }
  return { ...input, type };
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
