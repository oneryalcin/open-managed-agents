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

// Message string is fixed to match hosted CMA verbatim (probe 38): the observed
// error carries no session id. Probe 38 only exercised status "running"; we
// reuse this single wording for the "rescheduling" case as a conservative mirror
// of the archive guard (unverified against hosted — see PARITY.md follow-up).
export function sessionNotDeletable(): Error {
  return invalidRequest(
    "Cannot delete session while it is running. Send an interrupt event or wait for the session to complete.",
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
