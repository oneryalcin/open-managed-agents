import type { ManagedAgentsListPage } from "../../types/common.ts";
import type {
  CreateManagedSessionRequest,
  ManagedAgentsDeletedSession,
  ManagedAgentsSession,
  ManagedAgentsSessionAgentRef,
  ManagedAgentsSessionFileResource,
  ManagedAgentsSessionStatus,
} from "../../types/sessions.ts";
import type { WorkspaceId } from "../workspace.ts";

export interface SessionRow {
  id: string;
  workspace_id: WorkspaceId;
  type: "session";
  agent: ManagedAgentsSessionAgentRef;
  environment_id: string;
  status: ManagedAgentsSessionStatus;
  title: string | null;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  usage: null;
  resources: ManagedAgentsSessionFileResource[];
}

export interface SessionFileMountSnapshotRow {
  workspace_id: WorkspaceId;
  session_id: string;
  resource_id: string;
  file_id: string;
  mount_path: string;
  snapshot_file_id: string;
  sha256: string;
  size_bytes: number;
}

export interface CreateSessionRecord {
  row: SessionRow;
  snapshots?: SessionFileMountSnapshotRow[];
}

export interface ListSessionsOptions {
  agentId?: string;
  page?: string;
  limit?: number;
  order?: "asc" | "desc";
  includeArchived?: boolean;
}

export interface SessionStore {
  create(record: CreateSessionRecord): SessionRow;
  retrieve(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): SessionRow | undefined;
  retrieveAny(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): SessionRow | undefined;
  archive(
    workspaceId: WorkspaceId,
    sessionId: string,
    archivedAt: string,
  ): SessionRow | undefined;
  delete(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): SessionRow | undefined;
  getFileMountSnapshots(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): SessionFileMountSnapshotRow[];
  list(
    workspaceId: WorkspaceId,
    opts?: ListSessionsOptions,
  ): ManagedAgentsListPage<SessionRow>;
  close?(): void;
}

export interface SessionService {
  create(
    workspaceId: WorkspaceId,
    input: unknown,
  ): Promise<ManagedAgentsSession>;
  retrieve(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): ManagedAgentsSession;
  delete(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<ManagedAgentsDeletedSession>;
  list(
    workspaceId: WorkspaceId,
    opts?: ListSessionsOptions,
  ): ManagedAgentsListPage<ManagedAgentsSession>;
}

export type {
  CreateManagedSessionRequest,
  ManagedAgentsDeletedSession,
  ManagedAgentsSession,
  ManagedAgentsSessionFileResource,
};
