import type { SessionEventStore } from "./events/types.ts";
import type { SessionStore } from "./sessions/types.ts";
import type { WorkspaceId } from "./workspace.ts";

export interface RuntimeTurnCommitFence {
  workspaceId: WorkspaceId;
  sessionId: string;
  turnId: string;
  ownerId: string;
  ownerGeneration: number;
}

export function canCommitRuntimeTurn(
  opts: {
    sessions: Pick<SessionStore, "retrieve">;
    events: Pick<SessionEventStore, "listPendingRuntimeTurns">;
  },
  input: RuntimeTurnCommitFence,
): boolean {
  // Cross-store session + runtime-turn predicate shared by deployment
  // coordinators. Some legacy store updates still enforce only owner/generation
  // in their WHERE clauses until their call sites get coordinator seams.
  if (!opts.sessions.retrieve(input.workspaceId, input.sessionId)) return false;
  const turn = opts.events
    .listPendingRuntimeTurns(input.workspaceId)
    .find(
      (candidate) =>
        candidate.session_id === input.sessionId &&
        candidate.turn_id === input.turnId,
    );
  return (
    turn !== undefined &&
    turn.owner_id === input.ownerId &&
    turn.owner_generation === input.ownerGeneration
  );
}
