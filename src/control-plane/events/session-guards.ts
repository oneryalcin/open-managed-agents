import { invalidRequest, notFound } from "../errors.ts";
import type { SessionRow, SessionStore } from "../sessions/types.ts";
import type { WorkspaceId } from "../workspace.ts";

export function requireActiveSession(
  store: SessionStore,
  workspaceId: WorkspaceId,
  sessionId: string,
): void {
  if (!store.retrieve(workspaceId, sessionId)) {
    throw notFound(`Session ${sessionId} not found`);
  }
}

export function requireExistingSession(
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

export function sessionNotArchivable(
  sessionId: string,
  status: "running" | "rescheduling",
): Error {
  return invalidRequest(
    `Session ${sessionId} cannot be archived while its status is "${status}". Only pending or idle sessions may be archived.`,
  );
}

export function archiveGuardKey(
  workspaceId: WorkspaceId,
  sessionId: string,
): string {
  return JSON.stringify([workspaceId, sessionId]);
}

export function sessionScopeKey(
  workspaceId: WorkspaceId,
  sessionId: string,
): string {
  return JSON.stringify([workspaceId, sessionId]);
}
