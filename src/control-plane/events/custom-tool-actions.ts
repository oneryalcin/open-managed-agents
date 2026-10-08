// Custom-tool waits: persist the agent's custom_tool_use, hold it pending until
// the client's user.custom_tool_result, and claim/terminalize results
// (#164, plan 0146 slice 2). Moved verbatim from events/service.ts; the
// service still owns the cross-store requires_action flush and the shared
// turn-claim helper, which are injected.
import {
  type ManagedAgentsUserCustomToolResultEventInput,
  type SendSessionEventsRequest,
} from "../../types/events.ts";
import { invalidRequest, notFound } from "../errors.ts";
import type { WorkspaceId } from "../workspace.ts";
import {
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
  RuntimeCustomToolUseEvent,
  PersistedSessionEvent,
} from "./types.ts";
import { sessionScopeKey } from "./session-guards.ts";
import {
  sameCustomToolResult,
  sameCustomToolResultPayload,
} from "./request.ts";
import {
  actionClosedWithoutResult,
  isAcknowledgedInFlightAction,
  isRuntimeLeaseExpired,
  isRuntimeTurnClosed,
  runtimeTurnStillOwned,
  toError,
} from "./runtime-helpers.ts";
import { PendingActionStore } from "./pending-actions.ts";
import type { ToolActionDeps } from "./tool-action-deps.ts";

export type CustomToolResultClaim =
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

export class CustomToolActions {
  readonly pendingCustomToolActions: PendingActionStore;
  readonly interruptedCustomToolActions = new Map<string, Set<string>>();
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
    this.pendingCustomToolActions = new PendingActionStore(deps.flushPendingActions);
  }

  customToolTerminalizationRows(
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

  persistCustomToolUse(
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

  claimCustomToolResults(
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

  blockInterruptedCustomToolActions(
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
}
