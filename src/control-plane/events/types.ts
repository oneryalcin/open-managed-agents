import type { EventType, ManagedAgentsEvent } from "../../types/events.ts";

/**
 * Internal persisted event row shape.
 *
 * `session_id`, `created_at`, and `payload` are storage/control-plane fields,
 * not public event fields. Route serializers convert this to
 * `ManagedAgentsEvent` before writing an HTTP/SSE response.
 */
export interface PersistedSessionEvent {
  id: string;
  session_id: string;
  type: EventType;
  processed_at: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export function toManagedAgentsEvent(
  event: PersistedSessionEvent,
): ManagedAgentsEvent {
  return {
    id: event.id,
    type: event.type,
    processed_at: event.processed_at,
    ...event.payload,
  };
}
