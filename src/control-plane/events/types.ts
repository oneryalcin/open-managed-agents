import type {
  EventType,
  ManagedAgentsContentBlock,
  ManagedAgentsEvent,
  ManagedAgentsUserCustomToolResultEventInput,
  ManagedAgentsUserToolConfirmationEventInput,
} from "../../types/events.ts";
import type { JsonObject } from "../../types/json.ts";
import type {
  IdempotencyCompletionInput,
  IdempotencyReservationInput,
  IdempotencyReservationResult,
  JsonHttpResponse,
  RequestIdempotencyKey,
} from "../request-idempotency.ts";
import type { SessionRow } from "../sessions/types.ts";
import type { WorkspaceId } from "../workspace.ts";

export type {
  IdempotencyCompletionInput,
  IdempotencyReservationInput,
  IdempotencyReservationResult,
} from "../request-idempotency.ts";

/**
 * Internal persisted event row shape.
 *
 * `session_id`, `created_at`, and `payload` are storage/control-plane fields,
 * not public event fields. Route serializers convert this to
 * `ManagedAgentsEvent` before writing an HTTP/SSE response.
 */
export interface PersistedSessionEvent {
  id: string;
  workspace_id: WorkspaceId;
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

export type EventsSendIdempotencyKey = RequestIdempotencyKey;
export type SessionEventsHttpResponse = JsonHttpResponse;

export type RuntimeTurnState =
  | "accepted"
  | "dispatching"
  | "running"
  | "paused"
  | "terminalizing"
  | "terminalized"
  | "completed";

export type RuntimeActionType = "custom_tool" | "tool_confirmation";

export type RuntimeActionState = "pending" | "acknowledged" | "closed";

export type RuntimeActionCloseReason =
  | "completed"
  | "terminalized"
  | "interrupted"
  | "archived"
  | "deleted"
  | "timeout";

export class RuntimeTurnOwnershipLostError extends Error {
  constructor(readonly turnId: string) {
    super(`Runtime turn ownership lost: ${turnId}`);
    this.name = "RuntimeTurnOwnershipLostError";
  }
}

export interface PendingRuntimeTurnRecord {
  workspace_id: WorkspaceId;
  session_id: string;
  turn_id: string;
  owner_id: string;
  owner_generation: number;
  lease_expires_at: string;
  state: RuntimeTurnState;
  trigger_event_ids: string[];
  open_model_request_start_ids: string[];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  terminalized_at: string | null;
}

export interface PendingRuntimeActionRecord {
  workspace_id: WorkspaceId;
  session_id: string;
  turn_id: string;
  action_id: string;
  action_type: RuntimeActionType;
  state: RuntimeActionState;
  acknowledged_at: string | null;
  closed_at: string | null;
  close_reason: RuntimeActionCloseReason | null;
  created_at: string;
  updated_at: string;
  turn: PendingRuntimeTurnRecord;
}

export interface AcceptedRuntimeTurnDraft {
  workspaceId: WorkspaceId;
  sessionId: string;
  turnId: string;
  ownerId: string;
  ownerGeneration: number;
  leaseExpiresAt: string;
  triggerEventIds: readonly string[];
  now: string;
}

export interface RuntimeActionDraft {
  workspaceId: WorkspaceId;
  sessionId: string;
  turnId: string;
  actionId: string;
  actionType: RuntimeActionType;
  now: string;
}

export interface RuntimeActionAcknowledgement {
  workspaceId: WorkspaceId;
  sessionId: string;
  actionId: string;
  now: string;
}

export interface RuntimeActionClosure {
  workspaceId: WorkspaceId;
  sessionId: string;
  actionId: string;
  reason: RuntimeActionCloseReason;
  now: string;
}

export interface RuntimeTurnStateChange {
  workspaceId: WorkspaceId;
  sessionId: string;
  turnId: string;
  ownerId?: string;
  ownerGeneration?: number;
  leaseExpiresAt?: string;
  state: RuntimeTurnState;
  now: string;
}

export interface RuntimeTurnLeaseRenewal {
  workspaceId: WorkspaceId;
  sessionId: string;
  turnId: string;
  ownerId: string;
  ownerGeneration: number;
  leaseExpiresAt: string;
  now: string;
}

export interface RuntimeTurnClosure {
  workspaceId: WorkspaceId;
  sessionId: string;
  turnId: string;
  ownerId?: string;
  ownerGeneration?: number;
  reason: RuntimeActionCloseReason;
  state: "completed" | "terminalized";
  now: string;
}

export interface RuntimeTurnModelRequestStartOpen {
  workspaceId: WorkspaceId;
  sessionId: string;
  turnId: string;
  ownerId: string;
  ownerGeneration: number;
  startEventId: string;
  now: string;
}

export interface RuntimeTurnModelRequestStartClose {
  workspaceId: WorkspaceId;
  sessionId: string;
  turnId: string;
  ownerId: string;
  ownerGeneration: number;
  startEventId: string;
  now: string;
}

export interface RuntimeTurnRecoveryClaim {
  workspaceId: WorkspaceId;
  sessionId: string;
  turnId: string;
  ownerId: string;
  leaseExpiresAt: string;
  now: string;
}

export interface EventStoreRuntimeChanges {
  acceptedTurns?: AcceptedRuntimeTurnDraft[];
  openedActions?: RuntimeActionDraft[];
  acknowledgedActions?: RuntimeActionAcknowledgement[];
  closedActions?: RuntimeActionClosure[];
  turnStates?: RuntimeTurnStateChange[];
  leaseRenewals?: RuntimeTurnLeaseRenewal[];
  openedModelRequestStarts?: RuntimeTurnModelRequestStartOpen[];
  closedModelRequestStarts?: RuntimeTurnModelRequestStartClose[];
  closedTurns?: RuntimeTurnClosure[];
}

export interface SessionEventStore {
  append(event: PersistedSessionEvent): void;
  appendBatch(events: readonly PersistedSessionEvent[]): void;
  appendBatchWithRuntimeChanges(
    events: readonly PersistedSessionEvent[],
    changes: EventStoreRuntimeChanges,
  ): void;
  appendBatchWithRuntimeChangesAndCompleteIdempotency(
    events: readonly PersistedSessionEvent[],
    changes: EventStoreRuntimeChanges,
    completion: IdempotencyCompletionInput,
  ): void;
  // Coordinator-only hook. Callers must already hold the transaction that owns
  // any required cross-store predicates.
  appendBatchWithRuntimeChangesInTransaction(
    events: readonly PersistedSessionEvent[],
    changes: EventStoreRuntimeChanges,
  ): void;
  completeIdempotencyInTransaction(completion: IdempotencyCompletionInput): void;
  completeIdempotency(completion: IdempotencyCompletionInput): void;
  reserveIdempotencyKey(
    input: IdempotencyReservationInput,
  ): IdempotencyReservationResult;
  releaseIdempotencyReservation(
    input: RequestIdempotencyKey & { workspaceId: WorkspaceId },
  ): void;
  deleteForSession(workspaceId: WorkspaceId, sessionId: string): void;
  list(
    workspaceId: WorkspaceId,
    sessionId: string,
    opts?: ListSessionEventRecordsOptions,
  ): PersistedSessionEvent[];
  listPage(
    workspaceId: WorkspaceId,
    sessionId: string,
    opts?: ListSessionEventRecordsOptions,
  ): SessionEventRecordPage;
  retrieve(workspaceId: WorkspaceId, id: string): PersistedSessionEvent | undefined;
  findRuntimeAction(
    workspaceId: WorkspaceId,
    sessionId: string,
    actionId: string,
  ): PendingRuntimeActionRecord | undefined;
  listPendingRuntimeTurns(workspaceId: WorkspaceId): PendingRuntimeTurnRecord[];
  listWorkspaceIdsWithPendingRuntimeTurns(): WorkspaceId[];
  countPendingRuntimeTurns(workspaceId: WorkspaceId): number;
  claimAcceptedRuntimeTurnForRecovery(
    claim: RuntimeTurnRecoveryClaim,
  ): PendingRuntimeTurnRecord | undefined;
  claimRuntimeTurnForTerminalization(
    claim: RuntimeTurnRecoveryClaim,
  ): PendingRuntimeTurnRecord | undefined;
  listRuntimeActionsForTurn(
    workspaceId: WorkspaceId,
    sessionId: string,
    turnId: string,
  ): PendingRuntimeActionRecord[];
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
  closeSession(workspaceId: WorkspaceId, sessionId: string): void;
  subscribe(
    workspaceId: WorkspaceId,
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
  sendIdempotent(
    workspaceId: WorkspaceId,
    sessionId: string,
    input: unknown,
    idempotency: EventsSendIdempotencyKey,
    opts?: { signal?: AbortSignal; requestId?: string },
  ): SessionEventsHttpResponse;
  archiveSessionRowAfterPreflight(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): SessionRow;
  archiveSession(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void>;
  deleteSession(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void>;
  recoverAbandonedRuntimeTurns(workspaceId: WorkspaceId): void;
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
  prepareSession?(
    workspaceId: WorkspaceId,
    sessionId: string,
    opts?: RuntimeSessionPrepareOptions,
  ): Promise<void> | void;
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
  claimToolConfirmation?(
    workspaceId: WorkspaceId,
    sessionId: string,
    event: ManagedAgentsUserToolConfirmationEventInput,
  ): (() => void) | undefined;
  interruptSession?(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void> | void;
  collectSessionOutputs?(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<RuntimeSessionOutputCollection>;
  closeSession?(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void> | void;
  customToolNames?(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): ReadonlySet<string>;
  publicToolUseIdForPiToolCallId?(
    workspaceId: WorkspaceId,
    sessionId: string,
    piToolCallId: string,
  ): string | undefined;
  suppressPiToolUse?(
    workspaceId: WorkspaceId,
    sessionId: string,
    piToolCallId: string,
  ): boolean;
}

export interface RuntimeSessionOutputFile {
  relativePath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  bytes: AsyncIterable<Uint8Array> | Uint8Array;
}

export type RuntimeSessionOutputCollection =
  | {
      kind: "collected";
      files: readonly RuntimeSessionOutputFile[];
    }
  | {
      kind: "unsupported";
      reason: "no_live_sandbox" | "provider_unsupported";
    };

export interface RuntimeSessionFileMount {
  mountPath: string;
  snapshotFileId: string;
  sha256: string;
  sizeBytes: number;
  bytes: AsyncIterable<Uint8Array> | Uint8Array;
}

export interface RuntimeSessionPrepareOptions {
  fileMounts?: readonly RuntimeSessionFileMount[];
  /**
   * Creation-time hint for runtimes that prepare a sandbox before the session
   * row is committed. The committed row remains authoritative after create.
   */
  environmentId?: string;
  agent?: {
    type: "agent";
    id: string;
    version: number;
  };
}

export class RuntimeUnsupportedSessionFileResourcesError extends Error {
  constructor() {
    super("Configured runtime does not support session file resources");
  }
}

export interface RuntimeCustomToolUseEvent {
  type: "oma.custom_tool_use";
  piToolCallId: string;
  name: string;
  input: JsonObject;
  bindCustomToolUseId: (
    customToolUseId: string,
    releaseCustomToolUseId: (reason?: RuntimeActionCloseReason) => void,
  ) => void;
  rejectCustomToolUse: (error: Error) => void;
}

export interface RuntimeToolPermissionUseEvent {
  type: "oma.tool_permission_use";
  piToolCallId: string;
  name: string;
  input: JsonObject;
  evaluatedPermission: "allow" | "ask" | "deny";
  bindToolUseId: (
    toolUseId: string,
    releaseToolUseId: (reason?: RuntimeActionCloseReason) => void,
  ) => void;
  rejectToolUse: (error: Error) => void;
}

export interface RuntimeToolPermissionWithModelEndEvent {
  type: "oma.tool_permission_with_model_end";
  messageEnd: unknown;
  permissionUse: RuntimeToolPermissionUseEvent;
  suppressedPiToolCallIds: readonly string[];
}

export interface RuntimeTranslatorContext {
  customToolNames?: ReadonlySet<string>;
  publicToolUseIdForPiToolCallId?: (piToolCallId: string) => string | undefined;
  suppressPiToolUse?: (piToolCallId: string) => boolean;
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
