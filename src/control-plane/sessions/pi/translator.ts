import type { EventType } from "../../../types/events.ts";
import type { JsonObject } from "../../../types/json.ts";
import type { RuntimeTranslatorContext } from "../../events/types.ts";

export interface EventDraft {
  type: EventType;
  payload: JsonObject;
}

export function translatePiEvent(
  input: unknown,
  context: RuntimeTranslatorContext = {},
): EventDraft[] {
  if (!isObject(input)) return [];
  const type = typeof input.type === "string" ? input.type : "";
  if (type === "agent_start") {
    return [{ type: "session.status_running", payload: {} }];
  }
  if (type === "message_end") {
    return translateMessageEnd(input, context);
  }
  if (type === "tool_execution_end") {
    return translateToolExecutionEnd(input, context);
  }
  if (type === "agent_end") {
    return translateAgentEnd(input);
  }
  return [];
}

function translateMessageEnd(
  event: JsonObject,
  context: RuntimeTranslatorContext,
): EventDraft[] {
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
    if (context.customToolNames?.has(name)) continue;
    if (context.suppressPiToolUse?.(toolUseId) === true) continue;
    // ADR 0011: event IDs stay server-assigned sevt_*; Pi's toolu_* remains
    // payload correlation data and inbound handling translates as needed.
    const payload: JsonObject = {
      tool_use_id: toolUseId,
      name,
      input: args,
    };
    drafts.push({ type: "agent.tool_use", payload });
  }

  return drafts;
}

function translateToolExecutionEnd(
  event: JsonObject,
  context: RuntimeTranslatorContext,
): EventDraft[] {
  const toolName =
    typeof event.toolName === "string" && event.toolName.length > 0
      ? event.toolName
      : undefined;
  if (toolName && context.customToolNames?.has(toolName)) return [];

  const toolUseId =
    typeof event.toolCallId === "string" && event.toolCallId.length > 0
      ? event.toolCallId
      : undefined;
  if (!toolUseId) return [];

  const payload: JsonObject = {
    tool_use_id:
      context.publicToolUseIdForPiToolCallId?.(toolUseId) ?? toolUseId,
    content: [],
    is_error: event.isError === true,
  };

  if (isObject(event.result)) {
    if (Array.isArray(event.result.content)) {
      payload.content = event.result.content;
    }
  }

  return [{ type: "agent.tool_result", payload }];
}

function translateAgentEnd(event: JsonObject): EventDraft[] {
  // Provisional mapping: C.0 fixtures only observed willRetry=false.
  // Keep this branch explicit (and easy to delete) until a retry trajectory
  // is captured and the event shape is confirmed in fixtures.
  if (event.willRetry === true) {
    return [{ type: "session.status_rescheduled", payload: {} }];
  }
  return [
    {
      type: "session.status_idle",
      payload: { stop_reason: { type: "end_turn" } },
    },
  ];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
