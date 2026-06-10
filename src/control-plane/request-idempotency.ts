import { createHash } from "node:crypto";
import { conflict, invalidRequest, toApiErrorBody } from "./errors.ts";
import type { WorkspaceId } from "./workspace.ts";

export const IDEMPOTENCY_RESPONSE_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_ABANDONED_IN_PROGRESS_MS = 5 * 60 * 1000;
export const IDEMPOTENCY_RETRY_AFTER_SECONDS = 5;
export const IDEMPOTENCY_HEARTBEAT_INTERVAL_MS = 60 * 1000;

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export interface RequestIdempotencyKey {
  method: string;
  concretePath: string;
  key: string;
  routeLabel: string;
  fingerprintSha256: string;
}

export interface IdempotencyReservationInput extends RequestIdempotencyKey {
  workspaceId: WorkspaceId;
  now: string;
  expiresAt: string;
  abandonedBefore: string;
}

export type IdempotencyReservationResult =
  | { kind: "reserved" }
  | {
      kind: "replay";
      responseStatus: number;
      responseBody: unknown;
    }
  | { kind: "in_progress" }
  | { kind: "fingerprint_mismatch" };

export interface IdempotencyCompletionInput extends RequestIdempotencyKey {
  workspaceId: WorkspaceId;
  responseStatus: number;
  responseBody: unknown;
  now: string;
  expiresAt: string;
  resourceType?: string;
  resourceId?: string;
}

export interface RequestIdempotencyLedger {
  reserveIdempotencyKey(
    input: IdempotencyReservationInput,
  ): IdempotencyReservationResult;
  completeIdempotencyInTransaction(completion: IdempotencyCompletionInput): void;
  completeIdempotency(completion: IdempotencyCompletionInput): void;
  releaseIdempotencyReservation(input: RequestIdempotencyKey & {
    workspaceId: WorkspaceId;
  }): void;
  refreshIdempotencyReservation(input: RequestIdempotencyKey & {
    workspaceId: WorkspaceId;
    now: string;
    expiresAt: string;
  }): void;
}

export interface JsonHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function validateIdempotencyKey(value: string): string {
  if (value.length === 0) {
    throw invalidRequest("`Idempotency-Key` must not be empty");
  }
  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw invalidRequest(
      `\`Idempotency-Key\` must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  if (!/^[\x21-\x7E]+$/.test(value)) {
    throw invalidRequest("`Idempotency-Key` must contain only visible ASCII characters");
  }
  return value;
}

export function requestFingerprint(
  method: string,
  concretePath: string,
  rawBody: Uint8Array,
): string {
  const hash = createHash("sha256");
  hash.update(method);
  hash.update("\n");
  hash.update(concretePath);
  hash.update("\n");
  hash.update(rawBody);
  return hash.digest("hex");
}

export function reserveWindow(now = new Date()): {
  now: string;
  expiresAt: string;
  abandonedBefore: string;
} {
  return {
    now: now.toISOString(),
    expiresAt: new Date(now.getTime() + IDEMPOTENCY_RESPONSE_TTL_MS).toISOString(),
    abandonedBefore: new Date(
      now.getTime() - IDEMPOTENCY_ABANDONED_IN_PROGRESS_MS,
    ).toISOString(),
  };
}

export function completionWindow(now = new Date()): {
  now: string;
  expiresAt: string;
} {
  return {
    now: now.toISOString(),
    expiresAt: new Date(now.getTime() + IDEMPOTENCY_RESPONSE_TTL_MS).toISOString(),
  };
}

export async function withIdempotencyReservationHeartbeat<T>(
  ledger: RequestIdempotencyLedger | undefined,
  input: (RequestIdempotencyKey & { workspaceId: WorkspaceId }) | undefined,
  operation: Promise<T>,
): Promise<T> {
  if (!ledger || !input) return operation;
  const refresh = () => {
    ledger.refreshIdempotencyReservation({
      ...input,
      ...completionWindow(),
    });
  };
  refresh();
  const timer = setInterval(refresh, IDEMPOTENCY_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  try {
    return await operation;
  } finally {
    clearInterval(timer);
  }
}

export function idempotencyCompletion(
  workspaceId: WorkspaceId,
  idempotency: RequestIdempotencyKey,
  response: { status: number; body: unknown },
  resource?: { type: string; id: string },
): IdempotencyCompletionInput {
  return {
    ...idempotency,
    workspaceId,
    responseStatus: response.status,
    responseBody: response.body,
    ...completionWindow(),
    ...(resource === undefined
      ? {}
      : { resourceType: resource.type, resourceId: resource.id }),
  };
}

export function idempotencyConflictResponse(requestId?: string): JsonHttpResponse {
  // This is client retry guidance in seconds. It is intentionally much shorter
  // than the abandoned in-progress threshold used for crash recovery.
  const error = conflict(
    "A request with this `Idempotency-Key` is already in progress; retry later",
  );
  return {
    status: error.status,
    body: toApiErrorBody(error, requestId),
    headers: { "retry-after": String(IDEMPOTENCY_RETRY_AFTER_SECONDS) },
  };
}

export function idempotencyMismatchError(): Error {
  return invalidRequest(
    "`Idempotency-Key` was already used for a different request",
  );
}
