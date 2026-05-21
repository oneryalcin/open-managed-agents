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
  title?: string | null;
  metadata?: Record<string, string>;
  resources?: unknown;
  vault_ids?: unknown;
}

export interface ManagedAgentsSession {
  id: string;
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
