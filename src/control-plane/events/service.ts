import {
  type ManagedAgentsContentBlock,
  type ListSessionEventsResponse,
  type ManagedAgentsEvent,
  type ManagedAgentsUserCustomToolResultEventInput,
  type ManagedAgentsUserEventInput,
  type ManagedAgentsUserToolConfirmationEventInput,
  type SendSessionEventsRequest,
} from "../../types/events.ts";
import { ApiError, invalidRequest, notFound, rateLimited, toApiErrorBody } from "../errors.ts";
import { log } from "../logging.ts";
import {
  idempotencyCompletion,
  idempotencyConflictResponse,
  idempotencyMismatchError,
  reserveWindow,
} from "../request-idempotency.ts";
import {
  type DeploymentSessionOutputCoordinator,
} from "../deployment-session-output-coordinator.ts";
import type { DeploymentRuntimeEventCoordinator } from "../deployment-runtime-event-coordinator.ts";
import type { SessionRow, SessionStore } from "../sessions/types.ts";
import type { WorkspaceId } from "../workspace.ts";
import { newRuntimeTurnId, newRequestId } from "../ids.ts";
import {
  spanModelRequestEndDraft,
  spanModelRequestStartDraft,
  syntheticSpanModelRequestEndDrafts,
} from "../sessions/pi/span-normalizer.ts";
import {
  materializePersistedEvents,
  persistAndPublish,
  persistRuntimeChangesAndPublish,
  persistRuntimeChangesCompleteIdempotencyAndPublish,
  type EventDraft,
} from "./persist.ts";
import type {
  EventsSendIdempotencyKey,
  EventStoreRuntimeChanges,
  ListSessionEventsOptions,
  PendingRuntimeActionRecord,
  PendingRuntimeTurnRecord,
  RuntimeCustomToolUseEvent,
  RuntimeEventRunner,
  RuntimeEventTranslator,
  RuntimeMcpConnectionFailedEvent,
  RuntimeMcpToolResultEvent,
  RuntimeMcpToolUseEvent,
  RuntimeMcpToolWithModelEndEvent,
  RuntimeToolPermissionUseEvent,
  RuntimeToolPermissionWithModelEndEvent,
  PersistedSessionEvent,
  SessionEventBroadcaster,
  SessionEventStore,
  SessionEventsService,
  SessionEventsHttpResponse,
  StreamSessionEventsOptions,
} from "./types.ts";
import {
  RuntimeTurnOwnershipLostError,
  toManagedAgentsEvent,
} from "./types.ts";
import {
  archiveGuardKey,
  requireActiveSession,
  requireExistingSession,
  sessionNotArchivable,
  sessionScopeKey,
} from "./session-guards.ts";
import { PendingActionStore } from "./pending-actions.ts";
import {
  eventPayload,
  hasToolResultForToolUseId,
  lostMcpToolConfirmationPayload,
  lostToolConfirmationPayload,
  parseSendRequest,
  sameCustomToolResult,
  sameCustomToolResultPayload,
  sameToolConfirmation,
  toSendResponseEvent,
} from "./request.ts";
import {
  actionClosedWithoutResult,
  hasTerminalIdleDraft,
  isAcknowledgedInFlightAction,
  isRuntimeCustomToolUseEvent,
  isRuntimeLeaseExpired,
  isRuntimeMcpConnectionFailedEvent,
  isRuntimeMcpToolResultEvent,
  isRuntimeMcpToolUseEvent,
  isRuntimeMcpToolWithModelEndEvent,
  isRuntimeToolPermissionUseEvent,
  isRuntimeToolPermissionWithModelEndEvent,
  isRuntimeTurnClosed,
  leaseExpiresAt,
  runtimeErrorDraft,
  runtimeLeaseRetryDelayMs,
  runtimeTurnStillOwned,
  textFromContent,
  toError,
  unique,
} from "./runtime-helpers.ts";
import {
  materializeMcpConnectionFailedRows,
  materializeMcpToolResultRows,
  materializeMcpToolUseRows,
  materializeToolPermissionUseRows,
  toolPermissionRuntimeChanges,
} from "./tool-persistence.ts";

interface ToolConfirmationCommit {
  event: ManagedAgentsUserToolConfirmationEventInput;
  toolUseId: string;
  commit: () => void;
  row?: PersistedSessionEvent;
}

interface ToolConfirmationReplay {
  event: ManagedAgentsUserToolConfirmationEventInput;
  row: PersistedSessionEvent;
}

interface ToolConfirmationTerminalize {
  event: ManagedAgentsUserToolConfirmationEventInput;
  toolUseId: string;
  action: PendingRuntimeActionRecord;
  row?: PersistedSessionEvent;
}

interface RuntimePrompt {
  text: string;
  eventId: string;
  turnId: string;
  ownerId: string;
  ownerGeneration: number;
}

type CustomToolResultClaim =
  | {
      kind: "live";
      event: ManagedAgentsUserCustomToolResultEventInput;
      customToolUseId: string;
      commit: () => void;
      action?: PendingRuntimeActionRecord;
    }
  | {
      kind: "duplicate";
      event: ManagedAgentsUserCustomToolResultEventInput;
      customToolUseId: string;
      row?: PersistedSessionEvent;
    }
  | {
      kind: "terminalize";
      event: ManagedAgentsUserCustomToolResultEventInput;
      customToolUseId: string;
      action: PendingRuntimeActionRecord;
    };

export class DefaultSessionEventsService implements SessionEventsService {
  private readonly maxPendingRuntimeTurnsPerWorkspace: number | undefined;
  private readonly onAdmissionRejected: (() => void) | undefined;
  private readonly ownerId: string;
  private readonly ownerGeneration = 1;
  private readonly leaseTtlMs: number;
  private readonly runtimeRunner: RuntimeEventRunner | undefined;
  private readonly runtimeTranslator: RuntimeEventTranslator | undefined;
  private readonly sessionOutputCoordinator:
    | DeploymentSessionOutputCoordinator
    | undefined;
  private readonly runtimeEventCoordinator:
    | DeploymentRuntimeEventCoordinator
    | undefined;
  private readonly pendingCustomToolActions = new PendingActionStore(
    (workspaceId, sessionId) => this.flushPendingActions(workspaceId, sessionId),
  );
  private readonly closedSessions = new Set<string>();
  private readonly deletedSessions = new Set<string>();
  private readonly activeRuntimeTasks = new Map<string, number>();
  private readonly interruptedCustomToolActions = new Map<string, Set<string>>();
  private readonly pendingToolConfirmations = new PendingActionStore(
    (workspaceId, sessionId) => this.flushPendingActions(workspaceId, sessionId),
  );
  private readonly interruptedToolConfirmations = new Map<string, Set<string>>();
  private readonly completedToolConfirmations = new Map<
    string,
    {
      workspaceId: WorkspaceId;
      sessionId: string;
      result: "allow" | "deny";
      denyMessage?: string | null;
      row: PersistedSessionEvent;
    }
  >();
  private readonly archivingSessions = new Map<string, number>();
  private readonly recoveryTimers = new Map<
    WorkspaceId,
    {
      dueAt: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly events: SessionEventStore,
    private readonly sessions: SessionStore,
    private readonly broadcaster: SessionEventBroadcaster,
    runtime?: {
      runner: RuntimeEventRunner;
      translate: RuntimeEventTranslator;
      sessionOutputCoordinator?: DeploymentSessionOutputCoordinator;
      runtimeEventCoordinator: DeploymentRuntimeEventCoordinator;
      ownerId?: string;
      leaseTtlMs?: number;
    },
    opts: {
      maxPendingRuntimeTurnsPerWorkspace?: number;
      /** 0121 C2: telemetry-only, fired when the pending-turns cap rejects. */
      onAdmissionRejected?: () => void;
    } = {},
  ) {
    this.maxPendingRuntimeTurnsPerWorkspace =
      opts.maxPendingRuntimeTurnsPerWorkspace;
    this.onAdmissionRejected = opts.onAdmissionRejected;
    this.runtimeRunner = runtime?.runner;
    this.runtimeTranslator = runtime?.translate;
    this.sessionOutputCoordinator = runtime?.sessionOutputCoordinator;
    this.runtimeEventCoordinator = runtime?.runtimeEventCoordinator;
    this.ownerId = runtime?.ownerId ?? `owner_${newRequestId()}`;
    this.leaseTtlMs = runtime?.leaseTtlMs ?? 120_000;
  }

  send(
    workspaceId: WorkspaceId,
    sessionId: string,
    input: unknown,
    opts: { signal?: AbortSignal } = {},
  ): ManagedAgentsEvent[] {
    return this.sendInternal(workspaceId, sessionId, input, opts);
  }

