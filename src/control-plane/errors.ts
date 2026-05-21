import { newRequestId } from "./ids.ts";

export const API_ERROR_TYPES = [
  "invalid_request_error",
  "authentication_error",
  "billing_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
  "rate_limit_error",
  "api_error",
  "timeout_error",
  "overloaded_error",
] as const;

export type ApiErrorType = (typeof API_ERROR_TYPES)[number];

export type ApiErrorStatus =
  | 400
  | 401
  | 402
  | 403
  | 404
  | 413
  | 429
  | 500
  | 504
  | 529;

export interface ApiErrorBody {
  type: "error";
  error: {
    type: ApiErrorType;
    message: string;
  };
  request_id: string;
}

export class ApiError extends Error {
  readonly status: ApiErrorStatus;
  readonly type: ApiErrorType;
  readonly developerMessage?: string;

  constructor(
    status: ApiErrorStatus,
    type: ApiErrorType,
    message: string,
    opts: { developerMessage?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.developerMessage = opts.developerMessage;
  }
}

export function invalidRequest(
  message: string,
  developerMessage?: string,
): ApiError {
  return new ApiError(400, "invalid_request_error", message, {
    developerMessage,
  });
}

export function notFound(message: string): ApiError {
  return new ApiError(404, "not_found_error", message);
}

export function internalError(cause: unknown): ApiError {
  return new ApiError(500, "api_error", "Internal server error", {
    cause,
    developerMessage: cause instanceof Error ? cause.message : String(cause),
  });
}

export function requestId(): string {
  return newRequestId();
}

export function toApiErrorBody(
  error: ApiError,
  id: string = requestId(),
): ApiErrorBody {
  return {
    type: "error",
    error: {
      type: error.type,
      message: error.message,
    },
    request_id: id,
  };
}

export function ensureApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : internalError(error);
}
