import type { ManagedAgentsListPage } from "../../types/common.ts";
import type {
  CreateManagedEnvironmentRequest,
  ManagedAgentsEnvironment,
} from "../../types/environments.ts";
import type { JsonObject } from "../../types/json.ts";
import type { WorkspaceId } from "../workspace.ts";

export interface EnvironmentRow {
  id: string;
  workspace_id: WorkspaceId;
  type: "environment";
  name: string;
  config: JsonObject;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface CreateEnvironmentRecord {
  row: EnvironmentRow;
}

export interface ListEnvironmentsOptions {
  page?: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface EnvironmentStore {
  create(record: CreateEnvironmentRecord): EnvironmentRow;
  retrieve(
    workspaceId: WorkspaceId,
    environmentId: string,
  ): EnvironmentRow | undefined;
  list(
    workspaceId: WorkspaceId,
    opts?: ListEnvironmentsOptions,
  ): ManagedAgentsListPage<EnvironmentRow>;
  close?(): void;
}

export interface EnvironmentService {
  create(
    workspaceId: WorkspaceId,
    input: unknown,
  ): ManagedAgentsEnvironment;
  retrieve(
    workspaceId: WorkspaceId,
    environmentId: string,
  ): ManagedAgentsEnvironment;
  list(
    workspaceId: WorkspaceId,
    opts?: ListEnvironmentsOptions,
  ): ManagedAgentsListPage<ManagedAgentsEnvironment>;
}

export type { CreateManagedEnvironmentRequest, ManagedAgentsEnvironment };
