import type { JsonObject } from "./json.ts";

export type ManagedAgentsModelSpeed = "standard" | "fast";

export type ManagedAgentsModel =
  | string
  | {
      id: string;
      speed?: ManagedAgentsModelSpeed;
    };

export interface ManagedAgentsModelConfig {
  id: string;
  speed: ManagedAgentsModelSpeed;
}

export interface ManagedAgentsPermissionPolicy {
  type: "always_allow" | "always_ask" | "never_allow" | (string & {});
}

export interface ManagedAgentsToolConfig {
  name: string;
  enabled?: boolean;
  permission_policy?: ManagedAgentsPermissionPolicy;
}

export interface ManagedAgentsToolset20260401 {
  type: "agent_toolset_20260401";
  configs?: ManagedAgentsToolConfig[];
  default_config?: {
    enabled?: boolean;
    permission_policy?: ManagedAgentsPermissionPolicy;
  };
}

export interface ManagedAgentsMcpToolset {
  type: "mcp_toolset";
  mcp_server_name: string;
  configs?: ManagedAgentsToolConfig[];
  default_config?: {
    enabled?: boolean;
    permission_policy?: ManagedAgentsPermissionPolicy;
  };
}

export interface ManagedAgentsCustomTool {
  type: "custom";
  name: string;
  description?: string;
  input_schema: JsonObject;
}

export type ManagedAgentsTool =
  | ManagedAgentsToolset20260401
  | ManagedAgentsMcpToolset
  | ManagedAgentsCustomTool;

export interface ManagedAgentsSkill {
  type: "anthropic" | "custom" | (string & {});
  skill_id: string;
  version?: string;
}

export interface ManagedAgentsMcpServer {
  type: "url";
  name: string;
  url: string;
}

export interface ManagedAgentsMultiagent {
  type: "coordinator";
  agents: Array<{
    type: "agent";
    id: string;
    version?: number;
  }>;
}

export interface CreateManagedAgentRequest {
  name: string;
  model: ManagedAgentsModel;
  system?: string | null;
  description?: string | null;
  tools?: ManagedAgentsTool[];
  skills?: ManagedAgentsSkill[];
  mcp_servers?: ManagedAgentsMcpServer[];
  metadata?: Record<string, string>;
  multiagent?: ManagedAgentsMultiagent | null;
}

export interface ManagedAgentsAgent {
  id: string;
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

export interface ManagedAgentsListPage<T> {
  data: T[];
  has_more: boolean;
  next_page: string | null;
}
