import type { ManagedAgentsListPage } from "../../types/common.ts";
import type {
  JsonHttpResponse,
  RequestIdempotencyKey,
} from "../request-idempotency.ts";
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
  vault_ids?: string[];
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
  kind: "upload" | "skill";
  skill_snapshot_id: string | null;
}

export interface SessionSkillSnapshotRow {
  workspace_id: WorkspaceId;
  session_id: string;
  skill_snapshot_id: string;
  skill_id: string;
  version: string;
  name: string;
  description: string;
}

export interface PendingInternalSnapshotDeleteRow
  extends SessionFileMountSnapshotRow {
  created_at: string;
  last_attempt_at: string | null;
  attempt_count: number;
  last_error: string | null;
}

export interface PendingInternalSnapshotCreateRollbackRow
  extends SessionFileMountSnapshotRow {
  created_at: string;
  last_attempt_at: string | null;
  attempt_count: number;
  last_error: string | null;
}

export interface CreateSessionRecord {
  row: SessionRow;
  snapshots?: SessionFileMountSnapshotRow[];
  skillSnapshots?: SessionSkillSnapshotRow[];
}

export interface CreateSessionIdempotencyCommit {
  complete(): void;
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
  countActive(workspaceId: WorkspaceId): number;
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
  getSkillSnapshots(workspaceId: WorkspaceId, sessionId: string): SessionSkillSnapshotRow[];
  listPendingInternalSnapshotDeleteWorkspaces(): WorkspaceId[];
  getPendingInternalSnapshotDeletes(
    workspaceId: WorkspaceId,
    sessionId?: string,
  ): PendingInternalSnapshotDeleteRow[];
  recordPendingInternalSnapshotDeleteAttempt(
    workspaceId: WorkspaceId,
    sessionId: string,
    resourceId: string,
    attemptedAt: string,
    error: string,
  ): void;
  clearPendingInternalSnapshotDelete(
    workspaceId: WorkspaceId,
    sessionId: string,
    resourceId: string,
  ): void;
  recordPendingInternalSnapshotCreateRollback(
    row: SessionFileMountSnapshotRow,
    createdAt: string,
  ): void;
  listPendingInternalSnapshotCreateRollbackWorkspaces(): WorkspaceId[];
  getPendingInternalSnapshotCreateRollbacks(
    workspaceId: WorkspaceId,
    sessionId?: string,
  ): PendingInternalSnapshotCreateRollbackRow[];
  recordPendingInternalSnapshotCreateRollbackAttempt(
    workspaceId: WorkspaceId,
    sessionId: string,
    resourceId: string,
    attemptedAt: string,
    error: string,
  ): void;
  clearPendingInternalSnapshotCreateRollback(
    workspaceId: WorkspaceId,
    sessionId: string,
    resourceId: string,
  ): void;
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
  createIdempotent(
    workspaceId: WorkspaceId,
    input: unknown,
    idempotency: RequestIdempotencyKey,
    opts?: { requestId?: string },
  ): Promise<JsonHttpResponse>;
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
