import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkspaceId } from "../../../workspace.ts";

export type McpCredentialAuthType = "static_bearer" | "mcp_oauth";

export interface McpCredentialIdentity {
  workspaceId: WorkspaceId;
  vaultId: string;
  credentialId: string;
  authVersion: number;
  authType: McpCredentialAuthType;
}

export interface McpAuthorizationSnapshot {
  authorization: string;
  identity: McpCredentialIdentity;
}

export type McpForceRefreshResult =
  | { status: "ready"; authorization: McpAuthorizationSnapshot }
  | { status: "skipped_floor" }
  | { status: "failed"; reason?: string };

export interface McpCredentialBinding {
  readonly fingerprint: string;
  readonly identity: McpCredentialIdentity;
  authorize(): Promise<McpAuthorizationSnapshot | undefined>;
  forceRefresh(
    rejected: McpAuthorizationSnapshot,
  ): Promise<McpForceRefreshResult>;
  knownSecrets(): readonly string[];
  close?(): void;
}

export type McpCredentialResolver = (
  workspaceId: WorkspaceId,
  sessionId: string,
  serverUrl: string,
  context?: { vaultIds?: readonly string[] },
) => Promise<McpCredentialBinding | undefined>;

interface McpAuthOperationContext {
  rejectedAuthorization?: McpAuthorizationSnapshot;
}

const authOperation = new AsyncLocalStorage<McpAuthOperationContext>();

export async function runMcpAuthOperation<T>(fn: () => Promise<T>): Promise<T> {
  return authOperation.run({}, fn);
}

export function recordRejectedMcpAuthorization(
  snapshot: McpAuthorizationSnapshot,
): void {
  const context = authOperation.getStore();
  if (context !== undefined) context.rejectedAuthorization = snapshot;
}

const MCP_AUTH_SNAPSHOT = Symbol("oma.mcpAuthSnapshot");

export function attachMcpAuthSnapshot(
  error: unknown,
): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const snapshot = authOperation.getStore()?.rejectedAuthorization;
  if (snapshot !== undefined) {
    Object.defineProperty(normalized, MCP_AUTH_SNAPSHOT, {
      value: snapshot,
      enumerable: false,
      configurable: true,
    });
  }
  return normalized;
}

export function getMcpAuthSnapshot(
  error: unknown,
): McpAuthorizationSnapshot | undefined {
  if (!(error instanceof Error)) return undefined;
  return (error as Error & {
    [MCP_AUTH_SNAPSHOT]?: McpAuthorizationSnapshot;
  })[MCP_AUTH_SNAPSHOT];
}
