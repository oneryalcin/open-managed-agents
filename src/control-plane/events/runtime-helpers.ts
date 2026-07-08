import { type ManagedAgentsContentBlock } from "../../types/events.ts";
import { isJsonObject, type JsonObject } from "../../types/json.ts";
import { ApiError } from "../errors.ts";
import type { EventDraft } from "./persist.ts";
import type {
  PendingRuntimeActionRecord,
  RuntimeCustomToolUseEvent,
  RuntimeMcpConnectionFailedEvent,
  RuntimeMcpToolResultEvent,
  RuntimeMcpToolUseEvent,
  RuntimeMcpToolWithModelEndEvent,
  RuntimeToolPermissionUseEvent,
  RuntimeToolPermissionWithModelEndEvent,
} from "./types.ts";

export function leaseExpiresAt(now: string, ttlMs: number): string {
  return new Date(Date.parse(now) + ttlMs).toISOString();
}

export function isRuntimeLeaseExpired(leaseExpiresAtValue: string): boolean {
  return Date.parse(leaseExpiresAtValue) <= Date.now();
}

export function runtimeLeaseRetryDelayMs(leaseExpiresAtValue: string): number {
  return Math.max(0, Date.parse(leaseExpiresAtValue) - Date.now());
}

export function isRuntimeTurnClosed(state: string): boolean {
  return state === "completed" || state === "terminalized";
}

export function actionClosedWithoutResult(
  action: PendingRuntimeActionRecord | undefined,
): boolean {
  return (
    action?.close_reason === "interrupted" ||
    action?.close_reason === "timeout" ||
    action?.close_reason === "terminalized"
  );
}

export function isAcknowledgedInFlightAction(
  action: PendingRuntimeActionRecord | undefined,
): boolean {
  return (
    action?.state === "acknowledged" &&
    !isRuntimeTurnClosed(action.turn.state) &&
    action.close_reason === null
  );
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function runtimeTurnStillOwned(turnId: string): ApiError {
  return new ApiError(
    529,
    "overloaded_error",
    `Runtime turn ${turnId} is still owned by another worker; retry later`,
  );
}

export function textFromContent(
  content: ManagedAgentsContentBlock[],
): string | undefined {
  const text = content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

export function runtimeErrorDraft(error: unknown): EventDraft {
  const message = "Runtime execution failed";
  return {
    type: "session.error",
    payload: { message },
  };
}

export function isRuntimeCustomToolUseEvent(
  event: unknown,
): event is RuntimeCustomToolUseEvent {
  if (!isObjectRecord(event)) return false;
  return (
    event.type === "oma.custom_tool_use" &&
    typeof event.piToolCallId === "string" &&
    typeof event.name === "string" &&
    isJsonObject(event.input) &&
    typeof event.bindCustomToolUseId === "function" &&
    typeof event.rejectCustomToolUse === "function"
  );
}

export function isRuntimeToolPermissionUseEvent(
  event: unknown,
): event is RuntimeToolPermissionUseEvent {
  if (!isObjectRecord(event)) return false;
  return (
    event.type === "oma.tool_permission_use" &&
    typeof event.piToolCallId === "string" &&
    typeof event.name === "string" &&
    isJsonObject(event.input) &&
    (event.evaluatedPermission === "allow" ||
      event.evaluatedPermission === "ask" ||
      event.evaluatedPermission === "deny") &&
    typeof event.bindToolUseId === "function" &&
    typeof event.rejectToolUse === "function"
  );
}

export function isRuntimeToolPermissionWithModelEndEvent(
  event: unknown,
): event is RuntimeToolPermissionWithModelEndEvent {
  if (!isObjectRecord(event)) return false;
  return (
    event.type === "oma.tool_permission_with_model_end" &&
    "messageEnd" in event &&
    isRuntimeToolPermissionUseEvent(event.permissionUse) &&
    Array.isArray(event.suppressedPiToolCallIds) &&
    event.suppressedPiToolCallIds.every((id) => typeof id === "string")
  );
}

export function isRuntimeMcpToolUseEvent(
  event: unknown,
): event is RuntimeMcpToolUseEvent {
  if (!isObjectRecord(event)) return false;
  return (
    event.type === "oma.mcp_tool_use" &&
    typeof event.piToolCallId === "string" &&
    typeof event.mcpServerName === "string" &&
    typeof event.name === "string" &&
    isJsonObject(event.input) &&
    (event.evaluatedPermission === "allow" ||
      event.evaluatedPermission === "ask" ||
      event.evaluatedPermission === "deny") &&
    typeof event.bindToolUseId === "function" &&
    typeof event.rejectToolUse === "function"
  );
}

export function isRuntimeMcpToolWithModelEndEvent(
  event: unknown,
): event is RuntimeMcpToolWithModelEndEvent {
  if (!isObjectRecord(event)) return false;
  return (
    event.type === "oma.mcp_tool_with_model_end" &&
    "messageEnd" in event &&
    isRuntimeMcpToolUseEvent(event.mcpToolUse) &&
    Array.isArray(event.suppressedPiToolCallIds) &&
    event.suppressedPiToolCallIds.every((id) => typeof id === "string")
  );
}

export function isRuntimeMcpToolResultEvent(
  event: unknown,
): event is RuntimeMcpToolResultEvent {
  if (!isObjectRecord(event)) return false;
  return (
    event.type === "oma.mcp_tool_result" &&
    typeof event.mcpToolUseId === "string" &&
    Array.isArray(event.content) &&
    typeof event.isError === "boolean"
  );
}

export function isRuntimeMcpConnectionFailedEvent(
  event: unknown,
): event is RuntimeMcpConnectionFailedEvent {
  if (!isObjectRecord(event)) return false;
  return (
    event.type === "oma.mcp_connection_failed" &&
    typeof event.mcpServerName === "string" &&
    typeof event.message === "string" &&
    (event.retryStatus === "retrying" ||
      event.retryStatus === "exhausted" ||
      event.retryStatus === "terminal")
  );
}

export function hasTerminalIdleDraft(drafts: readonly EventDraft[]): boolean {
  return drafts.some((draft) => {
    if (draft.type !== "session.status_idle") return false;
    const stopReason = draft.payload.stop_reason;
    if (!isJsonObject(stopReason)) return true;
    return stopReason.type !== "requires_action";
  });
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
