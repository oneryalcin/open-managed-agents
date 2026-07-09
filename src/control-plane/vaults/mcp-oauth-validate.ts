import { invalidRequest } from "../errors.ts";
import type { McpFetch } from "../sessions/pi/mcp/fetch.ts";
import {
  probeMcpInitialize,
  type McpInitializeProbeResult,
} from "../sessions/pi/mcp/probe.ts";
import type {
  RefreshCoordinator,
  RefreshCredentialResult,
  TokenEndpointResponseMetadata,
} from "./oauth-refresh.ts";
import type { VaultOauthRefreshState, VaultService } from "./types.ts";
import type { WorkspaceId } from "../workspace.ts";

export interface McpOauthValidationDependencies {
  fetch: McpFetch;
  refresh: RefreshCoordinator;
  operationTimeoutMs: number;
  now?: () => Date;
}

export interface VaultCredentialValidation {
  type: "vault_credential_validation";
  credential_id: string;
  vault_id: string;
  validated_at: string;
  has_refresh_token: boolean;
  status: "valid" | "invalid" | "unknown";
  mcp_probe: {
    method: "initialize";
    http_response: ProbeHttpResponse | null;
  };
  refresh: {
    status:
      | "not_attempted"
      | "no_refresh_token"
      | "refreshed"
      | "failed"
      | "skipped";
    http_response: RefreshHttpResponse | null;
  };
}

interface ProbeHttpResponse {
  status_code: number;
  content_type: string;
  body: string;
  body_truncated: boolean;
}

interface RefreshHttpResponse {
  status_code: number;
  content_type: string;
}

export async function validateMcpOauthCredential(
  service: VaultService,
  deps: McpOauthValidationDependencies,
  workspaceId: WorkspaceId,
  vaultId: string,
  credentialId: string,
): Promise<VaultCredentialValidation> {
  const credential = service.retrieveCredential(workspaceId, vaultId, credentialId);
  if (credential.archived_at !== null) throw invalidRequest("Credential is archived.");
  if (credential.auth.type !== "mcp_oauth") {
    throw invalidRequest("The request was invalid");
  }
  const initial = service.readOauthValidationSnapshot(
    workspaceId,
    vaultId,
    credentialId,
  );
  if (initial === undefined) throw invalidRequest("The request was invalid");

  const firstProbe = await probe(initial, deps, secretValues(initial));
  const hasRefreshToken = initial.secrets.refreshToken !== undefined;
  if (!isAuthRejection(firstProbe)) {
    return result({
      credentialId,
      vaultId,
      validatedAt: now(deps),
      hasRefreshToken,
      status: probeStatus(firstProbe),
      probe: firstProbe,
      refreshStatus: "not_attempted",
    });
  }
  if (initial.refresh === undefined || !hasRefreshToken) {
    return result({
      credentialId,
      vaultId,
      validatedAt: now(deps),
      hasRefreshToken,
      status: "invalid",
      probe: firstProbe,
      refreshStatus: "no_refresh_token",
    });
  }

  const refreshed = await deps.refresh.refreshCredential({
    workspaceId,
    vaultId,
    credentialId,
    trigger: "validate",
    expectedAuthVersion: initial.authVersion,
  });
  if (refreshed.outcome !== "ok") {
    const shouldReprobeCurrent =
      (refreshed.outcome === "skipped" && refreshed.reason === "stale_version") ||
      (refreshed.outcome !== "skipped" && refreshed.persisted === "stale");
    if (shouldReprobeCurrent) {
      const current = service.readOauthValidationSnapshot(
        workspaceId,
        vaultId,
        credentialId,
      );
      if (current === undefined) {
        assertCredentialStillActive(service, workspaceId, vaultId, credentialId);
      } else if (current.authVersion !== initial.authVersion) {
        const currentProbe = await probe(current, deps, [
          ...secretValues(initial),
          ...secretValues(current),
        ]);
        return result({
          credentialId,
          vaultId,
          validatedAt: now(deps),
          hasRefreshToken: current.secrets.refreshToken !== undefined,
          status: isAuthRejection(currentProbe)
            ? "invalid"
            : probeStatus(currentProbe),
          probe: currentProbe,
          refreshStatus: refreshed.outcome === "skipped" ? "skipped" : "failed",
          refreshResponse: refreshed.tokenEndpointResponse,
        });
      }
    }
    return result({
      credentialId,
      vaultId,
      validatedAt: now(deps),
      hasRefreshToken,
      status: refreshed.outcome === "invalid" ? "invalid" : "unknown",
      probe: firstProbe,
      refreshStatus:
        refreshed.outcome === "skipped" ? "skipped" : "failed",
      refreshResponse: refreshed.tokenEndpointResponse,
    });
  }

  const current = service.readOauthValidationSnapshot(
    workspaceId,
    vaultId,
    credentialId,
  );
  if (current === undefined) {
    assertCredentialStillActive(service, workspaceId, vaultId, credentialId);
    throw invalidRequest("The request was invalid");
  }
  const secondProbe = await probe(current, deps, [
    ...secretValues(initial),
    ...secretValues(current),
  ]);
  return result({
    credentialId,
    vaultId,
    validatedAt: now(deps),
    hasRefreshToken: current.secrets.refreshToken !== undefined,
    status: isAuthRejection(secondProbe)
      ? "invalid"
      : probeStatus(secondProbe),
    probe: secondProbe,
    refreshStatus: "refreshed",
    refreshResponse: refreshed.tokenEndpointResponse,
  });
}

