import { invalidRequest } from "./errors.ts";
import type {
  FileStorage,
  FileStorageRecord,
  SessionOutputFileInput,
} from "./files/types.ts";
import type { SessionEventStore } from "./events/types.ts";
import type { SessionStore } from "./sessions/types.ts";
import type { WorkspaceId } from "./workspace.ts";

export interface DeploymentSessionOutputCoordinator {
  replaceSessionOutputsForRuntimeTurn(
    input: RuntimeTurnSessionOutputCommit,
  ): Promise<readonly FileStorageRecord[]>;
}

export interface RuntimeTurnSessionOutputCommit {
  workspaceId: WorkspaceId;
  sessionId: string;
  turnId: string;
  ownerId: string;
  ownerGeneration: number;
  files: readonly SessionOutputFileInput[];
}

interface LivenessFencedSessionOutputStorage {
  replaceSessionOutputsIfLive(
    workspaceId: string,
    sessionId: string,
    files: readonly SessionOutputFileInput[],
    canCommit: () => boolean,
  ): Promise<readonly FileStorageRecord[]>;
}

export function createSingleDatabaseSessionOutputCoordinator(opts: {
  sessions: Pick<SessionStore, "retrieve">;
  events: Pick<SessionEventStore, "listPendingRuntimeTurns">;
  files: LivenessFencedSessionOutputStorage;
}): DeploymentSessionOutputCoordinator {
  return {
    replaceSessionOutputsForRuntimeTurn: (input) =>
      // Local-object storage invokes this predicate inside its SQLite metadata
      // transaction. A Postgres coordinator should preserve that check/write
      // atomicity with database locks instead of a process-local callback.
      opts.files.replaceSessionOutputsIfLive(
        input.workspaceId,
        input.sessionId,
        input.files,
        () => canCommitRuntimeTurnOutputs(opts, input),
      ),
  };
}

export function createBestEffortSessionOutputCoordinator(opts: {
  sessions: Pick<SessionStore, "retrieve">;
  events: Pick<SessionEventStore, "listPendingRuntimeTurns">;
  files: Pick<FileStorage, "replaceSessionOutputs">;
}): DeploymentSessionOutputCoordinator {
  return {
    async replaceSessionOutputsForRuntimeTurn(input) {
      // In-memory/test deployments do not have one database transaction across
      // sessions, runtime turns, and file metadata. This keeps behavior aligned
      // with durable mode, but it is a best-effort check before the write.
      if (!canCommitRuntimeTurnOutputs(opts, input)) {
        throw inactiveSessionOutputCommit(input.sessionId);
      }
      return opts.files.replaceSessionOutputs(
        input.workspaceId,
        input.sessionId,
        input.files,
      );
    },
  };
}

function canCommitRuntimeTurnOutputs(
  opts: {
    sessions: Pick<SessionStore, "retrieve">;
    events: Pick<SessionEventStore, "listPendingRuntimeTurns">;
  },
  input: RuntimeTurnSessionOutputCommit,
): boolean {
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

function inactiveSessionOutputCommit(sessionId: string) {
  return invalidRequest(
    `Session outputs cannot be committed for inactive session ${sessionId}`,
  );
}
