import {
  type ManagedAgentsContentBlock,
  type ListSessionEventsResponse,
  type ManagedAgentsEvent,
  type ManagedAgentsUserEventInput,
  type SendSessionEventsRequest,
} from "../../types/events.ts";
import { ApiError, notFound, rateLimited, toApiErrorBody } from "../errors.ts";
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
  RuntimeConversationCheckpoint,
  RuntimeConversationSettledEvent,
  RuntimeEventRunner,
  RuntimeEventTranslator,
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
  sessionNotDeletable,
  sessionScopeKey,
} from "./session-guards.ts";
import { CustomToolActions, type CustomToolResultClaim } from "./custom-tool-actions.ts";
import type { ToolActionDeps } from "./tool-action-deps.ts";
import {
  ToolConfirmations,
  type ToolConfirmationCommit,
  type ToolConfirmationReplay,
  type ToolConfirmationTerminalize,
} from "./tool-confirmations.ts";
import {
  eventPayload,
  parseSendRequest,
  toSendResponseEvent,
} from "./request.ts";
import {
  isRuntimeConversationSettledEvent,
  hasTerminalIdleDraft,
  isRuntimeCustomToolUseEvent,
  isRuntimeMcpConnectionFailedEvent,
  isRuntimeMcpToolResultEvent,
  isRuntimeMcpToolUseEvent,
  isRuntimeMcpToolWithModelEndEvent,
  isRuntimeToolPermissionUseEvent,
  isRuntimeToolPermissionWithModelEndEvent,
  leaseExpiresAt,
  runtimeErrorDraft,
  runtimeLeaseRetryDelayMs,
  textFromContent,
  unique,
} from "./runtime-helpers.ts";

const POST_IDLE_SETTLE_TIMEOUT_MS = 10_000;

/** One live runtime task; postIdle = it published its terminal idle. */
interface RuntimeTaskHandle {
  postIdle: boolean;
}