async function probe(
  state: VaultOauthRefreshState,
  deps: McpOauthValidationDependencies,
  knownSecrets: readonly string[],
): Promise<McpInitializeProbeResult> {
  const accessToken = state.secrets.accessToken;
  return probeMcpInitialize(
    state.mcpServerUrl,
    accessToken === undefined ? undefined : `Bearer ${accessToken}`,
    deps.fetch,
    {
      capBytes: 4096,
      timeoutMs: deps.operationTimeoutMs,
      knownSecrets,
    },
  );
}

function result(input: {
  credentialId: string;
  vaultId: string;
  validatedAt: string;
  hasRefreshToken: boolean;
  status: VaultCredentialValidation["status"];
  probe: McpInitializeProbeResult;
  refreshStatus: VaultCredentialValidation["refresh"]["status"];
  refreshResponse?: TokenEndpointResponseMetadata;
}): VaultCredentialValidation {
  return {
    type: "vault_credential_validation",
    credential_id: input.credentialId,
    vault_id: input.vaultId,
    validated_at: input.validatedAt,
    has_refresh_token: input.hasRefreshToken,
    status: input.status,
    mcp_probe: {
      method: "initialize",
      http_response: probeHttpResponse(input.probe),
    },
    refresh: {
      status: input.refreshStatus,
      http_response: refreshHttpResponse(input.refreshResponse),
    },
  };
}

function probeHttpResponse(probe: McpInitializeProbeResult): ProbeHttpResponse | null {
  return probe.reached
    ? {
        status_code: probe.statusCode,
        content_type: probe.contentType,
        body: probe.body,
        body_truncated: probe.bodyTruncated,
      }
    : null;
}

function refreshHttpResponse(
  response: TokenEndpointResponseMetadata | undefined,
): RefreshHttpResponse | null {
  return response === undefined
    ? null
    : { status_code: response.statusCode, content_type: response.contentType };
}

function probeStatus(
  probe: McpInitializeProbeResult,
): VaultCredentialValidation["status"] {
  return probe.reached && probe.initializeSucceeded ? "valid" : "unknown";
}

function isAuthRejection(probe: McpInitializeProbeResult): boolean {
  return probe.reached && (probe.statusCode === 401 || probe.statusCode === 403);
}

function secretValues(state: VaultOauthRefreshState): string[] {
  return [
    state.secrets.accessToken,
    state.secrets.refreshToken,
    state.secrets.clientSecret,
  ].filter((value): value is string => value !== undefined);
}

function now(deps: McpOauthValidationDependencies): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function assertCredentialStillActive(
  service: VaultService,
  workspaceId: WorkspaceId,
  vaultId: string,
  credentialId: string,
): void {
  const credential = service.retrieveCredential(workspaceId, vaultId, credentialId);
  if (credential.archived_at !== null) throw invalidRequest("Credential is archived.");
}
