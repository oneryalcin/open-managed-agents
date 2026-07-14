import type {
  CreateManagedAgentRequest,
  ManagedAgentsAgent,
  ManagedAgentsAgentVersionsPage,
  ManagedAgentsListPage,
  ManagedAgentsMcpServer,
  ManagedAgentsModelConfig,
  ManagedAgentsMultiagent,
  ManagedAgentsSkill,
  ManagedAgentsTool,
} from "../../types/agents.ts";
import type { WorkspaceId } from "../workspace.ts";

export { DEFAULT_WORKSPACE_ID, type WorkspaceId } from "../workspace.ts";

export interface AgentRow {
  id: string;
  workspace_id: WorkspaceId;
  type: "agent";
  name: string;
  model: ManagedAgentsModelConfig;
  system: string | null;
  description: string | null;
  tools: ManagedAgentsTool[];
  skills: ManagedAgentsSkill[];
  mcp_servers: ManagedAgentsMcpServer[];
  metadata: Record<string, string>;
  multiagent: ManagedAgentsMultiagent | null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface CreateAgentRecord {
  row: AgentRow;
}

export interface UpdateAgentRecord {
  expectedVersion: number;
  row: AgentRow;
}

export interface ListAgentsOptions {
  page?: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface ListAgentVersionsOptions {
  page?: string;
  limit?: number;
}

export interface AgentVersionsPage<T> {
  data: T[];
  next_page: string | null;
}

export interface AgentStore {
  create(record: CreateAgentRecord): AgentRow;
  update(record: UpdateAgentRecord): AgentRow;
  retrieve(
    workspaceId: WorkspaceId,
    agentId: string,
  ): AgentRow | undefined;
  retrieveAny(
    workspaceId: WorkspaceId,
    agentId: string,
  ): AgentRow | undefined;
  retrieveVersion(
    workspaceId: WorkspaceId,
    agentId: string,
    version: number,
  ): AgentRow | undefined;
  listVersions(
    workspaceId: WorkspaceId,
    agentId: string,
    opts?: ListAgentVersionsOptions,
  ): AgentVersionsPage<AgentRow>;
  archive(
    workspaceId: WorkspaceId,
    agentId: string,
    archivedAt: string,
  ): AgentRow | undefined;
  list(
    workspaceId: WorkspaceId,
    opts?: ListAgentsOptions,
  ): ManagedAgentsListPage<AgentRow>;
  close?(): void;
}

export interface AgentService {
  create(
    workspaceId: WorkspaceId,
    input: unknown,
  ): ManagedAgentsAgent;
  update(
    workspaceId: WorkspaceId,
    agentId: string,
    input: unknown,
  ): ManagedAgentsAgent;
  retrieve(
    workspaceId: WorkspaceId,
    agentId: string,
    version?: number,
  ): ManagedAgentsAgent;
  listVersions(
    workspaceId: WorkspaceId,
    agentId: string,
    opts?: ListAgentVersionsOptions,
  ): ManagedAgentsAgentVersionsPage;
  archive(
    workspaceId: WorkspaceId,
    agentId: string,
  ): ManagedAgentsAgent;
  list(
    workspaceId: WorkspaceId,
    opts?: ListAgentsOptions,
  ): ManagedAgentsListPage<ManagedAgentsAgent>;
}

export type { CreateManagedAgentRequest, ManagedAgentsAgent };