interface RuntimePrompt {
  text: string;
  eventId: string;
  turnId: string;
  ownerId: string;
  ownerGeneration: number;
}

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
  private readonly customTools: CustomToolActions;
  private readonly toolConfirmations: ToolConfirmations;
  private readonly closedSessions = new Set<string>();
  private readonly deletedSessions = new Set<string>();
  private readonly activeRuntimeTasks = new Map<string, number>();
  // Sessions whose live runtime task has already published its terminal
  // session.status_idle and is only doing post-idle work (output collection,
  // turn close). A delete waits for these instead of rejecting them.
  // Per session: how many live runtime tasks are post-idle. A delete waits
  // only while every live task is post-idle; any genuinely running task means
  // the session is running and gets the 400 without waiting.
  private readonly postIdleRuntimeTasks = new Map<string, number>();
  private readonly runtimeSettledWaiters = new Map<string, Array<() => void>>();
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
    const toolActionDeps: ToolActionDeps = {
      events: this.events,
      broadcaster: this.broadcaster,
      runtimeRunner: this.runtimeRunner,
      runtimeTranslator: this.runtimeTranslator,
      ownerId: this.ownerId,
      closedSessions: this.closedSessions,
      deletedSessions: this.deletedSessions,
      claimTurnForTerminalization: (turn) => this.claimTurnForTerminalization(turn),
      closeReleasedRuntimeAction: (workspaceId, sessionId, actionId, reason) =>
        this.closeReleasedRuntimeAction(workspaceId, sessionId, actionId, reason),
      persistRuntimeDrafts: (workspaceId, sessionId, drafts) =>
        this.persistRuntimeDrafts(workspaceId, sessionId, drafts),
      flushPendingActions: (workspaceId, sessionId) =>
        this.flushPendingActions(workspaceId, sessionId),
    };
    this.customTools = new CustomToolActions(toolActionDeps);
    this.toolConfirmations = new ToolConfirmations(toolActionDeps);
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
    const customToolResultClaims = this.customTools.claimCustomToolResults(
      workspaceId,
      sessionId,
      req.events,
    );
    const toolConfirmationClaims = this.toolConfirmations.claimToolConfirmations(
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
    const terminalRows = this.customTools.customToolTerminalizationRows(
      workspaceId,
      sessionId,
      customToolResultClaims,
      now,
      runtimeChanges,
    );
    const toolConfirmationTerminalRows = this.toolConfirmations.toolConfirmationTerminalizationRows(
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
        this.customTools.pendingCustomToolActions.remove(workspaceId, sessionId, customToolUseId);
      }
      for (const { toolUseId } of committedToolConfirmations) {
        this.toolConfirmations.pendingToolConfirmations.remove(workspaceId, sessionId, toolUseId);
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
        this.toolConfirmations.completedToolConfirmations.set(claim.event.tool_use_id, {
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
    this.customTools.blockInterruptedCustomToolActions(
      workspaceId,
      sessionId,
      this.closeInterruptedRuntimeActions(
        workspaceId,
        sessionId,
        unique([
          ...this.customTools.pendingCustomToolActions.clear(workspaceId, sessionId),
          ...this.pendingRuntimeActionIds(workspaceId, sessionId, "custom_tool"),
        ]),
      ),
    );
    this.toolConfirmations.blockInterruptedToolConfirmations(
      workspaceId,
      sessionId,
      this.closeInterruptedRuntimeActions(
        workspaceId,
        sessionId,
        unique([
          ...this.toolConfirmations.pendingToolConfirmations.clear(workspaceId, sessionId),
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

  // A client that saw session.status_idle may delete while the runtime task is
  // still collecting outputs and closing the turn. Wait (bounded) for that
  // post-idle work to finish so assertSessionDeletable sees a settled session;
  // a genuinely running turn is not waited on and still gets the hosted 400.
  async waitForPostIdleRuntimeSettle(
    workspaceId: WorkspaceId,
    sessionId: string,
    timeoutMs = POST_IDLE_SETTLE_TIMEOUT_MS,
  ): Promise<void> {
    const key = sessionScopeKey(workspaceId, sessionId);
    if (!this.allRuntimeTasksPostIdle(key)) return;
    await new Promise<void>((resolve) => {
      // One cleanup for both outcomes: a timed-out waiter must not stay
      // registered while post-idle work is stalled, or retried deletes leak.
      const settle = () => {
        clearTimeout(timer);
        const waiters = this.runtimeSettledWaiters.get(key);
        const index = waiters?.indexOf(settle) ?? -1;
        if (index >= 0) waiters!.splice(index, 1);
        if (waiters?.length === 0) this.runtimeSettledWaiters.delete(key);
        resolve();
      };
      const timer = setTimeout(settle, timeoutMs);
      timer.unref?.();
      const waiters = this.runtimeSettledWaiters.get(key) ?? [];
      waiters.push(settle);
      this.runtimeSettledWaiters.set(key, waiters);
    });
  }

  // Preflight for DELETE /v1/sessions/:id. Hosted CMA rejects a delete while the
  // session is running with a 400 (probe 38); we reuse the same running-detection
  // as archive so a session whose runtime task is live but whose row status lags
  // is still blocked. Must run before any store mutation in the route.
  assertSessionDeletable(workspaceId: WorkspaceId, sessionId: string): void {
    const session = requireExistingSession(this.sessions, workspaceId, sessionId);
    if (session.archived_at !== null || session.status === "terminated") return;
    if (
      this.activeRuntimeTaskCount(workspaceId, sessionId) > 0 &&
      !this.hasPendingRuntimeActions(workspaceId, sessionId)
    ) {
      throw sessionNotDeletable();
    }
    if (session.status === "running" || session.status === "rescheduling") {
      throw sessionNotDeletable();
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
    this.customTools.pendingCustomToolActions.clear(workspaceId, sessionId);
    this.toolConfirmations.pendingToolConfirmations.clear(workspaceId, sessionId);
    this.toolConfirmations.clearCompletedToolConfirmations(workspaceId, sessionId);
    this.customTools.interruptedCustomToolActions.delete(sessionScopeKey(workspaceId, sessionId));
    this.toolConfirmations.interruptedToolConfirmations.delete(sessionScopeKey(workspaceId, sessionId));
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
    this.customTools.pendingCustomToolActions.clear(workspaceId, sessionId);
    this.toolConfirmations.pendingToolConfirmations.clear(workspaceId, sessionId);
    this.toolConfirmations.clearCompletedToolConfirmations(workspaceId, sessionId);
    this.customTools.interruptedCustomToolActions.delete(sessionScopeKey(workspaceId, sessionId));
    this.toolConfirmations.interruptedToolConfirmations.delete(sessionScopeKey(workspaceId, sessionId));
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
  /**
   * `takeOverPreviousOwners`: only for the single-node startup sweep. Every
   * pending turn owned by someone else then belongs to a previous process
   * that is gone, so it is recovered now instead of after its lease expires;
   * otherwise a message sent right after a restart would rebuild without the
   * unfinished-turn note (#273). Later recovery passes keep the lease fence.
   */
  recoverAllAbandonedRuntimeTurns(opts: { takeOverPreviousOwners?: boolean } = {}): void {
    for (const workspaceId of this.events.listWorkspaceIdsWithPendingRuntimeTurns()) {
      this.recoverAbandonedRuntimeTurns(workspaceId, opts.takeOverPreviousOwners === true);
    }
  }

  recoverAbandonedRuntimeTurns(workspaceId: WorkspaceId, takeOverPreviousOwners = false): void {
    const turns = this.events.listPendingRuntimeTurns(workspaceId);
    let nextRetryAt: number | undefined;
    for (const turn of turns) {
      if (this.closedSessions.has(sessionScopeKey(workspaceId, turn.session_id))) continue;
      if (this.deletedSessions.has(sessionScopeKey(workspaceId, turn.session_id))) continue;
      if (!this.isRecoverableSession(workspaceId, turn.session_id)) continue;
      if (this.activeRuntimeTaskCount(workspaceId, turn.session_id) > 0) continue;
      const takeOver =
        takeOverPreviousOwners && turn.owner_id !== this.ownerId ? turn.owner_id : undefined;
      const retryDelayMs =
        takeOver === undefined ? runtimeLeaseRetryDelayMs(turn.lease_expires_at) : 0;
      if (retryDelayMs > 0) {
        const retryAt = Date.now() + retryDelayMs;
        nextRetryAt =
          nextRetryAt === undefined ? retryAt : Math.min(nextRetryAt, retryAt);
        continue;
      }
      if (turn.state === "accepted") {
        const claimed = this.claimAcceptedTurn(turn, takeOver);
        if (!claimed) continue;
        const prompts = this.promptsFromAcceptedTurn(claimed);
        if (prompts.length === 0) {
          this.terminalizeAbandonedRuntimeTurn(
            claimed,
            "Accepted runtime turn has no recoverable trigger event.",
          );
          continue;
        }
        const task = this.beginRuntimeTask(workspaceId, claimed.session_id);
        void this.runRuntimePrompts(
          workspaceId,
          claimed.session_id,
          prompts,
          undefined,
          task,
        ).finally(() => {
          this.finishRuntimeTask(workspaceId, claimed.session_id, task);
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
        // The wait stays open: its answer is still recorded (then ends the
        // turn, as the Pi session is gone). Adopt it so that answer is not
        // refused until the previous process's lease expires.
        if (takeOver !== undefined) {
          const now = new Date().toISOString();
          this.events.adoptPausedRuntimeTurn({
            workspaceId,
            sessionId: turn.session_id,
            turnId: turn.turn_id,
            ownerId: this.ownerId,
            leaseExpiresAt: leaseExpiresAt(now, this.leaseTtlMs),
            now,
            takeOverOwnerId: takeOver,
          });
        }
        continue;
      }
      const claimed = this.claimTurnForTerminalization(turn, takeOver);
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

  private claimAcceptedTurn(
    turn: {
      workspace_id: WorkspaceId;
      session_id: string;
      turn_id: string;
    },
    takeOverOwnerId?: string,
  ) {
    const now = new Date().toISOString();
    return this.events.claimAcceptedRuntimeTurnForRecovery({
      workspaceId: turn.workspace_id,
      sessionId: turn.session_id,
      turnId: turn.turn_id,
      ownerId: this.ownerId,
      leaseExpiresAt: leaseExpiresAt(now, this.leaseTtlMs),
      now,
      ...(takeOverOwnerId === undefined ? {} : { takeOverOwnerId }),
    });
  }

  private claimTurnForTerminalization(
    turn: {
      workspace_id: WorkspaceId;
      session_id: string;
      turn_id: string;
    },
    takeOverOwnerId?: string,
  ) {
    const now = new Date().toISOString();
    return this.events.claimRuntimeTurnForTerminalization({
      workspaceId: turn.workspace_id,
      sessionId: turn.session_id,
      turnId: turn.turn_id,
      ownerId: this.ownerId,
      leaseExpiresAt: leaseExpiresAt(now, this.leaseTtlMs),
      now,
      ...(takeOverOwnerId === undefined ? {} : { takeOverOwnerId }),
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

    const task = this.beginRuntimeTask(workspaceId, sessionId);
    void this.runRuntimePrompts(workspaceId, sessionId, prompts, signal, task)
      .finally(() => {
        this.finishRuntimeTask(workspaceId, sessionId, task);
      });
  }

  private beginRuntimeTask(workspaceId: WorkspaceId, sessionId: string): RuntimeTaskHandle {
    const key = sessionScopeKey(workspaceId, sessionId);
    this.activeRuntimeTasks.set(
      key,
      (this.activeRuntimeTasks.get(key) ?? 0) + 1,
    );
    return { postIdle: false };
  }

  private finishRuntimeTask(
    workspaceId: WorkspaceId,
    sessionId: string,
    task: RuntimeTaskHandle,
  ): void {
    const key = sessionScopeKey(workspaceId, sessionId);
    // Both counts drop in the same synchronous step, so a woken delete never
    // observes this task as still active.
    if (task.postIdle) this.adjustPostIdleRuntimeTasks(key, -1);
    const remaining = (this.activeRuntimeTasks.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.activeRuntimeTasks.set(key, remaining);
      this.wakeSettleWaitersUnlessAllPostIdle(key);
      return;
    }
    this.activeRuntimeTasks.delete(key);
    this.wakeSettleWaitersUnlessAllPostIdle(key);
    this.customTools.interruptedCustomToolActions.delete(key);
    this.toolConfirmations.interruptedToolConfirmations.delete(key);
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

  private setRuntimeTaskPostIdle(
    workspaceId: WorkspaceId,
    sessionId: string,
    task: RuntimeTaskHandle,
    postIdle: boolean,
  ): void {
    if (task.postIdle === postIdle) return;
    task.postIdle = postIdle;
    const key = sessionScopeKey(workspaceId, sessionId);
    this.adjustPostIdleRuntimeTasks(key, postIdle ? 1 : -1);
    if (!postIdle) this.wakeSettleWaitersUnlessAllPostIdle(key);
  }

  private adjustPostIdleRuntimeTasks(key: string, delta: number): void {
    const next = (this.postIdleRuntimeTasks.get(key) ?? 0) + delta;
    if (next > 0) this.postIdleRuntimeTasks.set(key, next);
    else this.postIdleRuntimeTasks.delete(key);
  }

  private allRuntimeTasksPostIdle(key: string): boolean {
    const active = this.activeRuntimeTasks.get(key) ?? 0;
    return active > 0 && (this.postIdleRuntimeTasks.get(key) ?? 0) === active;
  }

  private wakeSettleWaitersUnlessAllPostIdle(key: string): void {
    if (this.allRuntimeTasksPostIdle(key)) return;
    for (const settle of [...(this.runtimeSettledWaiters.get(key) ?? [])]) settle();
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
    task: RuntimeTaskHandle,
  ): Promise<void> {
    if (!this.runtimeRunner || !this.runtimeTranslator) return;
    let activePrompt: RuntimePrompt | undefined;
    let activeOpenModelRequestStartIds: string[] = [];
    try {
      for (const prompt of prompts) {
        activePrompt = prompt;
        activeOpenModelRequestStartIds = [];
        this.setRuntimeTaskPostIdle(workspaceId, sessionId, task, false);
        const stopRenewing = this.startRuntimeLeaseRenewal(
          workspaceId,
          sessionId,
          prompt,
        );
        let settled: RuntimeConversationSettledEvent | undefined;
        let drainingClosedTurn = false;
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
            { signal, turnId: prompt.turnId },
          );
          for await (const piEvent of source) {
            if (isRuntimeConversationSettledEvent(piEvent)) {
              settled = piEvent;
              continue;
            }
            // This owner's own interrupt can close the turn mid-stream; later
            // writes then fail the pending-only fence. Keep draining (writing
            // nothing) until the settled event so the conversation is saved.
            if (drainingClosedTurn) continue;
            try {
              if (isRuntimeCustomToolUseEvent(piEvent)) {
                this.customTools.persistCustomToolUse(
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
                this.toolConfirmations.persistToolPermissionUse(
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
                  this.toolConfirmations.persistToolPermissionUseWithModelEnd(
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
                this.toolConfirmations.persistMcpToolUse(
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
                  this.toolConfirmations.persistMcpToolUseWithModelEnd(
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
                this.toolConfirmations.persistMcpToolResult(
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
                this.toolConfirmations.persistMcpConnectionFailed(
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
                this.setRuntimeTaskPostIdle(workspaceId, sessionId, task, true);
                await this.indexSessionOutputsFromLiveRuntime(
                  workspaceId,
                  sessionId,
                  prompt,
                );
              }
            } catch (error) {
              if (
                error instanceof RuntimeTurnOwnershipLostError &&
                this.events.isRuntimeTurnClosedBy({ workspaceId, sessionId, ...prompt })
              ) {
                drainingClosedTurn = true;
                continue;
              }
              throw error;
            }
          }
          this.closeSettledRuntimeTurn(
            workspaceId,
            sessionId,
            prompt,
            activeOpenModelRequestStartIds,
            settled,
          );
        } finally {
          stopRenewing();
          // Every exit releases the runner's hold; a committed checkpoint
          // already released with true, so this is a no-op then.
          settled?.release(false);
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
    conversation?: RuntimeConversationCheckpoint,
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
      ...(conversation === undefined ? {} : { conversationCheckpoints: [conversation] }),
    });
  }

  // Plan 0147: a settled turn's conversation commits in the same transaction
  // as the turn close. If this owner already closed the turn (an interrupt),
  // the close throws and the checkpoint is written alone, still fenced on
  // turn ownership; a stale owner's checkpoint is rejected either way.
  private closeSettledRuntimeTurn(
    workspaceId: WorkspaceId,
    sessionId: string,
    prompt: RuntimePrompt,
    openModelRequestStartIds: readonly string[],
    settled: RuntimeConversationSettledEvent | undefined,
  ): void {
    // No session-lifecycle check: a deleted session's turn rows are gone, so
    // the ownership fence refuses it, and an archive ends the run before it
    // can settle.
    const conversation =
      settled === undefined || (settled.entries.length === 0 && settled.turnIds.length === 0)
        ? undefined
        : {
            workspaceId,
            sessionId,
            turnId: prompt.turnId,
            ownerId: prompt.ownerId,
            ownerGeneration: prompt.ownerGeneration,
            piVersion: settled.piVersion,
            entries: settled.entries,
            coveredTurnIds: settled.turnIds,
            now: new Date().toISOString(),
          };
    try {
      this.closeRuntimeTurnWithSyntheticSpanEnds(
        workspaceId,
        sessionId,
        prompt,
        openModelRequestStartIds,
        "completed",
        "completed",
        conversation,
      );
    } catch (error) {
      // This owner's own interrupt already closed the turn: expected, not an
      // ownership loss. Save the checkpoint alone and return, so the session
      // is not interrupted again (a newer turn may be running by now).
      if (
        error instanceof RuntimeTurnOwnershipLostError &&
        this.events.isRuntimeTurnClosedBy({ workspaceId, sessionId, ...prompt })
      ) {
        if (conversation !== undefined) {
          this.events.appendBatchWithRuntimeChanges([], {
            conversationCheckpoints: [conversation],
          });
        }
        settled?.release(true);
        return;
      }
      throw error;
    }
    settled?.release(true);
  }

  private closeRuntimeTurnWithSyntheticSpanEnds(
    workspaceId: WorkspaceId,
    sessionId: string,
    prompt: RuntimePrompt,
    openModelRequestStartIds: readonly string[],
    state: "completed" | "terminalized",
    reason: "completed" | "terminalized" | "interrupted" | "archived" | "deleted",
    conversation?: RuntimeConversationCheckpoint,
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
        conversation,
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
      ...(conversation === undefined ? {} : { conversationCheckpoints: [conversation] }),
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

  private hasPendingRuntimeActions(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): boolean {
    return (
      this.customTools.pendingCustomToolActions.has(workspaceId, sessionId) ||
      this.toolConfirmations.pendingToolConfirmations.has(workspaceId, sessionId)
    );
  }

  private flushPendingActions(workspaceId: WorkspaceId, sessionId: string): void {
    // Coalesce both stores into ONE requires_action event (custom then
    // confirmations, preserving id order). snapshotForFlush clears each timer
    // and drops the entry when empty; ids persist until resolved, so a later
    // flush re-emits requires_action with the full remaining pending set.
    const ids = [
      ...this.customTools.pendingCustomToolActions.snapshotForFlush(workspaceId, sessionId),
      ...this.toolConfirmations.pendingToolConfirmations.snapshotForFlush(workspaceId, sessionId),
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
