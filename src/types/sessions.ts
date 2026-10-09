export type ManagedAgentsSessionStatus =
  | "idle"
  | "running"
  | "rescheduling"
  | "terminated";

export interface ManagedAgentsSessionAgentRef {
  type: "agent";
  id: string;
  version: number;
}

export type CreateManagedSessionAgentInput =
  | string
  | {
      type: "agent";
      id: string;
      version?: number;
    };

export interface CreateManagedSessionRequest {
  agent: CreateManagedSessionAgentInput;
  environment_id: string;
  vault_ids?: string[];
  title?: string | null;
  metadata?: Record<string, string>;
  resources?: CreateManagedSessionResourceInput[];
}

export type CreateManagedSessionResourceInput =
  | CreateManagedSessionFileResourceInput;

export interface CreateManagedSessionFileResourceInput {
  type: "file";
  file_id: string;
  mount_path?: string;
}

export interface ManagedAgentsSessionFileResource {
  id: string;
  type: "file";
  file_id: string;
  mount_path: string;
  created_at: string;
  updated_at: string;
}

export interface ManagedAgentsSession {
  id: string;
  type: "session";
  agent: ManagedAgentsSessionAgentRef;
  environment_id: string;
  vault_ids: string[];
  status: ManagedAgentsSessionStatus;
  title: string | null;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  usage: ManagedAgentsSessionUsage;
  stats: ManagedAgentsSessionStats;
  resources: ManagedAgentsSessionFileResource[];
}

/** Cumulative usage (plan 0148; hosted shape, probe 71). */
export interface ManagedAgentsSessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  /** Null until the session has made a model request. */
  cache_creation: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  } | null;
  active_seconds: number;
  /**
   * Model list cost in cents, estimated from Pi's price table. Null when a
   * request used a model with no known price. OMA does not price runtime.
   */
  list_cost: { amount: string; currency: "USD" } | null;
  /** OMA has no server-executed tools yet. */
  server_tool_use: null;
}

export interface ManagedAgentsSessionStats {
  active_seconds: number;
  duration_seconds: number;
}

export interface ManagedAgentsDeletedSession {
  id: string;
  type: "session_deleted";
}
