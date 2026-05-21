import type {
  CreateManagedAgentRequest,
  ManagedAgentsAgent,
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

export interface ListAgentsOptions {
  page?: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface AgentStore {
  create(record: CreateAgentRecord): AgentRow;
  retrieve(
    workspaceId: WorkspaceId,
    agentId: string,
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
  retrieve(
    workspaceId: WorkspaceId,
    agentId: string,
  ): ManagedAgentsAgent;
  list(
    workspaceId: WorkspaceId,
    opts?: ListAgentsOptions,
  ): ManagedAgentsListPage<ManagedAgentsAgent>;
}

export type { CreateManagedAgentRequest, ManagedAgentsAgent };
