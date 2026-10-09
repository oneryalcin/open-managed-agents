import type { ManagedAgentsSession } from "../../types/sessions.ts";
import type { SessionRow } from "./types.ts";

/**
 * The session as stored. Usage starts at zero and stats from the row's times;
 * the session service fills both from the event store (plan 0148).
 */
export function toManagedSession(row: SessionRow, now = new Date()): ManagedAgentsSession {
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
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      active_seconds: 0,
      list_cost: { amount: "0", currency: "USD" },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    },
    stats: { active_seconds: 0, duration_seconds: durationSeconds(row, now) },
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

/** From creation to now, frozen when the session was archived. */
export function durationSeconds(
  row: { created_at: string; archived_at: string | null },
  now: Date,
): number {
  const end = row.archived_at === null ? now.getTime() : Date.parse(row.archived_at);
  return Math.max(0, end - Date.parse(row.created_at)) / 1000;
}
