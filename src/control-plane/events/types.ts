import type {
  EventType,
  ManagedAgentsContentBlock,
  ManagedAgentsEvent,
  ManagedAgentsUserCustomToolResultEventInput,
} from "../../types/events.ts";
import type { JsonObject } from "../../types/json.ts";
import type { WorkspaceId } from "../workspace.ts";

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
  payload: JsonObject;
  created_at: string;
}

export interface CreatePersistedSessionEventRecord {
  event: PersistedSessionEvent;
}

export interface ListSessionEventRecordsOptions {
  page?: string;
  limit?: number;
  order?: "asc" | "desc";
  types?: readonly string[];
  // Legacy alias retained for broadcaster replay paths.
  afterId?: string;
}

export interface SessionEventRecordPage {
  data: PersistedSessionEvent[];
  next_page: string | null;
}

export interface SessionEventStore {
  append(event: PersistedSessionEvent): void;
  appendBatch(events: readonly PersistedSessionEvent[]): void;
  list(
    sessionId: string,
    opts?: ListSessionEventRecordsOptions,
  ): PersistedSessionEvent[];
  listPage(
    sessionId: string,
    opts?: ListSessionEventRecordsOptions,
  ): SessionEventRecordPage;
  retrieve(id: string): PersistedSessionEvent | undefined;
  close?(): void;
}

export interface ListSessionEventsOptions {
  page?: string;
  limit?: number;
  order?: "asc" | "desc";
  types?: readonly string[];
}

export interface StreamSessionEventsOptions {
  lastEventId?: string;
  signal?: AbortSignal;
}

export interface SessionEventBroadcaster {
  publishPersisted(events: readonly PersistedSessionEvent[]): void;
  subscribe(
    sessionId: string,
    opts?: { lastSeenId?: string; signal?: AbortSignal },
  ): AsyncIterable<PersistedSessionEvent>;
}

export interface SessionEventsService {
  send(
    workspaceId: WorkspaceId,
    sessionId: string,
    input: unknown,
    opts?: { signal?: AbortSignal },
  ): ManagedAgentsEvent[];
  list(
    workspaceId: WorkspaceId,
    sessionId: string,
    opts?: ListSessionEventsOptions,
  ): { data: ManagedAgentsEvent[]; next_page: string | null };
  stream(
    workspaceId: WorkspaceId,
    sessionId: string,
    opts?: StreamSessionEventsOptions,
  ): AsyncIterable<ManagedAgentsEvent>;
}

export interface RuntimeEventRunner {
  runUserMessage(
    workspaceId: WorkspaceId,
    sessionId: string,
    text: string,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<unknown>;
  claimCustomToolResult?(
    workspaceId: WorkspaceId,
    sessionId: string,
    event: ManagedAgentsUserCustomToolResultEventInput,
  ): (() => void) | undefined;
  customToolNames?(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): ReadonlySet<string>;
}

export interface RuntimeCustomToolUseEvent {
  type: "oma.custom_tool_use";
  piToolCallId: string;
  name: string;
  input: JsonObject;
  bindCustomToolUseId: (
    customToolUseId: string,
    releaseCustomToolUseId: () => void,
  ) => void;
  rejectCustomToolUse: (error: Error) => void;
}

export interface RuntimeTranslatorContext {
  customToolNames?: ReadonlySet<string>;
}

export type RuntimeEventTranslator = (
  event: unknown,
  context?: RuntimeTranslatorContext,
) => Array<{ type: EventType; payload: JsonObject }>;

export interface RuntimeCustomToolResult {
  content?: ManagedAgentsContentBlock[];
  is_error?: boolean;
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
