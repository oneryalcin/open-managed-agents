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
import type { ManagedAgentsSessionStatus } from "../../types/sessions.ts";
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
  /**
   * Also claim a turn whose unexpired lease is held by exactly this owner.
   * Only for the single-node startup sweep, where every other owner is a
   * previous process that is gone (#273).
   */
  takeOverOwnerId?: string;
}

/** One Pi session entry (header or SessionEntry), serialized by the runner. */
export interface ConversationEntryRecord {
  entryId: string;
  json: string;
}

/**
 * A settled turn's new Pi conversation entries (plan 0147). Written only while
 * `ownerId`/`ownerGeneration` still own the turn row, whatever its state, so
 * a turn this owner already closed (e.g. interrupted) still saves its entries
 * while a stale owner's write is rejected.
 */
export interface RuntimeConversationCheckpoint {
  workspaceId: WorkspaceId;
  sessionId: string;
  turnId: string;
  ownerId: string;
  ownerGeneration: number;
  piVersion: string;
  entries: readonly ConversationEntryRecord[];
  /** Turns whose user messages these entries include (coverage provenance). */
  coveredTurnIds: readonly string[];
  now: string;
}

/** A user message sent to Pi whose turn never settled (plan 0147). */
export interface UnfinishedUserMessage {
  eventId: string;
  text: string;
}

export interface LoadedConversation {
  entries: StoredConversationEntry[];
  unfinished: UnfinishedUserMessage[];
}

export interface StoredConversationEntry {
  entryId: string;
  json: string;
  turnId: string;
  piVersion: string;
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
  /** Applied after closedTurns, in the same transaction. */
  conversationCheckpoints?: RuntimeConversationCheckpoint[];
  /** Pi's cost for span ends in this batch (plan 0148). */
  modelRequestCosts?: ModelRequestCostRecord[];
}

/** What a span end's public model_usage lacks, keyed by the span-end event. */
export interface ModelRequestCostRecord {
  workspaceId: WorkspaceId;
  sessionId: string;
  spanEventId: string;
  /** Null: the request used tokens but its model had no known price. */
  costMicros: number | null;
  cacheWrite1hTokens: number;
  provider: string | null;
  modelId: string | null;
  now: string;
}

/** A session's usage totals (plan 0148), kept by database triggers. */
export interface SessionUsageTotals {
  spanCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  /** Null when any span end with tokens has no known cost. */
  costMicros: number | null;
  /** Closed running intervals. */
  activeMs: number;
  /** Start of the running interval still open, if any. */
  runningSince: string | null;
  /** Successful web_search calls (plan 0149). */
  webSearchRequests: number;
}

