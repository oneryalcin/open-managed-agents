import type { JsonObject } from "./json.ts";

export interface CreateManagedEnvironmentRequest {
  name: string;
  config: JsonObject;
}

export interface ManagedAgentsEnvironment {
  id: string;
  type: "environment";
  name: string;
  config: JsonObject;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}
