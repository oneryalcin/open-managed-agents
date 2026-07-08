import type { ManagedAgentsSession } from "../../types/sessions.ts";
import type { SessionRow } from "./types.ts";

export function toManagedSession(row: SessionRow): ManagedAgentsSession {
  return {
    id: row.id,
    type: row.type,
    agent: row.agent,
    environment_id: row.environment_id,
    vault_ids: [...(row.vault_ids ?? [])],
    status: row.status,
    title: row.title,
    metadata: row.metadata,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
    usage: row.usage,
    resources: row.resources.map((resource) => ({
      id: resource.id,
      type: resource.type,
      file_id: resource.file_id,
      mount_path: resource.mount_path,
      created_at: resource.created_at,
      updated_at: resource.updated_at,
    })),
  };
}
