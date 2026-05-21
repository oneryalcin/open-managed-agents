import type { ManagedAgentsListPage } from "../../types/common.ts";
import type {
  CreateManagedSessionRequest,
  ManagedAgentsSession,
  ManagedAgentsSessionAgentRef,
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
}

export interface CreateSessionRecord {
  row: SessionRow;
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
  ): ManagedAgentsSession;
  retrieve(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): ManagedAgentsSession;
  list(
    workspaceId: WorkspaceId,
    opts?: ListSessionsOptions,
  ): ManagedAgentsListPage<ManagedAgentsSession>;
}

export type { CreateManagedSessionRequest, ManagedAgentsSession };
