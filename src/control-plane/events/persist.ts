import { newEventId, type EventType } from "../../types/events.ts";
import type { JsonObject, JsonValue } from "../../types/json.ts";
import { invalidRequest } from "../errors.ts";
import { MAX_EVENT_PAYLOAD_BYTES } from "./constants.ts";
import type { WorkspaceId } from "../workspace.ts";
import type {
  EventStoreRuntimeChanges,
  PersistedSessionEvent,
  SessionEventBroadcaster,
  SessionEventStore,
} from "./types.ts";

export interface EventDraft {
  type: EventType;
  payload: JsonObject;
}

export function materializePersistedEvents(
  workspaceId: WorkspaceId,
  sessionId: string,
  drafts: readonly EventDraft[],
  now: string,
): PersistedSessionEvent[] {
  return drafts.map((draft) => {
    const payloadJson = JSON.stringify(draft.payload);
    if (new TextEncoder().encode(payloadJson).byteLength > MAX_EVENT_PAYLOAD_BYTES) {
      throw invalidRequest(
        `Serialized event payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes`,
      );
    }
    return {
      id: newEventId(),
      workspace_id: workspaceId,
      session_id: sessionId,
      type: draft.type,
      processed_at: now,
      payload: draft.payload as Record<string, JsonValue>,
      created_at: now,
    };
  });
}

export function persistAndPublish(
  store: SessionEventStore,
  broadcaster: SessionEventBroadcaster,
  events: readonly PersistedSessionEvent[],
): void {
  // Keep persist-then-notify in the same sync tick. Do not `await` between
  // appendBatch and publishPersisted; that would open a replay gap.
  store.appendBatch(events);
  broadcaster.publishPersisted(events);
}

export function persistRuntimeChangesAndPublish(
  store: SessionEventStore,
  broadcaster: SessionEventBroadcaster,
  events: readonly PersistedSessionEvent[],
  changes: EventStoreRuntimeChanges,
): void {
  // Same persist-then-notify invariant as persistAndPublish, with runtime
  // ledger mutations committed in the same SQLite transaction as the events.
  store.appendBatchWithRuntimeChanges(events, changes);
  broadcaster.publishPersisted(events);
}
