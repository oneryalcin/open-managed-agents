import {
  RuntimeTurnOwnershipLostError,
  type EventStoreRuntimeChanges,
  type PersistedSessionEvent,
  type SessionEventStore,
} from "./events/types.ts";
import type { SessionStore } from "./sessions/types.ts";
import {
  canCommitRuntimeTurn,
  type RuntimeTurnCommitFence,
} from "./deployment-runtime-turn-guard.ts";

export interface DeploymentRuntimeEventCoordinator {
  commitRuntimeEventsForTurn(input: RuntimeTurnEventCommit): void;
}

export interface RuntimeTurnEventCommit extends RuntimeTurnCommitFence {
  events: readonly PersistedSessionEvent[];
  changes: EventStoreRuntimeChanges;
}

interface TransactionBoundary {
  // SQLite-era seam: this callback is synchronous because node:sqlite is
  // synchronous. A Postgres-backed coordinator should make the transaction
  // boundary async and re-express these invariants with database locks.
  withTransaction<T>(fn: () => T): T;
}

interface RuntimeEventCommitStore {
  appendBatchWithRuntimeChangesInTransaction(
    events: readonly PersistedSessionEvent[],
    changes: EventStoreRuntimeChanges,
  ): void;
}

export function createSingleDatabaseRuntimeEventCoordinator(opts: {
  sessions: Pick<SessionStore, "retrieve">;
  events: Pick<SessionEventStore, "listPendingRuntimeTurns"> &
    RuntimeEventCommitStore &
    TransactionBoundary;
}): DeploymentRuntimeEventCoordinator {
  return {
    commitRuntimeEventsForTurn: (input) =>
      opts.events.withTransaction(() => {
        if (!canCommitRuntimeTurn(opts, input)) {
          throw new RuntimeTurnOwnershipLostError(input.turnId);
        }
        opts.events.appendBatchWithRuntimeChangesInTransaction(
          input.events,
          input.changes,
        );
      }),
  };
}

export function createBestEffortRuntimeEventCoordinator(opts: {
  sessions: Pick<SessionStore, "retrieve">;
  events: Pick<
    SessionEventStore,
    "appendBatchWithRuntimeChanges" | "listPendingRuntimeTurns"
  >;
}): DeploymentRuntimeEventCoordinator {
  return {
    commitRuntimeEventsForTurn(input) {
      // In-memory/test deployments do not share one database transaction
      // across sessions and events. Keep the same fence as durable mode, but
      // the check is best-effort before the event/runtime mutation.
      if (!canCommitRuntimeTurn(opts, input)) {
        throw new RuntimeTurnOwnershipLostError(input.turnId);
      }
      opts.events.appendBatchWithRuntimeChanges(input.events, input.changes);
    },
  };
}