  sendIdempotent(
    workspaceId: WorkspaceId,
    sessionId: string,
    input: unknown,
    idempotency: EventsSendIdempotencyKey,
    opts: { signal?: AbortSignal; requestId?: string } = {},
  ): SessionEventsHttpResponse {
    // Keep reservation and domain execution in one synchronous call path after
    // the route has read the raw body. Adding an await here would reopen the
    // same-key interleaving ADR 0015 is designed to avoid.
    const reservation = this.events.reserveIdempotencyKey({
      ...idempotency,
      workspaceId,
      ...reserveWindow(),
    });
    if (reservation.kind === "replay") {
      return {
        status: reservation.responseStatus,
        body: reservation.responseBody,
      };
    }
    if (reservation.kind === "fingerprint_mismatch") {
      throw idempotencyMismatchError();
    }
    if (reservation.kind === "in_progress") {
      return idempotencyConflictResponse(opts.requestId);
    }
    try {
      const events = this.sendInternal(workspaceId, sessionId, input, {
        signal: opts.signal,
        idempotency,
      });
      return { status: 200, body: { data: events } };
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        // Transient admission rejection: completing the key would replay the
        // 429 forever. Release so the same-key retry re-executes (0113 D9).
        this.events.releaseIdempotencyReservation({ ...idempotency, workspaceId });
        throw error;
      }
      if (error instanceof ApiError && error.status < 500) {
        // Replay returns the original error envelope, including request_id.
        // The fresh HTTP header still carries the retry attempt's request id.
        const body = toApiErrorBody(error, opts.requestId);
        this.events.completeIdempotency(
          idempotencyCompletion(workspaceId, idempotency, {
            status: error.status,
            body,
          }),
        );
        return { status: error.status, body };
      }
      throw error;
    }
  }

  private sendInternal(
    workspaceId: WorkspaceId,
    sessionId: string,
    input: unknown,
    opts: { signal?: AbortSignal; idempotency?: EventsSendIdempotencyKey } = {},
  ): ManagedAgentsEvent[] {
    if (this.isArchivingSession(workspaceId, sessionId)) {
      throw notFound(`Session ${sessionId} not found`);
    }
    requireActiveSession(this.sessions, workspaceId, sessionId);
    const req = parseSendRequest(input);
    this.enforceRuntimeTurnAdmission(workspaceId, req.events);
    const customToolResultClaims = this.claimCustomToolResults(
      workspaceId,
      sessionId,
      req.events,
    );
    const toolConfirmationClaims = this.claimToolConfirmations(
      workspaceId,
      sessionId,
      req.events,
    );
    const existingToolConfirmations = new Map<
      ManagedAgentsUserEventInput,
      PersistedSessionEvent
    >(
      toolConfirmationClaims
        .filter(
          (
            claim,
          ): claim is (
            | ToolConfirmationCommit
            | ToolConfirmationReplay
            | ToolConfirmationTerminalize
          ) & {
            row: PersistedSessionEvent;
          } => "row" in claim && claim.row !== undefined,
        )
        .map((claim) => [claim.event, claim.row] as const),
    );
    const existingCustomToolResults = new Map<
      ManagedAgentsUserEventInput,
      PersistedSessionEvent
    >(
      customToolResultClaims
        .filter(
          (
            claim,
          ): claim is Extract<CustomToolResultClaim, { kind: "duplicate" }> & {
            row: PersistedSessionEvent;
          } =>
            claim.kind === "duplicate" && claim.row !== undefined,
        )
        .map((claim) => [claim.event, claim.row] as const),
    );
    const persistableEvents = req.events.filter(
      (event) =>
        !existingToolConfirmations.has(event) &&
        !existingCustomToolResults.has(event),
    );
    const now = new Date().toISOString();
    const drafts: EventDraft[] = persistableEvents.map((event) => ({
      type: event.type,
      payload: eventPayload(event),
    }));
    const rows = materializePersistedEvents(workspaceId, sessionId, drafts, now);
    // TODO(idempotency): events.send is non-idempotent in B.2. Add request-level
    // dedupe before B.4 runtime consumers process irreversible actions
    // (notably user.tool_confirmation and user.custom_tool_result).
    const rowsByInput = new Map<
      SendSessionEventsRequest["events"][number],
      PersistedSessionEvent
    >();
    for (let i = 0; i < persistableEvents.length; i += 1) {
      rowsByInput.set(persistableEvents[i], rows[i]);
    }
    const runtimeChanges: EventStoreRuntimeChanges = {};
    const runtimePrompts =
      this.runtimeRunner && this.runtimeTranslator
        ? this.runtimePromptsForRows(
            workspaceId,
            sessionId,
            persistableEvents,
            rowsByInput,
            now,
            runtimeChanges,
          )
        : [];
    const terminalRows = this.customToolTerminalizationRows(
      workspaceId,
      sessionId,
      customToolResultClaims,
      now,
      runtimeChanges,
    );
    const toolConfirmationTerminalRows = this.toolConfirmationTerminalizationRows(
      workspaceId,
      sessionId,
      toolConfirmationClaims,
      now,
      runtimeChanges,
    );
    for (const claim of customToolResultClaims) {
      if (claim.kind !== "live" || !claim.action) continue;
      (runtimeChanges.acknowledgedActions ??= []).push({
        workspaceId,
        sessionId,
        actionId: claim.customToolUseId,
        now,
      });
    }
    const responseEvents = req.events.map((event) =>
      toSendResponseEvent(
        existingToolConfirmations.get(event) ??
          existingCustomToolResults.get(event) ??
          rowsByInput.get(event),
      ),
    );
    const persistedRows = [...rows, ...terminalRows, ...toolConfirmationTerminalRows];
    if (opts.idempotency) {
      persistRuntimeChangesCompleteIdempotencyAndPublish(
        this.events,
        this.broadcaster,
        persistedRows,
        runtimeChanges,
        idempotencyCompletion(workspaceId, opts.idempotency, {
          status: 200,
          body: { data: responseEvents },
        }),
      );
    } else {
      persistRuntimeChangesAndPublish(
        this.events,
        this.broadcaster,
        persistedRows,
        runtimeChanges,
      );
    }
    this.scheduleAcceptedTurnRecovery(runtimeChanges.acceptedTurns);
    const committedToolConfirmations = toolConfirmationClaims.filter(
      (claim): claim is ToolConfirmationCommit => "commit" in claim,
    );
    const liveCustomToolResultClaims = customToolResultClaims.filter(
      (claim): claim is Extract<CustomToolResultClaim, { kind: "live" }> =>
        claim.kind === "live",
    );
    const hasCommittedRuntimeInputs =
      liveCustomToolResultClaims.length > 0 ||
      committedToolConfirmations.length > 0;
    if (hasCommittedRuntimeInputs) {
      for (const { customToolUseId } of liveCustomToolResultClaims) {
        this.pendingCustomToolActions.remove(workspaceId, sessionId, customToolUseId);
      }
      for (const { toolUseId } of committedToolConfirmations) {
        this.pendingToolConfirmations.remove(workspaceId, sessionId, toolUseId);
      }
      this.persistRuntimeDrafts(workspaceId, sessionId, [
        { type: "session.status_running", payload: {} },
      ]);
      for (const { commit, customToolUseId } of liveCustomToolResultClaims) {
        try {
          commit();
        } catch (error) {
          log.error("custom_tool_result_callback_failed", {
            sessionId,
            customToolUseId,
            error,
          });
        }
      }
      for (const claim of committedToolConfirmations) {
        const row = claim.row ?? rowsByInput.get(claim.event);
        if (!row) {
          throw new Error("Persisted tool confirmation row missing");
        }
        try {
          claim.commit();
        } catch (error) {
          log.error("tool_confirmation_callback_failed", {
            sessionId,
            toolUseId: claim.toolUseId,
            error,
          });
        }
        this.completedToolConfirmations.set(claim.event.tool_use_id, {
          workspaceId,
          sessionId,
          result: claim.event.result,
          denyMessage: claim.event.deny_message,
          row,
        });
      }
      this.flushPendingActions(workspaceId, sessionId);
    }
    this.maybeRunRuntimeFromUserMessages(
      workspaceId,
      sessionId,
      runtimePrompts,
      opts.signal,
    );
    this.maybeInterruptRuntime(workspaceId, sessionId, req.events);
    return responseEvents;
  }

  private maybeInterruptRuntime(
    workspaceId: WorkspaceId,
    sessionId: string,
    events: SendSessionEventsRequest["events"],
  ): void {
    if (!events.some((event) => event.type === "user.interrupt")) return;
    this.blockInterruptedCustomToolActions(
      workspaceId,
      sessionId,
      this.closeInterruptedRuntimeActions(
        workspaceId,
        sessionId,
        unique([
          ...this.pendingCustomToolActions.clear(workspaceId, sessionId),
          ...this.pendingRuntimeActionIds(workspaceId, sessionId, "custom_tool"),
        ]),
      ),
    );
    this.blockInterruptedToolConfirmations(
      workspaceId,
      sessionId,
      this.closeInterruptedRuntimeActions(
        workspaceId,
        sessionId,
        unique([
          ...this.pendingToolConfirmations.clear(workspaceId, sessionId),
          ...this.pendingRuntimeActionIds(
            workspaceId,
            sessionId,
            "tool_confirmation",
          ),
        ]),
      ),
    );
    void Promise.resolve(
      this.runtimeRunner?.interruptSession?.(workspaceId, sessionId),
    ).catch((error) => {
      log.error("runtime_interrupt_failed", { sessionId, error });
    });
  }

  private pendingRuntimeActionIds(
    workspaceId: WorkspaceId,
    sessionId: string,
    actionType: PendingRuntimeActionRecord["action_type"],
  ): string[] {
    return this.events
      .listPendingRuntimeTurns(workspaceId)
      .filter((turn) => turn.session_id === sessionId)
      .flatMap((turn) =>
        this.events.listRuntimeActionsForTurn(
          workspaceId,
          sessionId,
          turn.turn_id,
        ),
      )
      .filter(
        (action) =>
          action.action_type === actionType && action.state === "pending",
      )
      .map((action) => action.action_id);
  }

  private closeInterruptedRuntimeActions(
    workspaceId: WorkspaceId,
    sessionId: string,
    actionIds: readonly string[],
  ): string[] {
    if (actionIds.length === 0) return [];
    const now = new Date().toISOString();
    const turns = new Map<string, PendingRuntimeTurnRecord>();
    for (const actionId of actionIds) {
      const action = this.events.findRuntimeAction(workspaceId, sessionId, actionId);
      if (action) turns.set(action.turn_id, action.turn);
    }
    if (turns.size > 0) {
      const drafts = [...turns.values()].flatMap((turn) =>
        syntheticSpanModelRequestEndDrafts(
          turn.open_model_request_start_ids,
        ),
      );
      const rows = materializePersistedEvents(workspaceId, sessionId, drafts, now);
      persistRuntimeChangesAndPublish(this.events, this.broadcaster, rows, {
        closedTurns: [...turns.values()].map((turn) => ({
          workspaceId,
          sessionId,
          turnId: turn.turn_id,
          ownerId: turn.owner_id,
          ownerGeneration: turn.owner_generation,
          reason: "interrupted",
          state: "terminalized",
          now,
        })),
      });
    }
    return [...actionIds];
  }

  private runtimePromptsForRows(
    workspaceId: WorkspaceId,
    sessionId: string,
    events: readonly SendSessionEventsRequest["events"][number][],
    rowsByInput: ReadonlyMap<
      SendSessionEventsRequest["events"][number],
      PersistedSessionEvent
    >,
    now: string,
    runtimeChanges: EventStoreRuntimeChanges,
  ): RuntimePrompt[] {
    const prompts: RuntimePrompt[] = [];
    for (const event of events) {
      if (event.type !== "user.message") continue;
      const text = textFromContent(event.content);
      if (text === undefined) continue;
      const row = rowsByInput.get(event);
      if (!row) throw new Error("Persisted user.message row missing");
      const turnId = newRuntimeTurnId();
      prompts.push({
        text,
        eventId: row.id,
        turnId,
        ownerId: this.ownerId,
        ownerGeneration: this.ownerGeneration,
      });
      (runtimeChanges.acceptedTurns ??= []).push({
        workspaceId,
        sessionId,
        turnId,
        ownerId: this.ownerId,
        ownerGeneration: this.ownerGeneration,
        leaseExpiresAt: leaseExpiresAt(now, this.leaseTtlMs),
        triggerEventIds: [row.id],
        now,
      });
    }
    return prompts;
  }

  private customToolTerminalizationRows(
    workspaceId: WorkspaceId,
    sessionId: string,
    claims: readonly CustomToolResultClaim[],
    now: string,
    runtimeChanges: EventStoreRuntimeChanges,
  ): PersistedSessionEvent[] {
    const terminalizedTurnIds = new Set<string>();
    const drafts: EventDraft[] = [];
    for (const claim of claims) {
      if (claim.kind !== "terminalize") continue;
      const turn = claim.action.turn;
      (runtimeChanges.acknowledgedActions ??= []).push({
        workspaceId,
        sessionId,
        actionId: claim.customToolUseId,
        now,
      });
      if (terminalizedTurnIds.has(claim.action.turn_id)) continue;
      terminalizedTurnIds.add(claim.action.turn_id);
      (runtimeChanges.closedTurns ??= []).push({
        workspaceId,
        sessionId,
        turnId: claim.action.turn_id,
        ownerId: turn.owner_id,
        ownerGeneration: turn.owner_generation,
        reason: "terminalized",
        state: "terminalized",
        now,
      });
      drafts.push(
        ...syntheticSpanModelRequestEndDrafts(
          turn.open_model_request_start_ids,
        ),
        {
          type: "session.error",
          payload: {
            message: `Custom tool result ${claim.customToolUseId} was accepted, but runtime state is no longer available and the custom tool execution outcome is unknown.`,
          },
        },
        {
          type: "session.status_idle",
          payload: { stop_reason: { type: "end_turn" } },
        },
      );
    }
    if (drafts.length === 0) return [];
    return materializePersistedEvents(workspaceId, sessionId, drafts, now);
  }

  private toolConfirmationTerminalizationRows(
    workspaceId: WorkspaceId,
    sessionId: string,
    claims: readonly (ToolConfirmationCommit | ToolConfirmationReplay | ToolConfirmationTerminalize)[],
    now: string,
    runtimeChanges: EventStoreRuntimeChanges,
  ): PersistedSessionEvent[] {
    const terminalizedTurnIds = new Set<string>();
    const drafts: EventDraft[] = [];
    for (const claim of claims) {
      if (!("action" in claim)) continue;
      const turn = claim.action.turn;
      (runtimeChanges.acknowledgedActions ??= []).push({
        workspaceId,
        sessionId,
        actionId: claim.toolUseId,
        now,
      });
      if (terminalizedTurnIds.has(claim.action.turn_id)) continue;
      terminalizedTurnIds.add(claim.action.turn_id);
      (runtimeChanges.closedTurns ??= []).push({
        workspaceId,
        sessionId,
        turnId: claim.action.turn_id,
        ownerId: turn.owner_id,
        ownerGeneration: turn.owner_generation,
        reason: "terminalized",
        state: "terminalized",
        now,
      });
      drafts.push(
        ...syntheticSpanModelRequestEndDrafts(
          turn.open_model_request_start_ids,
        ),
        this.lostToolConfirmationResultDraft(
          workspaceId,
          sessionId,
          claim.toolUseId,
        ),
        {
          type: "session.status_idle",
          payload: { stop_reason: { type: "end_turn" } },
        },
      );
    }
    if (drafts.length === 0) return [];
    return materializePersistedEvents(workspaceId, sessionId, drafts, now);
  }

  archiveSessionRowAfterPreflight(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): SessionRow {
    this.assertSessionArchivable(workspaceId, sessionId);
    this.incrementArchivingSession(workspaceId, sessionId);
    try {
      const archivedAt = new Date().toISOString();
      const row = this.sessions.archive(workspaceId, sessionId, archivedAt);
      if (!row) {
        throw notFound(`Session ${sessionId} not found`);
      }
      return row;
    } finally {
      this.decrementArchivingSession(workspaceId, sessionId);
    }
  }

  private assertSessionArchivable(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): void {
    const session = requireExistingSession(this.sessions, workspaceId, sessionId);
    if (session.archived_at !== null || session.status === "terminated") return;
    if (
      this.activeRuntimeTaskCount(workspaceId, sessionId) > 0 &&
      !this.hasPendingRuntimeActions(workspaceId, sessionId)
    ) {
      throw sessionNotArchivable(sessionId, "running");
    }
    if (session.status === "running" || session.status === "rescheduling") {
      throw sessionNotArchivable(sessionId, session.status);
    }
  }

  private isArchivingSession(workspaceId: WorkspaceId, sessionId: string): boolean {
    return (
      (this.archivingSessions.get(archiveGuardKey(workspaceId, sessionId)) ?? 0) >
      0
    );
  }

  private incrementArchivingSession(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): void {
    const key = archiveGuardKey(workspaceId, sessionId);
    this.archivingSessions.set(key, (this.archivingSessions.get(key) ?? 0) + 1);
  }

  private decrementArchivingSession(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): void {
    const key = archiveGuardKey(workspaceId, sessionId);
    const remaining = (this.archivingSessions.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.archivingSessions.set(key, remaining);
      return;
    }
    this.archivingSessions.delete(key);
  }

  async archiveSession(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void> {
    requireExistingSession(this.sessions, workspaceId, sessionId);
    this.closedSessions.add(sessionScopeKey(workspaceId, sessionId));
    this.pendingCustomToolActions.clear(workspaceId, sessionId);
    this.pendingToolConfirmations.clear(workspaceId, sessionId);
    this.clearCompletedToolConfirmations(workspaceId, sessionId);
    this.interruptedCustomToolActions.delete(sessionScopeKey(workspaceId, sessionId));
    this.interruptedToolConfirmations.delete(sessionScopeKey(workspaceId, sessionId));
    this.closePendingRuntimeTurnsForSession(workspaceId, sessionId, "archived", {
      includeTerminatedStatus:
        !this.hasSessionEvent(workspaceId, sessionId, "session.status_terminated"),
    });
    await this.closeRuntimeBestEffort(workspaceId, sessionId);
    this.retireLifecycleGuardsIfIdle(workspaceId, sessionId);
  }

  async deleteSession(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void> {
    this.closedSessions.add(sessionScopeKey(workspaceId, sessionId));
    this.pendingCustomToolActions.clear(workspaceId, sessionId);
    this.pendingToolConfirmations.clear(workspaceId, sessionId);
    this.clearCompletedToolConfirmations(workspaceId, sessionId);
    this.interruptedCustomToolActions.delete(sessionScopeKey(workspaceId, sessionId));
    this.interruptedToolConfirmations.delete(sessionScopeKey(workspaceId, sessionId));
    this.closePendingRuntimeTurnsForSession(workspaceId, sessionId, "deleted");
    this.persistLifecycleDrafts(workspaceId, sessionId, [
      { type: "session.deleted", payload: {} },
    ]);
    this.broadcaster.closeSession(workspaceId, sessionId);
    this.deletedSessions.add(sessionScopeKey(workspaceId, sessionId));
    await this.closeRuntimeBestEffort(workspaceId, sessionId);
    this.events.deleteForSession(workspaceId, sessionId);
    this.retireLifecycleGuardsIfIdle(workspaceId, sessionId);
  }

  private closePendingRuntimeTurnsForSession(
    workspaceId: WorkspaceId,
    sessionId: string,
    reason: "archived" | "deleted",
    opts: { includeTerminatedStatus?: boolean } = {},
  ): void {
    const now = new Date().toISOString();
    // Keep list-and-close synchronous. These archive closes intentionally do
    // not owner-fence individual turns; introducing an await here would allow a
    // runtime owner to close the same turn between the list and the batch.
    const turns = this.events
      .listPendingRuntimeTurns(workspaceId)
      .filter((turn) => turn.session_id === sessionId);
    const drafts =
      reason === "archived"
        ? turns.flatMap((turn) =>
            syntheticSpanModelRequestEndDrafts(
              turn.open_model_request_start_ids,
            ),
          )
        : [];
    if (opts.includeTerminatedStatus === true) {
      drafts.push({ type: "session.status_terminated", payload: {} });
    }
    if (turns.length === 0 && drafts.length === 0) return;
    const rows = materializePersistedEvents(workspaceId, sessionId, drafts, now);
    persistRuntimeChangesAndPublish(this.events, this.broadcaster, rows, {
      closedTurns: turns.map((turn) => ({
        workspaceId,
        sessionId,
        turnId: turn.turn_id,
        reason,
        state: "terminalized",
        now,
      })),
    });
  }

  // 0113 D9: each user.message in a send accepts a runtime turn, so pending
  // turns are unbounded per workspace without this gate. Checked before any
  // event persists; count-then-accept is not atomic, but the deployment app
  // is single-process, so an overshoot of one batch is the worst case.
  private enforceRuntimeTurnAdmission(
    workspaceId: WorkspaceId,
    events: readonly SendSessionEventsRequest["events"][number][],
  ): void {
    const cap = this.maxPendingRuntimeTurnsPerWorkspace;
    if (cap === undefined) return;
    // Same predicate as runtimePromptsForRows: only user.message events that
    // yield prompt text accept a runtime turn, so only those count against
    // the cap. A non-text message must not be rejected for capacity it would
    // never consume.
    const newTurns = events.filter(
      (event) =>
        event.type === "user.message" &&
        textFromContent(event.content) !== undefined,
    ).length;
    if (newTurns === 0) return;
    if (this.events.countPendingRuntimeTurns(workspaceId) + newTurns > cap) {
      this.onAdmissionRejected?.();
      throw rateLimited(
        "Concurrent pending runtime turn limit reached for this workspace; retry later",
      );
    }
  }

  // 0113 D7: restart recovery must cover every workspace with pending turns,
  // not just wrk_default — otherwise a restart silently abandons
  // non-default-workspace turns.
  recoverAllAbandonedRuntimeTurns(): void {
    for (const workspaceId of this.events.listWorkspaceIdsWithPendingRuntimeTurns()) {
      this.recoverAbandonedRuntimeTurns(workspaceId);
    }
  }

  recoverAbandonedRuntimeTurns(workspaceId: WorkspaceId): void {
    const turns = this.events.listPendingRuntimeTurns(workspaceId);
    let nextRetryAt: number | undefined;
    for (const turn of turns) {
      if (this.closedSessions.has(sessionScopeKey(workspaceId, turn.session_id))) continue;
      if (this.deletedSessions.has(sessionScopeKey(workspaceId, turn.session_id))) continue;
      if (!this.isRecoverableSession(workspaceId, turn.session_id)) continue;
      if (this.activeRuntimeTaskCount(workspaceId, turn.session_id) > 0) continue;
      const retryDelayMs = runtimeLeaseRetryDelayMs(turn.lease_expires_at);
      if (retryDelayMs > 0) {
        const retryAt = Date.now() + retryDelayMs;
        nextRetryAt =
          nextRetryAt === undefined ? retryAt : Math.min(nextRetryAt, retryAt);
        continue;
      }
      if (turn.state === "accepted") {
        const claimed = this.claimAcceptedTurn(turn);
        if (!claimed) continue;
        const prompts = this.promptsFromAcceptedTurn(claimed);
        if (prompts.length === 0) {
          this.terminalizeAbandonedRuntimeTurn(
            claimed,
            "Accepted runtime turn has no recoverable trigger event.",
          );
          continue;
        }
        this.beginRuntimeTask(workspaceId, claimed.session_id);
        void this.runRuntimePrompts(
          workspaceId,
          claimed.session_id,
          prompts,
          undefined,
        ).finally(() => {
          this.finishRuntimeTask(workspaceId, claimed.session_id);
        });
        continue;
      }
      if (
        turn.state === "paused" &&
        this.events.listRuntimeActionsForTurn(
          workspaceId,
          turn.session_id,
          turn.turn_id,
        ).some((action) => action.state === "pending")
      ) {
        continue;
      }
      const claimed = this.claimTurnForTerminalization(turn);
      if (!claimed) continue;
      this.terminalizeAbandonedRuntimeTurn(
        claimed,
        "Runtime state is no longer available and the turn outcome is unknown.",
      );
    }
    this.scheduleAbandonedRuntimeRecovery(workspaceId, nextRetryAt);
  }

  private isRecoverableSession(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): boolean {
    const session = this.sessions.retrieveAny(workspaceId, sessionId);
    if (!session) return false;
    return session.archived_at === null && session.status !== "terminated";
  }

  private scheduleAcceptedTurnRecovery(
    acceptedTurns: EventStoreRuntimeChanges["acceptedTurns"],
  ): void {
    if (!acceptedTurns || acceptedTurns.length === 0) return;
    const earliestRetryAtByWorkspace = new Map<WorkspaceId, number>();
    for (const turn of acceptedTurns) {
      const retryAt = Date.now() + runtimeLeaseRetryDelayMs(turn.leaseExpiresAt);
      const earliest = earliestRetryAtByWorkspace.get(turn.workspaceId);
      if (earliest === undefined || retryAt < earliest) {
        earliestRetryAtByWorkspace.set(turn.workspaceId, retryAt);
      }
    }
    for (const [workspaceId, retryAt] of earliestRetryAtByWorkspace) {
      this.scheduleAbandonedRuntimeRecovery(workspaceId, retryAt);
    }
  }

  private scheduleAbandonedRuntimeRecovery(
    workspaceId: WorkspaceId,
    retryAt: number | undefined,
  ): void {
    if (retryAt === undefined) return;
    const existing = this.recoveryTimers.get(workspaceId);
    if (existing && existing.dueAt <= retryAt) return;
    if (existing) clearTimeout(existing.timer);
    const delayMs = Math.max(1, retryAt - Date.now() + 1);
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(workspaceId);
      this.recoverAbandonedRuntimeTurns(workspaceId);
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
    this.recoveryTimers.set(workspaceId, { dueAt: retryAt, timer });
  }

  private claimAcceptedTurn(turn: {
    workspace_id: WorkspaceId;
    session_id: string;
    turn_id: string;
  }) {
    const now = new Date().toISOString();
    return this.events.claimAcceptedRuntimeTurnForRecovery({
      workspaceId: turn.workspace_id,
      sessionId: turn.session_id,
      turnId: turn.turn_id,
      ownerId: this.ownerId,
      leaseExpiresAt: leaseExpiresAt(now, this.leaseTtlMs),
      now,
    });
  }

  private claimTurnForTerminalization(turn: {
    workspace_id: WorkspaceId;
    session_id: string;
    turn_id: string;
  }) {
    const now = new Date().toISOString();
    return this.events.claimRuntimeTurnForTerminalization({
      workspaceId: turn.workspace_id,
      sessionId: turn.session_id,
      turnId: turn.turn_id,
      ownerId: this.ownerId,
      leaseExpiresAt: leaseExpiresAt(now, this.leaseTtlMs),
      now,
    });
  }

  private promptsFromAcceptedTurn(turn: {
    workspace_id: WorkspaceId;
    session_id: string;
    turn_id: string;
    owner_id: string;
    owner_generation: number;
    trigger_event_ids: readonly string[];
  }): RuntimePrompt[] {
    const prompts: RuntimePrompt[] = [];
    for (const eventId of turn.trigger_event_ids) {
      const row = this.events.retrieve(turn.workspace_id, eventId);
      if (!row || row.type !== "user.message") continue;
      const content = row.payload.content;
      if (!Array.isArray(content)) continue;
      const text = textFromContent(content as ManagedAgentsContentBlock[]);
      if (text === undefined) continue;
      prompts.push({
        text,
        eventId: row.id,
        turnId: turn.turn_id,
        ownerId: turn.owner_id,
        ownerGeneration: turn.owner_generation,
      });
    }
    return prompts;
  }

  private terminalizeAbandonedRuntimeTurn(
    turn: PendingRuntimeTurnRecord,
    message: string,
  ): void {
    const now = new Date().toISOString();
    const rows = materializePersistedEvents(
      turn.workspace_id,
      turn.session_id,
      [
        ...syntheticSpanModelRequestEndDrafts(
          turn.open_model_request_start_ids,
        ),
        { type: "session.error", payload: { message } },
        {
          type: "session.status_idle",
          payload: { stop_reason: { type: "end_turn" } },
        },
      ],
      now,
    );
    persistRuntimeChangesAndPublish(this.events, this.broadcaster, rows, {
      closedTurns: [
        {
          workspaceId: turn.workspace_id,
          sessionId: turn.session_id,
          turnId: turn.turn_id,
          ownerId: turn.owner_id,
          ownerGeneration: turn.owner_generation,
          reason: "terminalized",
          state: "terminalized",
          now,
        },
      ],
    });
  }

  private async closeRuntimeBestEffort(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.runtimeRunner?.closeSession?.(workspaceId, sessionId);
    } catch (error) {
      log.error("runtime_cleanup_failed", { sessionId, error });
    }
  }

  private hasSessionEvent(
    workspaceId: WorkspaceId,
    sessionId: string,
    type: string,
  ): boolean {
    return this.events.list(workspaceId, sessionId, { limit: 1, types: [type] }).length > 0;
  }

  list(
    workspaceId: WorkspaceId,
    sessionId: string,
    opts: ListSessionEventsOptions = {},
  ): ListSessionEventsResponse {
    requireExistingSession(this.sessions, workspaceId, sessionId);
    const page = this.events.listPage(workspaceId, sessionId, opts);
    return {
      data: page.data.map(toManagedAgentsEvent),
      next_page: page.next_page,
    };
  }

  stream(
    workspaceId: WorkspaceId,
    sessionId: string,
    opts: StreamSessionEventsOptions = {},
  ): AsyncIterable<ManagedAgentsEvent> {
    const session = requireExistingSession(this.sessions, workspaceId, sessionId);
    const lastSeenId = this.resolveResumeCursor(
      workspaceId,
      sessionId,
      opts.lastEventId,
    );
    if (session.archived_at !== null || session.status === "terminated") {
      return this.replayClosedSession(
        workspaceId,
        sessionId,
        lastSeenId,
        opts.signal,
      );
    }
    const source = this.broadcaster.subscribe(workspaceId, sessionId, {
      lastSeenId,
      signal: opts.signal,
    });
    return (async function* () {
      for await (const event of source) {
        yield toManagedAgentsEvent(event);
      }
    })();
  }

  private replayClosedSession(
    workspaceId: WorkspaceId,
    sessionId: string,
    lastSeenId: string | undefined,
    signal: AbortSignal | undefined,
  ): AsyncIterable<ManagedAgentsEvent> {
    const events = this.events;
    return (async function* () {
      let cursor = lastSeenId;
      while (!(signal?.aborted ?? false)) {
        const rows = events.list(workspaceId, sessionId, {
          afterId: cursor,
          limit: 500,
        });
        if (rows.length === 0) return;
        for (const row of rows) {
          if (signal?.aborted ?? false) return;
          cursor = row.id;
          yield toManagedAgentsEvent(row);
        }
        if (rows.length < 500) return;
      }
    })();
  }

  private resolveResumeCursor(
    workspaceId: WorkspaceId,
    sessionId: string,
    lastEventId: string | undefined,
  ): string | undefined {
    if (lastEventId === undefined || !lastEventId.startsWith("sevt_")) {
      return undefined;
    }
    const cursor = this.events.retrieve(workspaceId, lastEventId);
    if (!cursor || cursor.session_id !== sessionId) {
      return undefined;
    }
    return lastEventId;
  }

  private maybeRunRuntimeFromUserMessages(
    workspaceId: WorkspaceId,
    sessionId: string,
    prompts: readonly RuntimePrompt[],
    signal: AbortSignal | undefined,
  ): void {
    if (!this.runtimeRunner || !this.runtimeTranslator) return;
    if (prompts.length === 0) return;

    this.beginRuntimeTask(workspaceId, sessionId);
    void this.runRuntimePrompts(workspaceId, sessionId, prompts, signal)
      .finally(() => {
        this.finishRuntimeTask(workspaceId, sessionId);
      });
  }

  private beginRuntimeTask(workspaceId: WorkspaceId, sessionId: string): void {
    const key = sessionScopeKey(workspaceId, sessionId);
    this.activeRuntimeTasks.set(
      key,
      (this.activeRuntimeTasks.get(key) ?? 0) + 1,
    );
  }

  private finishRuntimeTask(workspaceId: WorkspaceId, sessionId: string): void {
    const key = sessionScopeKey(workspaceId, sessionId);
    const remaining = (this.activeRuntimeTasks.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.activeRuntimeTasks.set(key, remaining);
      return;
    }
    this.activeRuntimeTasks.delete(key);
    this.interruptedCustomToolActions.delete(key);
    this.interruptedToolConfirmations.delete(key);
    this.retireLifecycleGuardsIfIdle(workspaceId, sessionId);
  }

  private retireLifecycleGuardsIfIdle(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): void {
    const key = sessionScopeKey(workspaceId, sessionId);
    if ((this.activeRuntimeTasks.get(key) ?? 0) > 0) return;
    this.closedSessions.delete(key);
    this.deletedSessions.delete(key);
  }

  private activeRuntimeTaskCount(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): number {
    return this.activeRuntimeTasks.get(sessionScopeKey(workspaceId, sessionId)) ?? 0;
  }

  private async runRuntimePrompts(
    workspaceId: WorkspaceId,
    sessionId: string,
    prompts: readonly RuntimePrompt[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!this.runtimeRunner || !this.runtimeTranslator) return;
    let activePrompt: RuntimePrompt | undefined;
    let activeOpenModelRequestStartIds: string[] = [];
    try {
      for (const prompt of prompts) {
        activePrompt = prompt;
        activeOpenModelRequestStartIds = [];
        const stopRenewing = this.startRuntimeLeaseRenewal(
          workspaceId,
          sessionId,
          prompt,
        );
        try {
          this.markRuntimeTurnState(
            workspaceId,
            sessionId,
            prompt.turnId,
            prompt.ownerId,
            prompt.ownerGeneration,
            "dispatching",
          );
          const source = this.runtimeRunner.runUserMessage(
            workspaceId,
            sessionId,
            prompt.text,
            { signal },
          );
          for await (const piEvent of source) {
            if (isRuntimeCustomToolUseEvent(piEvent)) {
              this.persistCustomToolUse(
                workspaceId,
                sessionId,
                prompt.turnId,
                prompt.ownerId,
                prompt.ownerGeneration,
                piEvent,
              );
              continue;
            }
            if (isRuntimeToolPermissionUseEvent(piEvent)) {
              this.persistToolPermissionUse(
                workspaceId,
                sessionId,
                prompt.turnId,
                prompt.ownerId,
                prompt.ownerGeneration,
                piEvent,
              );
              continue;
            }
            if (isRuntimeToolPermissionWithModelEndEvent(piEvent)) {
              const closingModelRequestStartId =
                activeOpenModelRequestStartIds[
                  activeOpenModelRequestStartIds.length - 1
                ];
              const closedModelRequestStartId =
                this.persistToolPermissionUseWithModelEnd(
                  workspaceId,
                  sessionId,
                  prompt.turnId,
                  prompt.ownerId,
                  prompt.ownerGeneration,
                  piEvent,
                  closingModelRequestStartId,
                );
              if (closedModelRequestStartId !== undefined) {
                activeOpenModelRequestStartIds.pop();
              }
              continue;
            }
            if (isRuntimeMcpToolUseEvent(piEvent)) {
              this.persistMcpToolUse(
                workspaceId,
                sessionId,
                prompt.turnId,
                prompt.ownerId,
                prompt.ownerGeneration,
                piEvent,
              );
              continue;
            }
            if (isRuntimeMcpToolWithModelEndEvent(piEvent)) {
              const closingModelRequestStartId =
                activeOpenModelRequestStartIds[
                  activeOpenModelRequestStartIds.length - 1
                ];
              const closedModelRequestStartId =
                this.persistMcpToolUseWithModelEnd(
                  workspaceId,
                  sessionId,
                  prompt.turnId,
                  prompt.ownerId,
                  prompt.ownerGeneration,
                  piEvent,
                  closingModelRequestStartId,
                );
              if (closedModelRequestStartId !== undefined) {
                activeOpenModelRequestStartIds.pop();
              }
              continue;
            }
            if (isRuntimeMcpToolResultEvent(piEvent)) {
              this.persistMcpToolResult(
                workspaceId,
                sessionId,
                prompt.turnId,
                prompt.ownerId,
                prompt.ownerGeneration,
                piEvent,
              );
              continue;
            }
            if (isRuntimeMcpConnectionFailedEvent(piEvent)) {
              this.persistMcpConnectionFailed(
                workspaceId,
                sessionId,
                prompt.turnId,
                prompt.ownerId,
                prompt.ownerGeneration,
                piEvent,
              );
              continue;
            }
            const spanStartDrafts = spanModelRequestStartDraft(piEvent);
            const transcriptDrafts = this.runtimeTranslator(piEvent, {
              customToolNames: this.runtimeRunner.customToolNames?.(
                workspaceId,
                sessionId,
              ),
              publicToolUseIdForPiToolCallId: (piToolCallId) =>
                this.runtimeRunner?.publicToolUseIdForPiToolCallId?.(
                  workspaceId,
                  sessionId,
                  piToolCallId,
                ),
              suppressPiToolUse: (piToolCallId) =>
                this.runtimeRunner?.suppressPiToolUse?.(
                  workspaceId,
                  sessionId,
                  piToolCallId,
                ) === true,
            });
            const closingModelRequestStartId =
              activeOpenModelRequestStartIds[
                activeOpenModelRequestStartIds.length - 1
              ];
            const spanEndDrafts = spanModelRequestEndDraft(
              piEvent,
              closingModelRequestStartId,
            );
            const drafts = [
              ...spanStartDrafts,
              ...transcriptDrafts,
              ...spanEndDrafts,
            ];
            if (drafts.length === 0) continue;
            if (this.closedSessions.has(sessionScopeKey(workspaceId, sessionId))) return;
            if (this.deletedSessions.has(sessionScopeKey(workspaceId, sessionId))) return;
            const now = new Date().toISOString();
            const rows = materializePersistedEvents(
              workspaceId,
              sessionId,
              drafts,
              now,
            );
            if (spanStartDrafts.length > 1) {
              throw new Error("Expected at most one model request start draft");
            }
            const openedModelRequestStartId =
              spanStartDrafts.length > 0 ? rows[0]?.id : undefined;
            // First coordinator slice: fence the general translated runtime
            // transcript path. Custom tool, tool-permission, renewal, and
            // error-cleanup paths still use their existing store-level owner
            // checks; track the remaining seam audit in GitHub issue #113.
            this.runtimeEventCoordinator!.commitRuntimeEventsForTurn({
              workspaceId,
              sessionId,
              turnId: prompt.turnId,
              ownerId: prompt.ownerId,
              ownerGeneration: prompt.ownerGeneration,
              events: rows,
              changes: {
                openedModelRequestStarts:
                  openedModelRequestStartId === undefined
                    ? []
                    : [
                        {
                          workspaceId,
                          sessionId,
                          turnId: prompt.turnId,
                          ownerId: prompt.ownerId,
                          ownerGeneration: prompt.ownerGeneration,
                          startEventId: openedModelRequestStartId,
                          now,
                        },
                      ],
                closedModelRequestStarts:
                  spanEndDrafts.length === 0 ||
                  closingModelRequestStartId === undefined
                    ? []
                    : [
                        {
                          workspaceId,
                          sessionId,
                          turnId: prompt.turnId,
                          ownerId: prompt.ownerId,
                          ownerGeneration: prompt.ownerGeneration,
                          startEventId: closingModelRequestStartId,
                          now,
                        },
                      ],
                turnStates: [
                  {
                    workspaceId,
                    sessionId,
                    turnId: prompt.turnId,
                    ownerId: prompt.ownerId,
                    ownerGeneration: prompt.ownerGeneration,
                    leaseExpiresAt: leaseExpiresAt(now, this.leaseTtlMs),
                    state: "running",
                    now,
                  },
                ],
              },
            });
            this.broadcaster.publishPersisted(rows);
            if (openedModelRequestStartId !== undefined) {
              activeOpenModelRequestStartIds.push(openedModelRequestStartId);
            }
            if (
              spanEndDrafts.length > 0 &&
              closingModelRequestStartId !== undefined
            ) {
              activeOpenModelRequestStartIds.pop();
            }
            if (hasTerminalIdleDraft(drafts)) {
              await this.indexSessionOutputsFromLiveRuntime(
                workspaceId,
                sessionId,
                prompt,
              );
            }
          }
          this.closeRuntimeTurnWithSyntheticSpanEnds(
            workspaceId,
            sessionId,
            prompt,
            activeOpenModelRequestStartIds,
            "completed",
            "completed",
          );
        } finally {
          stopRenewing();
        }
        activePrompt = undefined;
        activeOpenModelRequestStartIds = [];
      }
    } catch (error) {
      if (error instanceof RuntimeTurnOwnershipLostError) {
        log.debug("runtime_turn_ownership_lost", {
          workspaceId,
          sessionId,
          turnId: error.turnId,
        });
        void Promise.resolve(
          this.runtimeRunner?.interruptSession?.(workspaceId, sessionId),
        ).catch((interruptError) => {
          log.error("runtime_ownership_loss_interrupt_failed", {
            sessionId,
            error: interruptError,
          });
        });
        return;
      }
      log.error("runtime_ingestion_failed", { sessionId, error });
      if (activePrompt) {
        const now = new Date().toISOString();
        const runtimeChanges: EventStoreRuntimeChanges = {
          closedTurns: [
            {
              workspaceId,
              sessionId,
              turnId: activePrompt.turnId,
              reason: "terminalized",
              state: "terminalized",
              now,
            },
          ],
        };
        if (
          !this.closedSessions.has(sessionScopeKey(workspaceId, sessionId)) &&
          !this.deletedSessions.has(sessionScopeKey(workspaceId, sessionId))
        ) {
          runtimeChanges.closedTurns = [
            {
              workspaceId,
              sessionId,
              turnId: activePrompt.turnId,
              ownerId: activePrompt.ownerId,
              ownerGeneration: activePrompt.ownerGeneration,
              reason: "terminalized",
              state: "terminalized",
              now,
            },
          ];
        }
        if (
          this.closedSessions.has(sessionScopeKey(workspaceId, sessionId)) ||
          this.deletedSessions.has(sessionScopeKey(workspaceId, sessionId))
        ) {
          this.events.appendBatchWithRuntimeChanges([], runtimeChanges);
          return;
        }
        const rows = materializePersistedEvents(
          workspaceId,
          sessionId,
          [
            ...syntheticSpanModelRequestEndDrafts(
              activeOpenModelRequestStartIds,
            ),
            runtimeErrorDraft(error),
            {
              type: "session.status_idle",
              payload: { stop_reason: { type: "end_turn" } },
            },
          ],
          now,
        );
        persistRuntimeChangesAndPublish(
          this.events,
          this.broadcaster,
          rows,
          runtimeChanges,
        );
        return;
      }
      this.persistRuntimeDrafts(workspaceId, sessionId, [runtimeErrorDraft(error)]);
    }
  }

  private persistRuntimeDrafts(
    workspaceId: WorkspaceId,
    sessionId: string,
    drafts: readonly EventDraft[],
  ): void {
    if (this.closedSessions.has(sessionScopeKey(workspaceId, sessionId))) return;
    if (this.deletedSessions.has(sessionScopeKey(workspaceId, sessionId))) return;
    this.persistLifecycleDrafts(workspaceId, sessionId, drafts);
  }

  private async indexSessionOutputsFromLiveRuntime(
    workspaceId: WorkspaceId,
    sessionId: string,
    prompt: RuntimePrompt,
  ): Promise<void> {
    if (
      !this.sessionOutputCoordinator ||
      !this.runtimeRunner?.collectSessionOutputs
    ) {
      return;
    }
    try {
      const collection = await this.runtimeRunner.collectSessionOutputs(
        workspaceId,
        sessionId,
      );
      if (collection.kind !== "collected") return;
      if (collection.files.length === 0) return;
      if (
        // Cheap process-local early-out. The coordinator is still the
        // authoritative check at metadata commit time.
        !this.canCommitSessionOutputsFromRuntimeTurn(
          workspaceId,
          sessionId,
          prompt,
        )
      ) {
        return;
      }
      const files = collection.files.map((file) => ({
        relativePath: file.relativePath,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        body: file.bytes,
      }));
      await this.sessionOutputCoordinator.replaceSessionOutputsForRuntimeTurn({
        workspaceId,
        sessionId,
        turnId: prompt.turnId,
        ownerId: prompt.ownerId,
        ownerGeneration: prompt.ownerGeneration,
        files,
      });
    } catch (error) {
      log.warn("session_output_indexing_failed", {
        workspaceId,
        sessionId,
        error,
      });
    }
  }

  private canCommitSessionOutputsFromRuntimeTurn(
    workspaceId: WorkspaceId,
    sessionId: string,
    prompt: RuntimePrompt,
  ): boolean {
    const key = sessionScopeKey(workspaceId, sessionId);
    if (this.closedSessions.has(key) || this.deletedSessions.has(key)) return false;
    const turn = this.events
      .listPendingRuntimeTurns(workspaceId)
      .find(
        (candidate) =>
          candidate.session_id === sessionId &&
          candidate.turn_id === prompt.turnId,
      );
    return (
      turn !== undefined &&
      turn.owner_id === prompt.ownerId &&
      turn.owner_generation === prompt.ownerGeneration
    );
  }

  private startRuntimeLeaseRenewal(
    workspaceId: WorkspaceId,
    sessionId: string,
    prompt: RuntimePrompt,
  ): () => void {
    const intervalMs = Math.max(10, Math.min(30_000, Math.floor(this.leaseTtlMs / 2)));
    const timer = setInterval(() => {
      const now = new Date().toISOString();
      try {
        this.events.appendBatchWithRuntimeChanges([], {
          leaseRenewals: [
            {
              workspaceId,
              sessionId,
              turnId: prompt.turnId,
              ownerId: prompt.ownerId,
              ownerGeneration: prompt.ownerGeneration,
              leaseExpiresAt: leaseExpiresAt(now, this.leaseTtlMs),
              now,
            },
          ],
        });
      } catch (error) {
        if (error instanceof RuntimeTurnOwnershipLostError) {
          log.debug("runtime_lease_renewal_ownership_lost", {
            workspaceId,
            sessionId,
            turnId: error.turnId,
          });
        } else {
          log.error("runtime_lease_renewal_failed", { sessionId, error });
        }
        clearInterval(timer);
      }
    }, intervalMs);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }

  private markRuntimeTurnState(
    workspaceId: WorkspaceId,
    sessionId: string,
    turnId: string,
    ownerId: string,
    ownerGeneration: number,
    state: "dispatching" | "running" | "paused",
  ): void {
    const now = new Date().toISOString();
    this.events.appendBatchWithRuntimeChanges([], {
      turnStates: [
        {
          workspaceId,
          sessionId,
          turnId,
          ownerId,
          ownerGeneration,
          leaseExpiresAt: leaseExpiresAt(now, this.leaseTtlMs),
          state,
          now,
        },
      ],
    });
  }

  private closeRuntimeTurn(
    workspaceId: WorkspaceId,
    sessionId: string,
    turnId: string,
    ownerId: string | undefined,
    ownerGeneration: number | undefined,
    state: "completed" | "terminalized",
    reason: "completed" | "terminalized" | "interrupted" | "archived" | "deleted",
  ): void {
    this.events.appendBatchWithRuntimeChanges([], {
      closedTurns: [
        {
          workspaceId,
          sessionId,
          turnId,
          ownerId,
          ownerGeneration,
          reason,
          state,
          now: new Date().toISOString(),
        },
      ],
    });
  }

  private closeRuntimeTurnWithSyntheticSpanEnds(
    workspaceId: WorkspaceId,
    sessionId: string,
    prompt: RuntimePrompt,
    openModelRequestStartIds: readonly string[],
    state: "completed" | "terminalized",
    reason: "completed" | "terminalized" | "interrupted" | "archived" | "deleted",
  ): void {
    if (openModelRequestStartIds.length === 0) {
      this.closeRuntimeTurn(
        workspaceId,
        sessionId,
        prompt.turnId,
        prompt.ownerId,
        prompt.ownerGeneration,
        state,
        reason,
      );
      return;
    }

    const now = new Date().toISOString();
    const rows = materializePersistedEvents(
      workspaceId,
      sessionId,
      syntheticSpanModelRequestEndDrafts(openModelRequestStartIds),
      now,
    );
    // This is a defensive cleanup path for an impossible or provider-buggy
    // stream shape. If it runs on clean completion, the synthetic end may land
    // after status_idle; preserving closure is more important than timeline
    // aesthetics for this fallback.
    persistRuntimeChangesAndPublish(this.events, this.broadcaster, rows, {
      closedTurns: [
        {
          workspaceId,
          sessionId,
          turnId: prompt.turnId,
          ownerId: prompt.ownerId,
          ownerGeneration: prompt.ownerGeneration,
          reason,
          state,
          now,
        },
      ],
    });
  }

  private closeReleasedRuntimeAction(
    workspaceId: WorkspaceId,
    sessionId: string,
    actionId: string,
    reason: PendingRuntimeActionRecord["close_reason"],
  ): void {
    if (reason === null) return;
    this.events.appendBatchWithRuntimeChanges([], {
      closedActions: [
        {
          workspaceId,
          sessionId,
          actionId,
          reason,
          now: new Date().toISOString(),
        },
      ],
    });
  }

  private persistLifecycleDrafts(
    workspaceId: WorkspaceId,
    sessionId: string,
    drafts: readonly EventDraft[],
  ): void {
    if (this.deletedSessions.has(sessionScopeKey(workspaceId, sessionId))) return;
    const now = new Date().toISOString();
    const rows = materializePersistedEvents(workspaceId, sessionId, drafts, now);
    persistAndPublish(this.events, this.broadcaster, rows);
  }

  private persistCustomToolUse(
    workspaceId: WorkspaceId,
    sessionId: string,
    turnId: string,
    ownerId: string,
    ownerGeneration: number,
    event: RuntimeCustomToolUseEvent,
  ): void {
    if (this.closedSessions.has(sessionScopeKey(workspaceId, sessionId))) return;
    if (this.deletedSessions.has(sessionScopeKey(workspaceId, sessionId))) return;
    try {
      const now = new Date().toISOString();
      const useRows = materializePersistedEvents(
        workspaceId,
        sessionId,
        [
          {
            type: "agent.custom_tool_use",
            payload: {
              name: event.name,
              input: event.input,
            },
          },
        ],
        now,
      );
      event.bindCustomToolUseId(useRows[0].id, (reason) => {
        if (reason !== undefined) {
          this.closeReleasedRuntimeAction(
            workspaceId,
            sessionId,
            useRows[0].id,
            reason,
          );
        }
        this.pendingCustomToolActions.remove(workspaceId, sessionId, useRows[0].id);
      });
      persistRuntimeChangesAndPublish(this.events, this.broadcaster, useRows, {
        openedActions: [
          {
            workspaceId,
            sessionId,
            turnId,
            actionId: useRows[0].id,
            actionType: "custom_tool",
            now,
          },
        ],
        turnStates: [
          {
            workspaceId,
            sessionId,
            turnId,
            ownerId,
            ownerGeneration,
            state: "paused",
            now,
          },
        ],
      });
      this.pendingCustomToolActions.add(workspaceId, sessionId, useRows[0].id);
    } catch (error) {
      event.rejectCustomToolUse(toError(error));
      throw error;
    }
  }

  private persistToolPermissionUse(
    workspaceId: WorkspaceId,
    sessionId: string,
    turnId: string,
    ownerId: string,
    ownerGeneration: number,
    event: RuntimeToolPermissionUseEvent,
  ): void {
    if (this.closedSessions.has(sessionScopeKey(workspaceId, sessionId))) return;
    if (this.deletedSessions.has(sessionScopeKey(workspaceId, sessionId))) return;
    try {
      const now = new Date().toISOString();
      const useRows = materializeToolPermissionUseRows({
        workspaceId,
        sessionId,
        event,
        now,
        onReleased: (toolUseId, reason) => {
          if (reason !== undefined) {
            this.closeReleasedRuntimeAction(workspaceId, sessionId, toolUseId, reason);
          }
          this.pendingToolConfirmations.remove(workspaceId, sessionId, toolUseId);
        },
      });
      persistRuntimeChangesAndPublish(this.events, this.broadcaster, useRows, {
        ...toolPermissionRuntimeChanges({
          workspaceId,
          sessionId,
          turnId,
          ownerId,
          ownerGeneration,
          evaluatedPermission: event.evaluatedPermission,
          toolUseId: useRows[0].id,
          now,
        }),
      });
      if (event.evaluatedPermission === "ask") {
        this.pendingToolConfirmations.add(workspaceId, sessionId, useRows[0].id);
      }
    } catch (error) {
      event.rejectToolUse(toError(error));
      throw error;
    }
  }

  private persistToolPermissionUseWithModelEnd(
    workspaceId: WorkspaceId,
    sessionId: string,
    turnId: string,
    ownerId: string,
    ownerGeneration: number,
    event: RuntimeToolPermissionWithModelEndEvent,
    closingModelRequestStartId: string | undefined,
  ): string | undefined {
    if (this.closedSessions.has(sessionScopeKey(workspaceId, sessionId))) {
      return undefined;
    }
    if (this.deletedSessions.has(sessionScopeKey(workspaceId, sessionId))) {
      return undefined;
    }
    const permission = event.permissionUse;
    try {
      const now = new Date().toISOString();
      const useRows = materializeToolPermissionUseRows({
        workspaceId,
        sessionId,
        event: permission,
        now,
        onReleased: (toolUseId, reason) => {
          if (reason !== undefined) {
            this.closeReleasedRuntimeAction(workspaceId, sessionId, toolUseId, reason);
          }
          this.pendingToolConfirmations.remove(workspaceId, sessionId, toolUseId);
        },
      });
      const suppressedPiToolCallIds = new Set([
        permission.piToolCallId,
        ...event.suppressedPiToolCallIds,
      ]);
      const transcriptDrafts = this.runtimeTranslator?.(event.messageEnd, {
        customToolNames: this.runtimeRunner?.customToolNames?.(
          workspaceId,
          sessionId,
        ),
        publicToolUseIdForPiToolCallId: (piToolCallId) =>
          this.runtimeRunner?.publicToolUseIdForPiToolCallId?.(
            workspaceId,
            sessionId,
            piToolCallId,
        ),
        suppressPiToolUse: (piToolCallId) =>
          suppressedPiToolCallIds.has(piToolCallId) ||
          this.runtimeRunner?.suppressPiToolUse?.(
            workspaceId,
            sessionId,
            piToolCallId,
          ) === true,
      }) ?? [];
      const spanEndDrafts = spanModelRequestEndDraft(
        event.messageEnd,
        closingModelRequestStartId,
      );
      const remainingRows = materializePersistedEvents(
        workspaceId,
        sessionId,
        [...transcriptDrafts, ...spanEndDrafts],
        now,
      );
      persistRuntimeChangesAndPublish(
        this.events,
        this.broadcaster,
        [...useRows, ...remainingRows],
        {
          ...toolPermissionRuntimeChanges({
            workspaceId,
            sessionId,
            turnId,
            ownerId,
            ownerGeneration,
            evaluatedPermission: permission.evaluatedPermission,
            toolUseId: useRows[0].id,
            now,
          }),
          closedModelRequestStarts:
            spanEndDrafts.length === 0 ||
            closingModelRequestStartId === undefined
              ? []
              : [
                  {
                    workspaceId,
                    sessionId,
                    turnId,
                    ownerId,
                    ownerGeneration,
                    startEventId: closingModelRequestStartId,
                    now,
                  },
                ],
        },
      );
      if (permission.evaluatedPermission === "ask") {
        this.pendingToolConfirmations.add(workspaceId, sessionId, useRows[0].id);
      }
      return spanEndDrafts.length > 0 ? closingModelRequestStartId : undefined;
    } catch (error) {
      permission.rejectToolUse(toError(error));
      throw error;
    }
  }

  // ── MCP persistence (plan 0122 §4.4/§4.5) — mirrors the tool-permission
  // pair: sevt_* id bound on persist (before the tool executes), ask-path
  // opens a tool_confirmation action, allow-path continues running.

  private persistMcpToolUse(
    workspaceId: WorkspaceId,
    sessionId: string,
    turnId: string,
    ownerId: string,
    ownerGeneration: number,
    event: RuntimeMcpToolUseEvent,
  ): void {
    if (this.closedSessions.has(sessionScopeKey(workspaceId, sessionId))) return;
    if (this.deletedSessions.has(sessionScopeKey(workspaceId, sessionId))) return;
    try {
      const now = new Date().toISOString();
      const useRows = materializeMcpToolUseRows({
        workspaceId,
        sessionId,
        event,
        now,
        onReleased: (toolUseId, reason) => {
          if (reason !== undefined) {
            this.closeReleasedRuntimeAction(workspaceId, sessionId, toolUseId, reason);
          }
          this.pendingToolConfirmations.remove(workspaceId, sessionId, toolUseId);
        },
      });
      persistRuntimeChangesAndPublish(this.events, this.broadcaster, useRows, {
        ...toolPermissionRuntimeChanges({
          workspaceId,
          sessionId,
          turnId,
          ownerId,
          ownerGeneration,
          evaluatedPermission: event.evaluatedPermission,
          toolUseId: useRows[0].id,
          now,
        }),
      });
      if (event.evaluatedPermission === "ask") {
        this.pendingToolConfirmations.add(workspaceId, sessionId, useRows[0].id);
      }
    } catch (error) {
      event.rejectToolUse(toError(error));
      throw error;
    }
  }

  private persistMcpToolUseWithModelEnd(
    workspaceId: WorkspaceId,
    sessionId: string,
    turnId: string,
    ownerId: string,
    ownerGeneration: number,
    event: RuntimeMcpToolWithModelEndEvent,
    closingModelRequestStartId: string | undefined,
  ): string | undefined {
    if (this.closedSessions.has(sessionScopeKey(workspaceId, sessionId))) {
      return undefined;
    }
    if (this.deletedSessions.has(sessionScopeKey(workspaceId, sessionId))) {
      return undefined;
    }
    const mcpToolUse = event.mcpToolUse;
    try {
      const now = new Date().toISOString();
      const useRows = materializeMcpToolUseRows({
        workspaceId,
        sessionId,
        event: mcpToolUse,
        now,
        onReleased: (toolUseId, reason) => {
          if (reason !== undefined) {
            this.closeReleasedRuntimeAction(workspaceId, sessionId, toolUseId, reason);
          }
          this.pendingToolConfirmations.remove(workspaceId, sessionId, toolUseId);
        },
      });
      const suppressedPiToolCallIds = new Set([
        mcpToolUse.piToolCallId,
        ...event.suppressedPiToolCallIds,
      ]);
      const transcriptDrafts = this.runtimeTranslator?.(event.messageEnd, {
        customToolNames: this.runtimeRunner?.customToolNames?.(
          workspaceId,
          sessionId,
        ),
        publicToolUseIdForPiToolCallId: (piToolCallId) =>
          this.runtimeRunner?.publicToolUseIdForPiToolCallId?.(
            workspaceId,
            sessionId,
            piToolCallId,
          ),
        suppressPiToolUse: (piToolCallId) =>
          suppressedPiToolCallIds.has(piToolCallId) ||
          this.runtimeRunner?.suppressPiToolUse?.(
            workspaceId,
            sessionId,
            piToolCallId,
          ) === true,
      }) ?? [];
      const spanEndDrafts = spanModelRequestEndDraft(
        event.messageEnd,
        closingModelRequestStartId,
      );
      const remainingRows = materializePersistedEvents(
        workspaceId,
        sessionId,
        [...transcriptDrafts, ...spanEndDrafts],
        now,
      );
      persistRuntimeChangesAndPublish(
        this.events,
        this.broadcaster,
        [...useRows, ...remainingRows],
        {
          ...toolPermissionRuntimeChanges({
            workspaceId,
            sessionId,
            turnId,
            ownerId,
            ownerGeneration,
            evaluatedPermission: mcpToolUse.evaluatedPermission,
            toolUseId: useRows[0].id,
            now,
          }),
          closedModelRequestStarts:
            spanEndDrafts.length === 0 ||
            closingModelRequestStartId === undefined
              ? []
              : [
                  {
                    workspaceId,
                    sessionId,
                    turnId,
                    ownerId,
                    ownerGeneration,
                    startEventId: closingModelRequestStartId,
                    now,
                  },
                ],
        },
      );
      if (mcpToolUse.evaluatedPermission === "ask") {
        this.pendingToolConfirmations.add(workspaceId, sessionId, useRows[0].id);
      }
      return spanEndDrafts.length > 0 ? closingModelRequestStartId : undefined;
    } catch (error) {
      mcpToolUse.rejectToolUse(toError(error));
      throw error;
    }
  }

  /** Terminal result for a persisted agent.mcp_tool_use — no action state. */
  private persistMcpToolResult(
    workspaceId: WorkspaceId,
    sessionId: string,
    turnId: string,
    ownerId: string,
    ownerGeneration: number,
    event: RuntimeMcpToolResultEvent,
  ): void {
    if (this.closedSessions.has(sessionScopeKey(workspaceId, sessionId))) return;
    if (this.deletedSessions.has(sessionScopeKey(workspaceId, sessionId))) return;
    const now = new Date().toISOString();
    const rows = materializeMcpToolResultRows({
      workspaceId,
      sessionId,
      now,
      event,
    });
    persistRuntimeChangesAndPublish(this.events, this.broadcaster, rows, {
      turnStates: [
        {
          workspaceId,
          sessionId,
          turnId,
          ownerId,
          ownerGeneration,
          state: "running",
          now,
        },
      ],
    });
  }

  private persistMcpConnectionFailed(
    workspaceId: WorkspaceId,
    sessionId: string,
    turnId: string,
    ownerId: string,
    ownerGeneration: number,
    event: RuntimeMcpConnectionFailedEvent,
  ): void {
    if (this.closedSessions.has(sessionScopeKey(workspaceId, sessionId))) return;
    if (this.deletedSessions.has(sessionScopeKey(workspaceId, sessionId))) return;
    const now = new Date().toISOString();
    const rows = materializeMcpConnectionFailedRows({
      workspaceId,
      sessionId,
      now,
      event,
    });
    persistRuntimeChangesAndPublish(this.events, this.broadcaster, rows, {
      turnStates: [
        {
          workspaceId,
          sessionId,
          turnId,
          ownerId,
          ownerGeneration,
          state: "running",
          now,
        },
      ],
    });
  }

  private claimCustomToolResults(
    workspaceId: WorkspaceId,
    sessionId: string,
    events: SendSessionEventsRequest["events"],
  ): CustomToolResultClaim[] {
    this.rejectAmbiguousCustomToolResultDuplicates(events);
    const claims: CustomToolResultClaim[] = [];
    let interruptedInBatch = false;
    const runtimeResolvedInBatch = new Set<string>();
    for (const event of events) {
      if (event.type === "user.interrupt") {
        interruptedInBatch = true;
        continue;
      }
      if (event.type !== "user.custom_tool_result") continue;
      if (
        interruptedInBatch ||
        this.interruptedCustomToolActions
          .get(sessionScopeKey(workspaceId, sessionId))
          ?.has(event.custom_tool_use_id) === true
      ) {
        throw notFound(`No pending custom tool call: ${event.custom_tool_use_id}`);
      }
      if (runtimeResolvedInBatch.has(event.custom_tool_use_id)) {
        claims.push({
          kind: "duplicate",
          event,
          customToolUseId: event.custom_tool_use_id,
        });
        continue;
      }
      const action = this.events.findRuntimeAction(
        workspaceId,
        sessionId,
        event.custom_tool_use_id,
      );
      const prior = this.findPersistedCustomToolResult(
        workspaceId,
        sessionId,
        event,
      );
      if (actionClosedWithoutResult(action)) {
        throw notFound(`No pending custom tool call: ${event.custom_tool_use_id}`);
      }
      if (prior && action && isAcknowledgedInFlightAction(action)) {
        claims.push({
          kind: "duplicate",
          event,
          customToolUseId: event.custom_tool_use_id,
          row: prior,
        });
        continue;
      }
      if (prior && action && !isRuntimeTurnClosed(action.turn.state)) {
        if (
          action.turn.owner_id !== this.ownerId &&
          !isRuntimeLeaseExpired(action.turn.lease_expires_at)
        ) {
          throw runtimeTurnStillOwned(action.turn_id);
        }
        const claimed = this.claimTurnForTerminalization(action.turn);
        if (!claimed) {
          throw runtimeTurnStillOwned(action.turn_id);
        }
        claims.push({
          kind: "terminalize",
          event,
          customToolUseId: event.custom_tool_use_id,
          action: { ...action, turn: claimed },
        });
        continue;
      }
      if (prior) {
        claims.push({
          kind: "duplicate",
          event,
          customToolUseId: event.custom_tool_use_id,
        });
        continue;
      }
      if (
        action &&
        (action.turn.state === "completed" ||
          action.turn.state === "terminalized")
      ) {
        throw invalidRequest(
          `Custom tool result ${event.custom_tool_use_id} cannot be accepted because the runtime turn is already ${action.turn.state}`,
        );
      }
      const commit = this.runtimeRunner?.claimCustomToolResult?.(
        workspaceId,
        sessionId,
        event,
      );
      if (!commit && this.runtimeRunner?.claimCustomToolResult) {
        if (action) {
          if (
            action.turn.owner_id !== this.ownerId &&
            !isRuntimeLeaseExpired(action.turn.lease_expires_at)
          ) {
            throw runtimeTurnStillOwned(action.turn_id);
          }
          const claimed = this.claimTurnForTerminalization(action.turn);
          if (!claimed) {
            throw runtimeTurnStillOwned(action.turn_id);
          }
          claims.push({
            kind: "terminalize",
            event,
            customToolUseId: event.custom_tool_use_id,
            action: { ...action, turn: claimed },
          });
          continue;
        }
        throw notFound(`No pending custom tool call: ${event.custom_tool_use_id}`);
      }
      if (commit) {
        runtimeResolvedInBatch.add(event.custom_tool_use_id);
        claims.push({
          kind: "live",
          event,
          customToolUseId: event.custom_tool_use_id,
          commit,
          action,
        });
      }
    }
    return claims;
  }

  private rejectAmbiguousCustomToolResultDuplicates(
    events: SendSessionEventsRequest["events"],
  ): void {
    const seen = new Map<string, ManagedAgentsUserCustomToolResultEventInput>();
    for (const event of events) {
      if (event.type !== "user.custom_tool_result") continue;
      const existing = seen.get(event.custom_tool_use_id);
      if (!existing) {
        seen.set(event.custom_tool_use_id, event);
        continue;
      }
      if (sameCustomToolResult(existing, event)) continue;
      throw invalidRequest(
        `Custom tool result ${event.custom_tool_use_id} was already accepted with different content`,
      );
    }
  }

  private findPersistedCustomToolResult(
    workspaceId: WorkspaceId,
    sessionId: string,
    event: ManagedAgentsUserCustomToolResultEventInput,
  ): PersistedSessionEvent | undefined {
    const rows = this.listCustomToolHistory(workspaceId, sessionId);
    const row = rows.find(
      (candidate) =>
        candidate.type === "user.custom_tool_result" &&
        candidate.payload.custom_tool_use_id === event.custom_tool_use_id,
    );
    if (!row) return undefined;
    if (!sameCustomToolResultPayload(row.payload, event)) {
      throw invalidRequest(
        `Custom tool result ${event.custom_tool_use_id} was already accepted with different content`,
      );
    }
    return row;
  }

  private listCustomToolHistory(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): PersistedSessionEvent[] {
    const rows: PersistedSessionEvent[] = [];
    let page: string | undefined;
    do {
      const result = this.events.listPage(workspaceId, sessionId, {
        order: "asc",
        limit: 1000,
        page,
        types: ["user.custom_tool_result"],
      });
      rows.push(...result.data);
      page = result.next_page ?? undefined;
    } while (page !== undefined);
    return rows;
  }

  private claimToolConfirmations(
    workspaceId: WorkspaceId,
    sessionId: string,
    events: SendSessionEventsRequest["events"],
  ): Array<ToolConfirmationCommit | ToolConfirmationReplay | ToolConfirmationTerminalize> {
    const claims: Array<
      ToolConfirmationCommit | ToolConfirmationReplay | ToolConfirmationTerminalize
    > = [];
    let interruptedInBatch = false;
    const seenToolUseIds = new Set<string>();
    for (const event of events) {
      if (event.type === "user.interrupt") {
        interruptedInBatch = true;
        continue;
      }
      if (event.type !== "user.tool_confirmation") continue;
      if (seenToolUseIds.has(event.tool_use_id)) {
        throw invalidRequest(
          `\`events\` cannot contain duplicate user.tool_confirmation for ${event.tool_use_id}`,
        );
      }
      seenToolUseIds.add(event.tool_use_id);
      if (
        interruptedInBatch ||
        this.interruptedToolConfirmations
          .get(sessionScopeKey(workspaceId, sessionId))
          ?.has(event.tool_use_id) === true
      ) {
        throw notFound(`No pending tool confirmation: ${event.tool_use_id}`);
      }
      const completed = this.completedToolConfirmations.get(event.tool_use_id);
      const persisted = this.findPersistedToolConfirmation(
        workspaceId,
        sessionId,
        event,
      );
      const action = this.events.findRuntimeAction(
        workspaceId,
        sessionId,
        event.tool_use_id,
      );
      if (actionClosedWithoutResult(action)) {
        throw notFound(`No pending tool confirmation: ${event.tool_use_id}`);
      }
      const durableCompleted =
        completed ?? persisted?.completed;
      if (durableCompleted) {
        if (
          durableCompleted.workspaceId !== workspaceId ||
          durableCompleted.sessionId !== sessionId
        ) {
          throw notFound(`No pending tool confirmation: ${event.tool_use_id}`);
        }
        if (!sameToolConfirmation(durableCompleted, event)) {
          throw invalidRequest(
            `Tool confirmation ${event.tool_use_id} was already processed with a different result`,
          );
        }
        claims.push({ event, row: durableCompleted.row });
        continue;
      }
      if (persisted?.row && action && isAcknowledgedInFlightAction(action)) {
        claims.push({ event, row: persisted.row });
        continue;
      }
      const commit = this.runtimeRunner?.claimToolConfirmation?.(
        workspaceId,
        sessionId,
        event,
      );
      if (!commit) {
        if (action && !isRuntimeTurnClosed(action.turn.state)) {
          if (
            action.turn.owner_id !== this.ownerId &&
            !isRuntimeLeaseExpired(action.turn.lease_expires_at)
          ) {
            throw runtimeTurnStillOwned(action.turn_id);
          }
          const claimed = this.claimTurnForTerminalization(action.turn);
          if (!claimed) {
            throw runtimeTurnStillOwned(action.turn_id);
          }
          claims.push({
            event,
            toolUseId: event.tool_use_id,
            action: { ...action, turn: claimed },
            ...(persisted?.row === undefined ? {} : { row: persisted.row }),
          });
          continue;
        }
        if (persisted?.row) {
          this.terminalizeLostToolConfirmation(
            workspaceId,
            sessionId,
            event.tool_use_id,
          );
          claims.push({ event, row: persisted.row });
          continue;
        }
        if (action) {
          if (
            action.turn.owner_id !== this.ownerId &&
            !isRuntimeLeaseExpired(action.turn.lease_expires_at)
          ) {
            throw runtimeTurnStillOwned(action.turn_id);
          }
          const claimed = this.claimTurnForTerminalization(action.turn);
          if (!claimed) {
            throw runtimeTurnStillOwned(action.turn_id);
          }
          claims.push({
            event,
            toolUseId: event.tool_use_id,
            action,
          });
          continue;
        }
        throw notFound(`No pending tool confirmation: ${event.tool_use_id}`);
      }
      claims.push({
        event,
        toolUseId: event.tool_use_id,
        commit,
        ...(persisted?.row === undefined ? {} : { row: persisted.row }),
      });
    }
    return claims;
  }

  private findPersistedToolConfirmation(
    workspaceId: WorkspaceId,
    sessionId: string,
    event: ManagedAgentsUserToolConfirmationEventInput,
  ):
    | {
        row: PersistedSessionEvent;
        completed?: {
          workspaceId: WorkspaceId;
          sessionId: string;
          result: "allow" | "deny";
          denyMessage?: string | null;
          row: PersistedSessionEvent;
        };
      }
    | undefined {
    const rows = this.listToolConfirmationHistory(workspaceId, sessionId);
    const row = rows.find(
      (candidate) =>
        candidate.type === "user.tool_confirmation" &&
        candidate.payload.tool_use_id === event.tool_use_id,
    );
    if (!row) return undefined;
    const result = row.payload.result;
    if (result !== "allow" && result !== "deny") return undefined;
    const denyMessage = row.payload.deny_message;
    const accepted: {
      result: "allow" | "deny";
      denyMessage?: string | null;
    } = {
      result,
      denyMessage:
        denyMessage === null || typeof denyMessage === "string"
          ? denyMessage
          : undefined,
    };
    if (!sameToolConfirmation(accepted, event)) {
      throw invalidRequest(
        `Tool confirmation ${event.tool_use_id} was already accepted with a different result`,
      );
    }
    if (!hasToolResultForToolUseId(rows, event.tool_use_id)) {
      return { row };
    }
    return {
      row,
      completed: {
        workspaceId,
        sessionId,
        result,
        denyMessage: accepted.denyMessage,
        row,
      },
    };
  }

  private terminalizeLostToolConfirmation(
    workspaceId: WorkspaceId,
    sessionId: string,
    toolUseId: string,
  ): void {
    this.persistRuntimeDrafts(workspaceId, sessionId, [
      this.lostToolConfirmationResultDraft(workspaceId, sessionId, toolUseId),
      {
        type: "session.status_idle",
        payload: { stop_reason: { type: "end_turn" } },
      },
    ]);
  }

  /**
   * The lost-runtime terminal result must match the use event's family:
   * agent.mcp_tool_use gets agent.mcp_tool_result (terminal-result rule,
   * plan 0122 §4.4), builtin gets agent.tool_result. Rare recovery path —
   * the paged scan is acceptable.
   */
  private lostToolConfirmationResultDraft(
    workspaceId: WorkspaceId,
    sessionId: string,
    toolUseId: string,
  ): EventDraft {
    if (this.isMcpToolUseEventId(workspaceId, sessionId, toolUseId)) {
      return {
        type: "agent.mcp_tool_result",
        payload: lostMcpToolConfirmationPayload(toolUseId),
      };
    }
    return {
      type: "agent.tool_result",
      payload: lostToolConfirmationPayload(toolUseId),
    };
  }

  private isMcpToolUseEventId(
    workspaceId: WorkspaceId,
    sessionId: string,
    toolUseId: string,
  ): boolean {
    let page: string | undefined;
    do {
      const result = this.events.listPage(workspaceId, sessionId, {
        order: "asc",
        limit: 1000,
        page,
        types: ["agent.mcp_tool_use"],
      });
      if (result.data.some((row) => row.id === toolUseId)) return true;
      page = result.next_page ?? undefined;
    } while (page !== undefined);
    return false;
  }

  private listToolConfirmationHistory(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): PersistedSessionEvent[] {
    const rows: PersistedSessionEvent[] = [];
    let page: string | undefined;
    do {
      const result = this.events.listPage(workspaceId, sessionId, {
        order: "asc",
        limit: 1000,
        page,
        types: [
          "user.tool_confirmation",
          "agent.tool_result",
          "agent.mcp_tool_result",
        ],
      });
      rows.push(...result.data);
      page = result.next_page ?? undefined;
    } while (page !== undefined);
    return rows;
  }

  private clearCompletedToolConfirmations(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): void {
    for (const [id, completed] of this.completedToolConfirmations) {
      if (
        completed.workspaceId === workspaceId &&
        completed.sessionId === sessionId
      ) {
        this.completedToolConfirmations.delete(id);
      }
    }
  }

  private hasPendingRuntimeActions(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): boolean {
    return (
      this.pendingCustomToolActions.has(workspaceId, sessionId) ||
      this.pendingToolConfirmations.has(workspaceId, sessionId)
    );
  }

  private blockInterruptedCustomToolActions(
    workspaceId: WorkspaceId,
    sessionId: string,
    customToolUseIds: readonly string[],
  ): void {
    if (customToolUseIds.length === 0) return;
    const key = sessionScopeKey(workspaceId, sessionId);
    let blocked = this.interruptedCustomToolActions.get(key);
    if (!blocked) {
      blocked = new Set<string>();
      this.interruptedCustomToolActions.set(key, blocked);
    }
    for (const id of customToolUseIds) blocked.add(id);
  }

  private blockInterruptedToolConfirmations(
    workspaceId: WorkspaceId,
    sessionId: string,
    toolUseIds: readonly string[],
  ): void {
    if (toolUseIds.length === 0) return;
    const key = sessionScopeKey(workspaceId, sessionId);
    let blocked = this.interruptedToolConfirmations.get(key);
    if (!blocked) {
      blocked = new Set<string>();
      this.interruptedToolConfirmations.set(key, blocked);
    }
    for (const id of toolUseIds) blocked.add(id);
  }

  private flushPendingActions(workspaceId: WorkspaceId, sessionId: string): void {
    // Coalesce both stores into ONE requires_action event (custom then
    // confirmations, preserving id order). drainForFlush clears each timer and
    // drops the entry when empty; a re-entrant flush is a safe no-op.
    const ids = [
      ...this.pendingCustomToolActions.drainForFlush(workspaceId, sessionId),
      ...this.pendingToolConfirmations.drainForFlush(workspaceId, sessionId),
    ];
    if (ids.length === 0) return;
    this.persistRuntimeDrafts(workspaceId, sessionId, [
      {
        type: "session.status_idle",
        payload: {
          stop_reason: {
            type: "requires_action",
            event_ids: ids,
          },
        },
      },
    ]);
  }
}
