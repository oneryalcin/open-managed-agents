import type { EventType } from "../../../types/events.ts";
import type { JsonObject } from "../../../types/json.ts";

export interface EventDraft {
  type: EventType;
  payload: JsonObject;
}

export function translatePiEvent(input: unknown): EventDraft[] {
  if (!isObject(input)) return [];
  const type = typeof input.type === "string" ? input.type : "";
  if (type === "message_end") {
    return translateMessageEnd(input);
  }
  if (type === "tool_execution_end") {
    return translateToolExecutionEnd(input);
  }
  if (type === "agent_end") {
    return translateAgentEnd(input);
  }
  return [];
}

function translateMessageEnd(event: JsonObject): EventDraft[] {
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
    // Open C.2/D decision: keep Pi's toolu_* correlation key in payload as
    // tool_use_id while event IDs remain server-assigned sevt_*.
    // The final correlation-id model (uniform sevt_* + inbound translation
    // vs. toolu_* as event id for tool-use events) is resolved with runtime
    // ingestion + custom-tool round-trip wiring.
    const payload: JsonObject = {
      tool_use_id: toolUseId,
      name,
      input: args,
    };
    drafts.push({ type: "agent.tool_use", payload });
  }

  const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
  if (stopReason === "stop") {
    drafts.push({
      type: "session.status_idle",
      payload: { stop_reason: { type: "end_turn" } },
    });
  } else if (stopReason === "aborted") {
    // C.0 evidence: aborted is visible in-band via message.stopReason.
    // MVP wire shape has no distinct "interrupted" stop_reason variant, so
    // this currently maps to the same idle/end_turn payload as normal stop.
    drafts.push({
      type: "session.status_idle",
      payload: { stop_reason: { type: "end_turn" } },
    });
  }

  return drafts;
}

function translateToolExecutionEnd(event: JsonObject): EventDraft[] {
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
  return [];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
