import type { FileStorageRecord } from "./files/types.ts";
import type { SessionEventStore } from "./events/types.ts";
import type { SessionRow, SessionStore } from "./sessions/types.ts";

export interface DeploymentSessionCoordinator {
  deleteSessionRows(
    workspaceId: string,
    sessionId: string,
  ): DeploymentSessionDeleteResult | undefined;
}

export interface DeploymentSessionDeleteResult {
  row: SessionRow;
  deletedSessionOutputFiles?: readonly FileStorageRecord[];
}

interface TransactionBoundary {
  withTransaction<T>(fn: () => T): T;
}

interface SessionOutputMetadataStore {
  deleteSessionOutputRows(
    workspaceId: string,
    sessionId: string,
  ): readonly FileStorageRecord[];
}

export function createSingleDatabaseSessionCoordinator(opts: {
  sessions: Pick<SessionStore, "delete">;
  events: Pick<SessionEventStore, "deleteForSession"> & TransactionBoundary;
  files: SessionOutputMetadataStore;
}): DeploymentSessionCoordinator {
  return {
    deleteSessionRows: (workspaceId, sessionId) =>
      opts.events.withTransaction(() => {
        const row = opts.sessions.delete(workspaceId, sessionId);
        if (!row) return undefined;
        opts.events.deleteForSession(workspaceId, sessionId);
        const deletedSessionOutputFiles = opts.files.deleteSessionOutputRows(
          workspaceId,
          sessionId,
        );
        return { row, deletedSessionOutputFiles };
      }),
  };
}

export function createInMemorySessionCoordinator(opts: {
  sessions: Pick<SessionStore, "delete">;
  events: Pick<SessionEventStore, "deleteForSession">;
}): DeploymentSessionCoordinator {
  return {
    deleteSessionRows: (workspaceId, sessionId) => {
      const row = opts.sessions.delete(workspaceId, sessionId);
      if (!row) return undefined;
      opts.events.deleteForSession(workspaceId, sessionId);
      return { row };
    },
  };
}
