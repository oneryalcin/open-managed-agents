import type { WorkspaceId } from "../workspace.ts";
import type { EventDraft } from "./persist.ts";
import type {
  EventStoreRuntimeChanges,
  PendingRuntimeActionRecord,
  RuntimeEventRunner,
  RuntimeEventTranslator,
  SessionEventBroadcaster,
  SessionEventStore,
} from "./types.ts";

/**
 * What the custom-tool and tool-confirmation collaborators share with
 * DefaultSessionEventsService (#164, plan 0146 slice 2). The service keeps the
 * lifecycle guard sets, the turn-claim helper (crash recovery uses it too),
 * durable release-close, and the cross-store requires_action flush; the
 * collaborators get them injected so their method bodies moved unchanged.
 */
export interface ToolActionDeps {
  events: SessionEventStore;
  broadcaster: SessionEventBroadcaster;
  runtimeRunner: RuntimeEventRunner | undefined;
  runtimeTranslator: RuntimeEventTranslator | undefined;
  ownerId: string;
  closedSessions: ReadonlySet<string>;
  deletedSessions: ReadonlySet<string>;
  claimTurnForTerminalization: (turn: {
    workspace_id: WorkspaceId;
    session_id: string;
    turn_id: string;
  }) => ReturnType<SessionEventStore["claimRuntimeTurnForTerminalization"]>;
  closeReleasedRuntimeAction: (
    workspaceId: WorkspaceId,
    sessionId: string,
    actionId: string,
    reason: PendingRuntimeActionRecord["close_reason"],
  ) => void;
  persistRuntimeDrafts: (
    workspaceId: WorkspaceId,
    sessionId: string,
    drafts: readonly EventDraft[],
  ) => void;
  flushPendingActions: (workspaceId: WorkspaceId, sessionId: string) => void;
}

/** Whether this batch already closes the turn (one close per turn). */
export function closesTurn(changes: EventStoreRuntimeChanges, turnId: string): boolean {
  return changes.closedTurns?.some((turn) => turn.turnId === turnId) === true;
}
