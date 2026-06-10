import {
  type ListSessionEventsResponse,
  type ManagedAgentsContentBlock,
  type ManagedAgentsEvent,
  type ManagedAgentsOpaqueContentBlock,
  type ManagedAgentsUserCustomToolResultEventInput,
  type ManagedAgentsUserEventInput,
  type ManagedAgentsUserToolConfirmationEventInput,
  type SendSessionEventsRequest,
} from "../../types/events.ts";
import {
  isJsonObject,
  isJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../types/json.ts";
import { ApiError, invalidRequest, notFound } from "../errors.ts";
import { conflict, toApiErrorBody } from "../errors.ts";
import {
  type DeploymentSessionOutputCoordinator,
} from "../deployment-session-output-coordinator.ts";
import type { DeploymentRuntimeEventCoordinator } from "../deployment-runtime-event-coordinator.ts";
import type { SessionRow, SessionStore } from "../sessions/types.ts";
import type { WorkspaceId } from "../workspace.ts";
import { newRuntimeTurnId, newRequestId } from "../ids.ts";
import { MAX_EVENTS_PER_REQUEST } from "./constants.ts";
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
  IdempotencyCompletionInput,
  ListSessionEventsOptions,
  PendingRuntimeActionRecord,
  PendingRuntimeTurnRecord,
  RuntimeCustomToolUseEvent,
  RuntimeEventRunner,
  RuntimeEventTranslator,
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

const SUPPORTED_USER_EVENT_TYPES = new Set([
  "user.message",
  "user.interrupt",
  "user.custom_tool_result",
  "user.tool_confirmation",
] as const);

const IDEMPOTENCY_RESPONSE_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_ABANDONED_IN_PROGRESS_MS = 5 * 60 * 1000;

function idempotencyCompletion(
  workspaceId: WorkspaceId,
  idempotency: EventsSendIdempotencyKey,
  response: { status: number; body: unknown },
): IdempotencyCompletionInput {
  const now = new Date();
  return {
    ...idempotency,
    workspaceId,
    responseStatus: response.status,
    responseBody: response.body,
    now: now.toISOString(),
    expiresAt: new Date(now.getTime() + IDEMPOTENCY_RESPONSE_TTL_MS).toISOString(),
  };
}

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
  private readonly pendingCustomToolActions = new Map<
    string,
    {
      workspaceId: WorkspaceId;
      ids: string[];
      timer: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  private readonly closedSessions = new Set<string>();
  private readonly deletedSessions = new Set<string>();
  private readonly activeRuntimeTasks = new Map<string, number>();
  private readonly interruptedCustomToolActions = new Map<string, Set<string>>();
  private readonly pendingToolConfirmations = new Map<
    string,
    {
      workspaceId: WorkspaceId;
      ids: string[];
      timer: ReturnType<typeof setTimeout> | undefined;
    }
  >();
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
  ) {
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
    const now = new Date();
    // Keep reservation and domain execution in one synchronous call path after
    // the route has read the raw body. Adding an await here would reopen the
    // same-key interleaving ADR 0015 is designed to avoid.
    const reservation = this.events.reserveIdempotencyKey({
      ...idempotency,
      workspaceId,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + IDEMPOTENCY_RESPONSE_TTL_MS).toISOString(),
      abandonedBefore: new Date(
        now.getTime() - IDEMPOTENCY_ABANDONED_IN_PROGRESS_MS,
      ).toISOString(),
    });
    if (reservation.kind === "replay") {
      return {
        status: reservation.responseStatus as SessionEventsHttpResponse["status"],
        body: reservation.responseBody,
      };
    }
    if (reservation.kind === "fingerprint_mismatch") {
      throw invalidRequest(
        "`Idempotency-Key` was already used for a different request",
      );
    }
    if (reservation.kind === "in_progress") {
      throw conflict(
        "A request with this `Idempotency-Key` is already in progress; retry later",
      );
    }
    try {
      const events = this.sendInternal(workspaceId, sessionId, input, {
        signal: opts.signal,
        idempotency,
      });
      return { status: 200, body: { data: events } };
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        // Replay returns the original error envelope, including request_id.
        // The fresh HTTP header still carries the retry attempt's request id.
        const body = toApiErrorBody(error, opts.requestId);
        const completionClock = new Date();
        this.events.completeIdempotency({
          ...idempotency,
          workspaceId,
          responseStatus: error.status,
          responseBody: body,
          now: completionClock.toISOString(),
          expiresAt: new Date(
            completionClock.getTime() + IDEMPOTENCY_RESPONSE_TTL_MS,
          ).toISOString(),
        });
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
        this.removePendingCustomToolAction(workspaceId, sessionId, customToolUseId);
      }
      for (const { toolUseId } of committedToolConfirmations) {
        this.removePendingToolConfirmation(workspaceId, sessionId, toolUseId);
      }
      this.persistRuntimeDrafts(workspaceId, sessionId, [
        { type: "session.status_running", payload: {} },
      ]);
      for (const { commit, customToolUseId } of liveCustomToolResultClaims) {
        try {
          commit();
        } catch (error) {
          console.error("custom tool result callback failed after commit", {
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
          console.error("tool confirmation callback failed after commit", {
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
          ...this.clearPendingCustomToolActions(workspaceId, sessionId),
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
          ...this.clearPendingToolConfirmations(workspaceId, sessionId),
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
      console.error("runtime session interrupt failed", { sessionId, error });
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
        {
          type: "agent.tool_result",
          payload: lostToolConfirmationPayload(claim.toolUseId),
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
    this.clearPendingCustomToolActions(workspaceId, sessionId);
    this.clearPendingToolConfirmations(workspaceId, sessionId);
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
    this.clearPendingCustomToolActions(workspaceId, sessionId);
    this.clearPendingToolConfirmations(workspaceId, sessionId);
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
      console.error("runtime session cleanup failed", { sessionId, error });
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
        console.debug("runtime turn ownership lost; interrupting local runner", {
          workspaceId,
          sessionId,
          turnId: error.turnId,
        });
        void Promise.resolve(
          this.runtimeRunner?.interruptSession?.(workspaceId, sessionId),
        ).catch((interruptError) => {
          console.error("runtime ownership-loss interrupt failed", {
            sessionId,
            error: interruptError,
          });
        });
        return;
      }
      console.error("runtime ingestion failed", { sessionId, error });
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
      console.warn("session output indexing failed", {
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
          console.debug("runtime lease renewal ownership lost", {
            workspaceId,
            sessionId,
            turnId: error.turnId,
          });
        } else {
          console.error("runtime lease renewal failed", { sessionId, error });
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
        this.removePendingCustomToolAction(workspaceId, sessionId, useRows[0].id);
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
      this.addPendingCustomToolAction(workspaceId, sessionId, useRows[0].id);
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
      const useRows = this.materializeToolPermissionUseRows(
        workspaceId,
        sessionId,
        event,
        now,
      );
      persistRuntimeChangesAndPublish(this.events, this.broadcaster, useRows, {
        ...this.toolPermissionRuntimeChanges(
          workspaceId,
          sessionId,
          turnId,
          ownerId,
          ownerGeneration,
          event,
          useRows[0].id,
          now,
        ),
      });
      if (event.evaluatedPermission === "ask") {
        this.addPendingToolConfirmation(workspaceId, sessionId, useRows[0].id);
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
      const useRows = this.materializeToolPermissionUseRows(
        workspaceId,
        sessionId,
        permission,
        now,
      );
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
          ...this.toolPermissionRuntimeChanges(
            workspaceId,
            sessionId,
            turnId,
            ownerId,
            ownerGeneration,
            permission,
            useRows[0].id,
            now,
          ),
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
        this.addPendingToolConfirmation(workspaceId, sessionId, useRows[0].id);
      }
      return spanEndDrafts.length > 0 ? closingModelRequestStartId : undefined;
    } catch (error) {
      permission.rejectToolUse(toError(error));
      throw error;
    }
  }

  private materializeToolPermissionUseRows(
    workspaceId: WorkspaceId,
    sessionId: string,
    event: RuntimeToolPermissionUseEvent,
    now: string,
  ): PersistedSessionEvent[] {
    const useRows = materializePersistedEvents(
      workspaceId,
      sessionId,
      [
        {
          type: "agent.tool_use",
          payload: {
            name: event.name,
            input: event.input,
            evaluated_permission: event.evaluatedPermission,
          },
        },
      ],
      now,
    );
    event.bindToolUseId(useRows[0].id, (reason) => {
      if (reason !== undefined) {
        this.closeReleasedRuntimeAction(
          workspaceId,
          sessionId,
          useRows[0].id,
          reason,
        );
      }
      this.removePendingToolConfirmation(workspaceId, sessionId, useRows[0].id);
    });
    return useRows;
  }

  private toolPermissionRuntimeChanges(
    workspaceId: WorkspaceId,
    sessionId: string,
    turnId: string,
    ownerId: string,
    ownerGeneration: number,
    event: RuntimeToolPermissionUseEvent,
    toolUseId: string,
    now: string,
  ): Pick<EventStoreRuntimeChanges, "openedActions" | "turnStates"> {
    return {
      openedActions:
        event.evaluatedPermission === "ask"
          ? [
              {
                workspaceId,
                sessionId,
                turnId,
                actionId: toolUseId,
                actionType: "tool_confirmation",
                now,
              },
            ]
          : [],
      turnStates:
        event.evaluatedPermission === "ask"
          ? [
              {
                workspaceId,
                sessionId,
                turnId,
                ownerId,
                ownerGeneration,
                state: "paused",
                now,
              },
            ]
          : [
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
    };
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
      {
        type: "agent.tool_result",
        payload: lostToolConfirmationPayload(toolUseId),
      },
      {
        type: "session.status_idle",
        payload: { stop_reason: { type: "end_turn" } },
      },
    ]);
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
        types: ["user.tool_confirmation", "agent.tool_result"],
      });
      rows.push(...result.data);
      page = result.next_page ?? undefined;
    } while (page !== undefined);
    return rows;
  }

  private addPendingCustomToolAction(
    workspaceId: WorkspaceId,
    sessionId: string,
    customToolUseId: string,
  ): void {
    const key = sessionScopeKey(workspaceId, sessionId);
    let pending = this.pendingCustomToolActions.get(key);
    if (!pending) {
      pending = { workspaceId, ids: [], timer: undefined };
      this.pendingCustomToolActions.set(key, pending);
    }
    pending.ids.push(customToolUseId);
    if (pending.timer) return;
    // Pi may emit parallel custom-tool calls back-to-back in one runtime burst.
    // Defer the idle by one macrotask so those calls coalesce into one
    // requires_action event. If another tool arrives later, we re-emit
    // requires_action with the full remaining pending set.
    pending.timer = setTimeout(() => {
      this.flushPendingActions(pending.workspaceId, sessionId);
    }, 0);
  }

  private removePendingCustomToolAction(
    workspaceId: WorkspaceId,
    sessionId: string,
    customToolUseId: string,
  ): void {
    const key = sessionScopeKey(workspaceId, sessionId);
    const pending = this.pendingCustomToolActions.get(key);
    if (!pending) return;
    pending.ids = pending.ids.filter((id) => id !== customToolUseId);
    if (pending.ids.length === 0 && pending.timer === undefined) {
      this.pendingCustomToolActions.delete(key);
    }
  }

  private clearPendingCustomToolActions(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): string[] {
    const key = sessionScopeKey(workspaceId, sessionId);
    const pending = this.pendingCustomToolActions.get(key);
    if (!pending) return [];
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingCustomToolActions.delete(key);
    return [...pending.ids];
  }

  private hasPendingCustomToolActions(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): boolean {
    return (
      this.pendingCustomToolActions.get(sessionScopeKey(workspaceId, sessionId))
        ?.ids.length ?? 0
    ) > 0;
  }

  private addPendingToolConfirmation(
    workspaceId: WorkspaceId,
    sessionId: string,
    toolUseId: string,
  ): void {
    const key = sessionScopeKey(workspaceId, sessionId);
    let pending = this.pendingToolConfirmations.get(key);
    if (!pending) {
      pending = { workspaceId, ids: [], timer: undefined };
      this.pendingToolConfirmations.set(key, pending);
    }
    pending.ids.push(toolUseId);
    if (pending.timer) return;
    pending.timer = setTimeout(() => {
      this.flushPendingActions(pending.workspaceId, sessionId);
    }, 0);
  }

  private removePendingToolConfirmation(
    workspaceId: WorkspaceId,
    sessionId: string,
    toolUseId: string,
  ): void {
    const key = sessionScopeKey(workspaceId, sessionId);
    const pending = this.pendingToolConfirmations.get(key);
    if (!pending) return;
    pending.ids = pending.ids.filter((id) => id !== toolUseId);
    if (pending.ids.length === 0 && pending.timer === undefined) {
      this.pendingToolConfirmations.delete(key);
    }
  }

  private clearPendingToolConfirmations(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): string[] {
    const key = sessionScopeKey(workspaceId, sessionId);
    const pending = this.pendingToolConfirmations.get(key);
    if (!pending) return [];
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingToolConfirmations.delete(key);
    return [...pending.ids];
  }

  private hasPendingToolConfirmations(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): boolean {
    return (
      this.pendingToolConfirmations.get(sessionScopeKey(workspaceId, sessionId))
        ?.ids.length ?? 0
    ) > 0;
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
      this.hasPendingCustomToolActions(workspaceId, sessionId) ||
      this.hasPendingToolConfirmations(workspaceId, sessionId)
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
    const key = sessionScopeKey(workspaceId, sessionId);
    const custom = this.pendingCustomToolActions.get(key);
    const confirmations = this.pendingToolConfirmations.get(key);
    if (!custom && !confirmations) return;
    if (custom?.timer) {
      clearTimeout(custom.timer);
      custom.timer = undefined;
    }
    if (confirmations?.timer) {
      clearTimeout(confirmations.timer);
      confirmations.timer = undefined;
    }
    const ids = [
      ...(custom?.ids ?? []),
      ...(confirmations?.ids ?? []),
    ];
    if (custom && custom.ids.length === 0) {
      this.pendingCustomToolActions.delete(key);
    }
    if (confirmations && confirmations.ids.length === 0) {
      this.pendingToolConfirmations.delete(key);
    }
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

  private flushPendingCustomToolActions(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): void {
    this.flushPendingActions(workspaceId, sessionId);
  }
}

function requireActiveSession(
  store: SessionStore,
  workspaceId: WorkspaceId,
  sessionId: string,
): void {
  if (!store.retrieve(workspaceId, sessionId)) {
    throw notFound(`Session ${sessionId} not found`);
  }
}

function requireExistingSession(
  store: SessionStore,
  workspaceId: WorkspaceId,
  sessionId: string,
): SessionRow {
  const session = store.retrieveAny(workspaceId, sessionId);
  if (!session) {
    throw notFound(`Session ${sessionId} not found`);
  }
  return session;
}

function sessionNotArchivable(
  sessionId: string,
  status: "running" | "rescheduling",
): Error {
  return invalidRequest(
    `Session ${sessionId} cannot be archived while its status is "${status}". Only pending or idle sessions may be archived.`,
  );
}

function archiveGuardKey(workspaceId: WorkspaceId, sessionId: string): string {
  return JSON.stringify([workspaceId, sessionId]);
}

function sessionScopeKey(workspaceId: WorkspaceId, sessionId: string): string {
  return JSON.stringify([workspaceId, sessionId]);
}

function parseSendRequest(input: unknown): SendSessionEventsRequest {
  const obj = objectInput(input);
  const value = obj.events;
  if (!Array.isArray(value)) {
    throw invalidRequest("`events` must be a non-empty array");
  }
  if (value.length === 0) {
    throw invalidRequest("`events` must be a non-empty array");
  }
  if (value.length > MAX_EVENTS_PER_REQUEST) {
    throw invalidRequest(
      `\`events\` must contain at most ${MAX_EVENTS_PER_REQUEST} items`,
    );
  }
  const events = value.map((item, index) => parseUserEvent(item, index));
  rejectMixedInterruptAndMessage(events);
  return { events };
}

function rejectMixedInterruptAndMessage(
  events: readonly SendSessionEventsRequest["events"][number][],
): void {
  const hasInterrupt = events.some((event) => event.type === "user.interrupt");
  if (!hasInterrupt) return;
  const hasMessage = events.some((event) => event.type === "user.message");
  if (!hasMessage) return;
  throw invalidRequest(
    "`events` cannot mix user.interrupt and user.message in one request",
  );
}

function parseUserEvent(
  input: unknown,
  index: number,
): SendSessionEventsRequest["events"][number] {
  const event = objectInput(input);
  if ("session_id" in event) {
    throw invalidRequest(
      `\`events[${index}].session_id\` is not allowed; session ID comes from the URL path`,
    );
  }
  const type = nonEmptyString(event.type, `events[${index}].type`);
  if (!SUPPORTED_USER_EVENT_TYPES.has(type as never)) {
    throw invalidRequest(
      `\`events[${index}].type\` must be one of user.message, user.interrupt, user.custom_tool_result, user.tool_confirmation`,
    );
  }
  if (!isJsonValue(event)) {
    throw invalidRequest(`\`events[${index}]\` must be JSON-compatible`);
  }
  if (type === "user.message") {
    const content = parseContentArray(event.content, `events[${index}].content`);
    return { type: "user.message", content };
  }
  if (type === "user.interrupt") {
    return { type: "user.interrupt" };
  }
  if (type === "user.custom_tool_result") {
    const customToolUseId = nonEmptyString(
      event.custom_tool_use_id,
      `events[${index}].custom_tool_use_id`,
    );
    const contentValue = event.content;
    return {
      type: "user.custom_tool_result",
      custom_tool_use_id: customToolUseId,
      ...(contentValue === undefined
        ? {}
        : {
            content: parseContentArray(
              contentValue,
              `events[${index}].content`,
            ),
          }),
      ...optionalBooleanSpread(event.is_error, `events[${index}].is_error`),
    };
  }
  const toolUseId = nonEmptyString(
    event.tool_use_id,
    `events[${index}].tool_use_id`,
  );
  const result = event.result;
  if (result !== "allow" && result !== "deny") {
    throw invalidRequest(
      `\`events[${index}].result\` must be \`allow\` or \`deny\``,
    );
  }
  const denyMessage = event.deny_message;
  if (result === "allow" && denyMessage !== undefined) {
    throw invalidRequest(
      `\`events[${index}].deny_message\` is only valid when result is \`deny\``,
    );
  }
  if (
    result === "deny" &&
    denyMessage !== undefined &&
    denyMessage !== null &&
    typeof denyMessage !== "string"
  ) {
    throw invalidRequest(
      `\`events[${index}].deny_message\` must be a string or null`,
    );
  }
  const normalizedDenyMessage =
    denyMessage === undefined || denyMessage === null || typeof denyMessage === "string"
      ? denyMessage
      : undefined;
  return {
    type: "user.tool_confirmation",
    tool_use_id: toolUseId,
    result,
    ...(normalizedDenyMessage === undefined
      ? {}
      : { deny_message: normalizedDenyMessage }),
  };
}

function parseContentArray(
  input: unknown,
  field: string,
): ManagedAgentsContentBlock[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidRequest(`\`${field}\` must be a non-empty array`);
  }
  return input.map((block, index) => parseContentBlock(block, `${field}[${index}]`));
}

function parseContentBlock(
  input: unknown,
  field: string,
): ManagedAgentsContentBlock {
  const block = objectInput(input);
  if (!isJsonValue(block)) {
    throw invalidRequest(`\`${field}\` must be JSON-compatible`);
  }
  const type = nonEmptyString(block.type, `${field}.type`);
  if (type === "text") {
    return {
      type,
      text: nonEmptyString(block.text, `${field}.text`),
    };
  }
  return block as ManagedAgentsOpaqueContentBlock;
}

function eventPayload(event: SendSessionEventsRequest["events"][number]): JsonObject {
  const { type: _type, ...payload } = event;
  return payload as Record<string, JsonValue>;
}

function toSendResponseEvent(
  row: PersistedSessionEvent | undefined,
): ManagedAgentsEvent {
  if (!row) throw new Error("Persisted event row missing");
  const event = toManagedAgentsEvent(row);
  if (row.type === "user.tool_confirmation") {
    return { ...event, processed_at: null };
  }
  return event;
}

function sameToolConfirmation(
  completed: {
    result: "allow" | "deny";
    denyMessage?: string | null;
  },
  event: ManagedAgentsUserToolConfirmationEventInput,
): boolean {
  return (
    completed.result === event.result &&
    (completed.denyMessage ?? null) === (event.deny_message ?? null)
  );
}

function sameCustomToolResult(
  left: ManagedAgentsUserCustomToolResultEventInput,
  right: ManagedAgentsUserCustomToolResultEventInput,
): boolean {
  return (
    left.custom_tool_use_id === right.custom_tool_use_id &&
    JSON.stringify(left.content ?? null) === JSON.stringify(right.content ?? null) &&
    (left.is_error ?? false) === (right.is_error ?? false)
  );
}

function sameCustomToolResultPayload(
  payload: JsonObject,
  event: ManagedAgentsUserCustomToolResultEventInput,
): boolean {
  return (
    payload.custom_tool_use_id === event.custom_tool_use_id &&
    JSON.stringify(payload.content ?? null) === JSON.stringify(event.content ?? null) &&
    (payload.is_error ?? false) === (event.is_error ?? false)
  );
}

function hasToolResultForToolUseId(
  rows: readonly PersistedSessionEvent[],
  toolUseId: string,
): boolean {
  return rows.some(
    (row) =>
      row.type === "agent.tool_result" &&
      row.payload.tool_use_id === toolUseId,
  );
}

function lostToolConfirmationPayload(toolUseId: string): JsonObject {
  return {
    tool_use_id: toolUseId,
    content: [
      {
        type: "text",
        text: `Tool confirmation ${toolUseId} was accepted, but runtime state is no longer available and the builtin tool execution outcome is unknown.`,
      },
    ],
    is_error: true,
  };
}

function leaseExpiresAt(now: string, ttlMs: number): string {
  return new Date(Date.parse(now) + ttlMs).toISOString();
}

function isRuntimeLeaseExpired(leaseExpiresAtValue: string): boolean {
  return Date.parse(leaseExpiresAtValue) <= Date.now();
}

function runtimeLeaseRetryDelayMs(leaseExpiresAtValue: string): number {
  return Math.max(0, Date.parse(leaseExpiresAtValue) - Date.now());
}

function isRuntimeTurnClosed(state: string): boolean {
  return state === "completed" || state === "terminalized";
}

function actionClosedWithoutResult(
  action: PendingRuntimeActionRecord | undefined,
): boolean {
  return (
    action?.close_reason === "interrupted" ||
    action?.close_reason === "timeout" ||
    action?.close_reason === "terminalized"
  );
}

function isAcknowledgedInFlightAction(
  action: PendingRuntimeActionRecord | undefined,
): boolean {
  return (
    action?.state === "acknowledged" &&
    !isRuntimeTurnClosed(action.turn.state) &&
    action.close_reason === null
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function runtimeTurnStillOwned(turnId: string): ApiError {
  return new ApiError(
    529,
    "overloaded_error",
    `Runtime turn ${turnId} is still owned by another worker; retry later`,
  );
}

function optionalBooleanSpread(
  value: unknown,
  field: string,
): { is_error?: boolean } {
  if (value === undefined) return {};
  if (typeof value === "boolean") return { is_error: value };
  throw invalidRequest(`\`${field}\` must be a boolean`);
}

function textFromContent(content: ManagedAgentsContentBlock[]): string | undefined {
  const text = content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function runtimeErrorDraft(error: unknown): EventDraft {
  const message = "Runtime execution failed";
  return {
    type: "session.error",
    payload: { message },
  };
}

function isRuntimeCustomToolUseEvent(
  event: unknown,
): event is RuntimeCustomToolUseEvent {
  if (!isObjectRecord(event)) return false;
  return (
    event.type === "oma.custom_tool_use" &&
    typeof event.piToolCallId === "string" &&
    typeof event.name === "string" &&
    isJsonObject(event.input) &&
    typeof event.bindCustomToolUseId === "function" &&
    typeof event.rejectCustomToolUse === "function"
  );
}

function isRuntimeToolPermissionUseEvent(
  event: unknown,
): event is RuntimeToolPermissionUseEvent {
  if (!isObjectRecord(event)) return false;
  return (
    event.type === "oma.tool_permission_use" &&
    typeof event.piToolCallId === "string" &&
    typeof event.name === "string" &&
    isJsonObject(event.input) &&
    (event.evaluatedPermission === "allow" ||
      event.evaluatedPermission === "ask" ||
      event.evaluatedPermission === "deny") &&
    typeof event.bindToolUseId === "function" &&
    typeof event.rejectToolUse === "function"
  );
}

function isRuntimeToolPermissionWithModelEndEvent(
  event: unknown,
): event is RuntimeToolPermissionWithModelEndEvent {
  if (!isObjectRecord(event)) return false;
  return (
    event.type === "oma.tool_permission_with_model_end" &&
    "messageEnd" in event &&
    isRuntimeToolPermissionUseEvent(event.permissionUse) &&
    Array.isArray(event.suppressedPiToolCallIds) &&
    event.suppressedPiToolCallIds.every((id) => typeof id === "string")
  );
}

function hasTerminalIdleDraft(drafts: readonly EventDraft[]): boolean {
  return drafts.some((draft) => {
    if (draft.type !== "session.status_idle") return false;
    const stopReason = draft.payload.stop_reason;
    if (!isJsonObject(stopReason)) return true;
    return stopReason.type !== "requires_action";
  });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!isJsonObject(input)) {
    throw invalidRequest("Request body must be a JSON object");
  }
  return input;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw invalidRequest(`\`${field}\` must be a non-empty string`);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
