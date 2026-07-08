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
  usage: null;
  resources: ManagedAgentsSessionFileResource[];
}

export interface ManagedAgentsDeletedSession {
  id: string;
  type: "session_deleted";
}
