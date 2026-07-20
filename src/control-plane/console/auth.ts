import type { AdminAuth } from "../admin/auth.ts";
import {
  hashWorkspaceApiKey,
  type SqliteWorkspaceStore,
} from "../workspaces/store.ts";
import type { WorkspaceId } from "../workspace.ts";

export const CONSOLE_ADMIN_COOKIE = "oma_console_admin";
export const CONSOLE_WORKSPACE_COOKIE = "oma_console_workspace";
const WORKSPACE_SESSION_SECONDS = 30 * 24 * 60 * 60;
const ADMIN_SESSION_SECONDS = 8 * 60 * 60;

export interface ConsoleSessionAuth {
  authenticateWorkspace(token: string): WorkspaceId | undefined;
  authenticateAdmin(token: string): boolean;
  createWorkspaceSession(plaintextKey: string): { token: string; workspaceId: WorkspaceId } | undefined;
  createAdminSession(plaintextKey: string): string | undefined;
  selectWorkspace(adminToken: string, workspaceId: WorkspaceId): string | undefined;
  revokeWorkspaceSession(token: string): void;
  revokeAdminSession(token: string): void;
  workspaceName(workspaceId: WorkspaceId): string | undefined;
}

export function createConsoleSessionAuth(input: {
  workspaces: SqliteWorkspaceStore;
  admin?: AdminAuth;
}): ConsoleSessionAuth {
  const workspaceExpiry = () => new Date(Date.now() + WORKSPACE_SESSION_SECONDS * 1000);
  const adminExpiry = () => new Date(Date.now() + ADMIN_SESSION_SECONDS * 1000);

  const workspaceToken = (workspaceId: WorkspaceId, credentialSha256: string, kind: "workspace_key" | "admin_workspace") =>
    input.workspaces.mintConsoleSession({
      kind,
      workspaceId,
      credentialSha256,
      expiresAt: workspaceExpiry(),
    }).plaintextToken;
  const authenticateAdmin = (token: string): boolean => {
    const session = input.workspaces.getConsoleSession(token);
    return session?.kind === "admin" && input.admin?.fingerprint() === session.credential_sha256;
  };

  return {
    authenticateWorkspace(token) {
      const session = input.workspaces.getConsoleSession(token);
      if (session?.workspace_id === null || session === undefined) return undefined;
      if (session.kind === "workspace_key") {
        return input.workspaces.authenticateKeySha256(session.credential_sha256) === session.workspace_id
          ? session.workspace_id
          : undefined;
      }
      return session.kind === "admin_workspace" && input.admin?.fingerprint() === session.credential_sha256
        ? session.workspace_id
        : undefined;
    },
    authenticateAdmin,
    createWorkspaceSession(plaintextKey) {
      const workspaceId = input.workspaces.authenticate(plaintextKey);
      if (workspaceId === undefined) return undefined;
      return {
        token: workspaceToken(workspaceId, hashWorkspaceApiKey(plaintextKey), "workspace_key"),
        workspaceId,
      };
    },
    createAdminSession(plaintextKey) {
      if (!input.admin?.verify(plaintextKey)) return undefined;
      return input.workspaces.mintConsoleSession({
        kind: "admin",
        credentialSha256: input.admin.fingerprint(),
        expiresAt: adminExpiry(),
      }).plaintextToken;
    },
    selectWorkspace(adminToken, workspaceId) {
      if (!authenticateAdmin(adminToken) || !input.workspaces.getWorkspace(workspaceId)) {
        return undefined;
      }
      return workspaceToken(workspaceId, input.admin!.fingerprint(), "admin_workspace");
    },
    revokeWorkspaceSession(token) {
      input.workspaces.revokeConsoleSession(token);
    },
    revokeAdminSession(token) {
      input.workspaces.revokeConsoleSession(token);
    },
    workspaceName(workspaceId) {
      return input.workspaces.getWorkspace(workspaceId)?.name;
    },
  };
}