export interface SessionEventStore {
  append(event: PersistedSessionEvent): void;
  /**
   * Whether this owner and generation still own the turn row, open or closed
   * (the conversation checkpoint fence, plan 0147).
   */
  isRuntimeTurnOwnedBy(fence: {
    workspaceId: WorkspaceId;
    sessionId: string;
    turnId: string;
    ownerId: string;
    ownerGeneration: number;
  }): boolean;
  /** A session's events of the given types, in append order (plan 0149). */
  listEventsOfTypes(
    workspaceId: WorkspaceId,
    sessionId: string,
    types: readonly EventType[],
  ): PersistedSessionEvent[];
  /** Usage totals for the sessions that have any (plan 0148). */
  sessionUsage(
    workspaceId: WorkspaceId,
    sessionIds: readonly string[],
  ): Map<string, SessionUsageTotals>;
  /**
   * The status each session's latest `session.status_*` event reports, for
   * the sessions that have one (#279: the row is not updated while running).
   */
  latestSessionStatuses(
    workspaceId: WorkspaceId,
    sessionIds: readonly string[],
  ): Map<string, ManagedAgentsSessionStatus>;
  /**
   * Whether the turn is closed and this owner and generation still own it:
   * what this owner's own interrupt leaves behind (plan 0147).
   */
  isRuntimeTurnClosedBy(fence: {
    workspaceId: WorkspaceId;
    sessionId: string;
    turnId: string;
    ownerId: string;
    ownerGeneration: number;
  }): boolean;
  /**
   * A session's saved conversation plus the user messages whose turns never
   * settled, for rebuilding its Pi session (plan 0147).
   */
  loadConversation(workspaceId: WorkspaceId, sessionId: string): LoadedConversation;
  /** A session's saved Pi conversation, in append order (plan 0147). */
  listConversationEntries(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): StoredConversationEntry[];
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
  /**
   * Take ownership of a paused turn from `takeOverOwnerId` without changing
   * its state, so this process can resolve its open waits.
   */
  adoptPausedRuntimeTurn(
    claim: RuntimeTurnRecoveryClaim & { takeOverOwnerId: string },
  ): boolean;
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
  waitForPostIdleRuntimeSettle(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void>;
  assertSessionDeletable(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): void;
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
    opts?: {
      signal?: AbortSignal;
      /** The runtime turn this message started; checkpoints record it (plan 0147). */
      turnId?: string;
    },
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
  kind: "upload" | "skill";
  mountPath: string;
  snapshotFileId: string;
  sha256: string;
  sizeBytes: number;
  bytes: AsyncIterable<Uint8Array> | Uint8Array;
}

export interface RuntimeSessionPrepareOptions {
  fileMounts?: readonly RuntimeSessionFileMount[];
  skills?: readonly { name: string; description: string }[];
  /**
   * Creation-time hint for runtimes that prepare a sandbox before the session
   * row is committed. The committed row remains authoritative after create.
   */
  environmentId?: string;
  /**
   * Creation-time hint for MCP credential resolution during pre-commit
   * file-resource preparation. The committed row remains authoritative after
   * create; this only covers the row-not-yet-visible window.
   */
  vaultIds?: readonly string[];
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

/**
 * MCP internal runtime events (plan 0122 §4.4) — modeled on the
 * tool-permission pair: the use event binds its `sevt_*` id BEFORE the tool
 * executes so the result event can reference it, and the ask-path rides the
 * same pending-confirmation store.
 */
export interface RuntimeMcpToolUseEvent {
  type: "oma.mcp_tool_use";
  piToolCallId: string;
  mcpServerName: string;
  /** Bare tool name as reported by the server (wire parity: events carry this). */
  name: string;
  input: JsonObject;
  evaluatedPermission: "allow" | "ask" | "deny";
  bindToolUseId: (
    toolUseId: string,
    releaseToolUseId: (reason?: RuntimeActionCloseReason) => void,
  ) => void;
  rejectToolUse: (error: Error) => void;
}

export interface RuntimeMcpToolWithModelEndEvent {
  type: "oma.mcp_tool_with_model_end";
  messageEnd: unknown;
  mcpToolUse: RuntimeMcpToolUseEvent;
  suppressedPiToolCallIds: readonly string[];
}

/**
 * Terminal result for a persisted `agent.mcp_tool_use` — emitted on EVERY
 * path (success, in-band error, deny, confirmation timeout, abort, call
 * timeout, transport failure). `mcpToolUseId` is the bound `sevt_*` id.
 */
export interface RuntimeMcpToolResultEvent {
  type: "oma.mcp_tool_result";
  mcpToolUseId: string;
  content: ManagedAgentsContentBlock[];
  isError: boolean;
}

/** Connect/discovery failure, flushed at turn start as a session.error. */
export interface RuntimeMcpConnectionFailedEvent {
  type: "oma.mcp_connection_failed";
  errorType?: "mcp_connection_failed_error" | "mcp_authentication_failed_error";
  mcpServerName: string;
  message: string;
  retryStatus: "retrying" | "exhausted" | "terminal";
}

/**
 * Yielded once by the runner when the Pi run that owns a turn has settled
 * (plan 0147): `entries` are the Pi conversation entries appended since the
 * last acknowledged checkpoint. The service must call `release` on every exit:
 * `true` only after the checkpoint committed, which advances the runner's
 * cursor to this settlement's endpoint; `false` otherwise, keeping the
 * entries for the next settled turn. `release` is idempotent: the first call
 * wins, so a `finally` can always release with `false`.
 */
export interface RuntimeConversationSettledEvent {
  type: "oma.conversation_settled";
  entries: readonly ConversationEntryRecord[];
  /** Turns whose messages this settled run delivered: its own, plus steered. */
  turnIds: readonly string[];
  piVersion: string;
  release: (committed: boolean) => void;
}

export type RuntimeInternalEvent =
  | RuntimeCustomToolUseEvent
  | RuntimeToolPermissionUseEvent
  | RuntimeToolPermissionWithModelEndEvent
  | RuntimeMcpToolUseEvent
  | RuntimeMcpToolWithModelEndEvent
  | RuntimeMcpToolResultEvent
  | RuntimeMcpConnectionFailedEvent;

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
