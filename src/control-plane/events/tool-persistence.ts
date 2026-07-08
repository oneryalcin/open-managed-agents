import { type JsonValue } from "../../types/json.ts";
import type { WorkspaceId } from "../workspace.ts";
import { materializePersistedEvents } from "./persist.ts";
import type {
  EventStoreRuntimeChanges,
  PendingRuntimeActionRecord,
  PersistedSessionEvent,
  RuntimeMcpConnectionFailedEvent,
  RuntimeMcpToolResultEvent,
  RuntimeMcpToolUseEvent,
  RuntimeToolPermissionUseEvent,
} from "./types.ts";

export function materializeToolPermissionUseRows(
  input: {
    workspaceId: WorkspaceId;
    sessionId: string;
    event: RuntimeToolPermissionUseEvent;
    now: string;
    onReleased: (
      toolUseId: string,
      reason: PendingRuntimeActionRecord["close_reason"] | undefined,
    ) => void;
  },
): PersistedSessionEvent[] {
  const useRows = materializePersistedEvents(
    input.workspaceId,
    input.sessionId,
    [
      {
        type: "agent.tool_use",
        payload: {
          name: input.event.name,
          input: input.event.input,
          evaluated_permission: input.event.evaluatedPermission,
        },
      },
    ],
    input.now,
  );
  input.event.bindToolUseId(useRows[0].id, (reason) => {
    input.onReleased(useRows[0].id, reason);
  });
  return useRows;
}

export function materializeMcpToolUseRows(
  input: {
    workspaceId: WorkspaceId;
    sessionId: string;
    event: RuntimeMcpToolUseEvent;
    now: string;
    onReleased: (
      toolUseId: string,
      reason: PendingRuntimeActionRecord["close_reason"] | undefined,
    ) => void;
  },
): PersistedSessionEvent[] {
  const useRows = materializePersistedEvents(
    input.workspaceId,
    input.sessionId,
    [
      {
        type: "agent.mcp_tool_use",
        payload: {
          mcp_server_name: input.event.mcpServerName,
          name: input.event.name,
          input: input.event.input,
          evaluated_permission: input.event.evaluatedPermission,
          // Probe 47 wire parity: hosted emits null outside subagent threads.
          session_thread_id: null,
        },
      },
    ],
    input.now,
  );
  input.event.bindToolUseId(useRows[0].id, (reason) => {
    input.onReleased(useRows[0].id, reason);
  });
  return useRows;
}

export function toolPermissionRuntimeChanges(
  input: {
    workspaceId: WorkspaceId;
    sessionId: string;
    turnId: string;
    ownerId: string;
    ownerGeneration: number;
    evaluatedPermission: "allow" | "ask" | "deny";
    toolUseId: string;
    now: string;
  },
): Pick<EventStoreRuntimeChanges, "openedActions" | "turnStates"> {
  return {
    openedActions:
      input.evaluatedPermission === "ask"
        ? [
            {
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: input.turnId,
              actionId: input.toolUseId,
              actionType: "tool_confirmation",
              now: input.now,
            },
          ]
        : [],
    turnStates:
      input.evaluatedPermission === "ask"
        ? [
            {
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: input.turnId,
              ownerId: input.ownerId,
              ownerGeneration: input.ownerGeneration,
              state: "paused",
              now: input.now,
            },
          ]
        : [
            {
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: input.turnId,
              ownerId: input.ownerId,
              ownerGeneration: input.ownerGeneration,
              state: "running",
              now: input.now,
            },
          ],
  };
}

export function materializeMcpToolResultRows(
  input: {
    workspaceId: WorkspaceId;
    sessionId: string;
    event: RuntimeMcpToolResultEvent;
    now: string;
  },
): PersistedSessionEvent[] {
  return materializePersistedEvents(
    input.workspaceId,
    input.sessionId,
    [
      {
        type: "agent.mcp_tool_result",
        payload: {
          mcp_tool_use_id: input.event.mcpToolUseId,
          content: input.event.content as unknown as JsonValue,
          is_error: input.event.isError,
        },
      },
    ],
    input.now,
  );
}

export function materializeMcpConnectionFailedRows(
  input: {
    workspaceId: WorkspaceId;
    sessionId: string;
    event: RuntimeMcpConnectionFailedEvent;
    now: string;
  },
): PersistedSessionEvent[] {
  return materializePersistedEvents(
    input.workspaceId,
    input.sessionId,
    [
      {
        type: "session.error",
        payload: {
          error: {
            type: "mcp_connection_failed_error",
            mcp_server_name: input.event.mcpServerName,
            message: input.event.message,
            retry_status: { type: input.event.retryStatus },
          },
        },
      },
    ],
    input.now,
  );
}
