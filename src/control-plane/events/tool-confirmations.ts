// Tool confirmations (builtin and MCP): persist ask-gated tool uses, hold them
// pending until user.tool_confirmation, and claim/terminalize decisions; MCP
// rides confirmations (#164, plan 0146 slice 2). Moved verbatim from
// events/service.ts; the service still owns the cross-store requires_action
// flush and the shared turn-claim helper, which are injected.
import {
  type ManagedAgentsUserToolConfirmationEventInput,
  type SendSessionEventsRequest,
} from "../../types/events.ts";
import { invalidRequest, notFound } from "../errors.ts";
import type { WorkspaceId } from "../workspace.ts";
import {
  spanModelRequestEndDraft,
  syntheticSpanModelRequestEndDrafts,
} from "../sessions/pi/span-normalizer.ts";
import {
  materializePersistedEvents,
  persistRuntimeChangesAndPublish,
  type EventDraft,
} from "./persist.ts";
import type {
  EventStoreRuntimeChanges,
  PendingRuntimeActionRecord,
  RuntimeMcpConnectionFailedEvent,
  RuntimeMcpToolResultEvent,
  RuntimeMcpToolUseEvent,
  RuntimeMcpToolWithModelEndEvent,
  RuntimeToolPermissionUseEvent,
  RuntimeToolPermissionWithModelEndEvent,
  PersistedSessionEvent,
} from "./types.ts";
import { sessionScopeKey } from "./session-guards.ts";
import {
  hasToolResultForToolUseId,
  lostMcpToolConfirmationPayload,
  lostToolConfirmationPayload,
  sameToolConfirmation,
} from "./request.ts";
import {
  actionClosedWithoutResult,
  isAcknowledgedInFlightAction,
  isRuntimeLeaseExpired,
  isRuntimeTurnClosed,
  runtimeTurnStillOwned,
  toError,
} from "./runtime-helpers.ts";
import {
  materializeMcpConnectionFailedRows,
  materializeMcpToolResultRows,
  materializeMcpToolUseRows,
  materializeToolPermissionUseRows,
  toolPermissionRuntimeChanges,
} from "./tool-persistence.ts";
import { PendingActionStore } from "./pending-actions.ts";
import { closesTurn, type ToolActionDeps } from "./tool-action-deps.ts";

export interface ToolConfirmationCommit {
  event: ManagedAgentsUserToolConfirmationEventInput;
  toolUseId: string;
  commit: () => void;
  row?: PersistedSessionEvent;
}

export interface ToolConfirmationReplay {
  event: ManagedAgentsUserToolConfirmationEventInput;
  row: PersistedSessionEvent;
}

export interface ToolConfirmationTerminalize {
  event: ManagedAgentsUserToolConfirmationEventInput;
  toolUseId: string;
  action: PendingRuntimeActionRecord;
  row?: PersistedSessionEvent;
}

export class ToolConfirmations {
  readonly pendingToolConfirmations: PendingActionStore;
  readonly interruptedToolConfirmations = new Map<string, Set<string>>();
  readonly completedToolConfirmations = new Map<
    string,
    {
      workspaceId: WorkspaceId;
      sessionId: string;
      result: "allow" | "deny";
      denyMessage?: string | null;
      row: PersistedSessionEvent;
    }
  >();
  private readonly events: ToolActionDeps["events"];
  private readonly broadcaster: ToolActionDeps["broadcaster"];
  private readonly runtimeRunner: ToolActionDeps["runtimeRunner"];
  private readonly runtimeTranslator: ToolActionDeps["runtimeTranslator"];
  private readonly ownerId: string;
  private readonly closedSessions: ReadonlySet<string>;
  private readonly deletedSessions: ReadonlySet<string>;
  private readonly claimTurnForTerminalization: ToolActionDeps["claimTurnForTerminalization"];
  private readonly closeReleasedRuntimeAction: ToolActionDeps["closeReleasedRuntimeAction"];
  private readonly persistRuntimeDrafts: ToolActionDeps["persistRuntimeDrafts"];

  constructor(deps: ToolActionDeps) {
    this.events = deps.events;
    this.broadcaster = deps.broadcaster;
    this.runtimeRunner = deps.runtimeRunner;
    this.runtimeTranslator = deps.runtimeTranslator;
    this.ownerId = deps.ownerId;
    this.closedSessions = deps.closedSessions;
    this.deletedSessions = deps.deletedSessions;
    this.claimTurnForTerminalization = deps.claimTurnForTerminalization;
    this.closeReleasedRuntimeAction = deps.closeReleasedRuntimeAction;
    this.persistRuntimeDrafts = deps.persistRuntimeDrafts;
    this.pendingToolConfirmations = new PendingActionStore(deps.flushPendingActions);
  }

  toolConfirmationTerminalizationRows(
    workspaceId: WorkspaceId,
    sessionId: string,
    claims: readonly (ToolConfirmationCommit | ToolConfirmationReplay | ToolConfirmationTerminalize)[],
    now: string,
    runtimeChanges: EventStoreRuntimeChanges,
  ): PersistedSessionEvent[] {
    // Every confirmed tool use gets its result; each turn closes once, with
    // one idle after all of them. Runs before the custom-tool terminalization,
    // which then sees these turns already closed.
    const drafts: EventDraft[] = [];
    let closedAny = false;
    for (const claim of claims) {
      if (!("action" in claim)) continue;
      const turn = claim.action.turn;
      (runtimeChanges.acknowledgedActions ??= []).push({
        workspaceId,
        sessionId,
        actionId: claim.toolUseId,
        now,
      });
      if (!closesTurn(runtimeChanges, claim.action.turn_id)) {
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
        );
        closedAny = true;
      }
      drafts.push(
        this.lostToolConfirmationResultDraft(
          workspaceId,
          sessionId,
          claim.toolUseId,
        ),
      );
    }
    if (closedAny) {
      drafts.push({
        type: "session.status_idle",
        payload: { stop_reason: { type: "end_turn" } },
      });
    }
    if (drafts.length === 0) return [];
    return materializePersistedEvents(workspaceId, sessionId, drafts, now);
  }

  persistToolPermissionUse(
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

  persistToolPermissionUseWithModelEnd(
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
  persistMcpToolUse(
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

  persistMcpToolUseWithModelEnd(
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
  persistMcpToolResult(
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

  persistMcpConnectionFailed(
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

  claimToolConfirmations(
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

  clearCompletedToolConfirmations(
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

  blockInterruptedToolConfirmations(
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
}
