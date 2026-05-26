import type { EventType } from "../../../types/events.ts";
import type { JsonObject } from "../../../types/json.ts";

export interface EventDraft {
  type: EventType;
  payload: JsonObject;
}

interface PiEventBase {
  type?: unknown;
}

interface PiMessageEndEvent extends PiEventBase {
  type: "message_end";
  message?: {
    role?: unknown;
    content?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
  };
}

interface PiToolExecutionEndEvent extends PiEventBase {
  type: "tool_execution_end";
  toolCallId?: unknown;
  toolName?: unknown;
  result?: {
    content?: unknown;
    details?: unknown;
  };
  isError?: unknown;
}

interface PiAgentEndEvent extends PiEventBase {
  type: "agent_end";
  willRetry?: unknown;
}

export function translatePiEvent(input: unknown): EventDraft[] {
  if (!isObject(input)) return [];
  const type = typeof input.type === "string" ? input.type : "";
  if (type === "message_end") {
    return translateMessageEnd(input as unknown as PiMessageEndEvent);
  }
  if (type === "tool_execution_end") {
    return translateToolExecutionEnd(input as unknown as PiToolExecutionEndEvent);
  }
  if (type === "agent_end") {
    return translateAgentEnd(input as unknown as PiAgentEndEvent);
  }
  return [];
}

function translateMessageEnd(event: PiMessageEndEvent): EventDraft[] {
  if (!isObject(event.message)) return [];
  const message = event.message;
  const role = typeof message.role === "string" ? message.role : "";
  if (role !== "assistant") return [];

  const drafts: EventDraft[] = [];
  const blocks = Array.isArray(message.content) ? message.content : [];

  const textBlocks = blocks
    .filter(isObject)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => ({ type: "text", text: b.text as string }));

  if (textBlocks.length > 0) {
    drafts.push({
      type: "agent.message",
      payload: { content: textBlocks },
    });
  }

  for (const block of blocks) {
    if (!isObject(block) || block.type !== "toolCall") continue;
    const toolUseId = typeof block.id === "string" ? block.id : undefined;
    const name = typeof block.name === "string" ? block.name : undefined;
    const args = isObject(block.arguments) ? block.arguments : {};
    if (!toolUseId || !name) continue;
    const payload: JsonObject = {
      tool_use_id: toolUseId,
      name,
      input: args,
    };
    if (typeof block.evaluated_permission === "string") {
      payload.evaluated_permission = block.evaluated_permission;
    }
    drafts.push({ type: "agent.tool_use", payload });
  }

  const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
  if (stopReason === "stop") {
    drafts.push({
      type: "session.status_idle",
      payload: { stop_reason: { type: "end_turn" } },
    });
  } else if (stopReason === "aborted") {
    const payload: JsonObject = { reason: "aborted" };
    if (typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
      payload.error_message = message.errorMessage;
    }
    drafts.push({ type: "session.status_terminated", payload });
  }

  return drafts;
}

function translateToolExecutionEnd(event: PiToolExecutionEndEvent): EventDraft[] {
  const toolUseId =
    typeof event.toolCallId === "string" && event.toolCallId.length > 0
      ? event.toolCallId
      : undefined;
  if (!toolUseId) return [];

  const payload: JsonObject = {
    tool_use_id: toolUseId,
    content: [],
    is_error: event.isError === true,
  };

  if (typeof event.toolName === "string" && event.toolName.length > 0) {
    payload.name = event.toolName;
  }
  if (isObject(event.result)) {
    if (Array.isArray(event.result.content)) {
      payload.content = event.result.content;
    }
    if (isObject(event.result.details) && Object.keys(event.result.details).length > 0) {
      payload.details = event.result.details;
    }
  }

  return [{ type: "agent.tool_result", payload }];
}

function translateAgentEnd(event: PiAgentEndEvent): EventDraft[] {
  // Provisional mapping: C.0 fixtures only observed willRetry=false.
  // Keep this branch explicit (and easy to delete) until a retry trajectory
  // is captured and the event shape is confirmed in fixtures.
  if (event.willRetry === true) {
    return [{ type: "session.status_rescheduled", payload: {} }];
  }
  return [];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
