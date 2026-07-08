import {
  type ManagedAgentsContentBlock,
  type ManagedAgentsEvent,
  type ManagedAgentsOpaqueContentBlock,
  type ManagedAgentsUserCustomToolResultEventInput,
  type ManagedAgentsUserToolConfirmationEventInput,
  type SendSessionEventsRequest,
} from "../../types/events.ts";
import {
  isJsonObject,
  isJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../types/json.ts";
import { invalidRequest } from "../errors.ts";
import { MAX_EVENTS_PER_REQUEST } from "./constants.ts";
import { toManagedAgentsEvent, type PersistedSessionEvent } from "./types.ts";

const SUPPORTED_USER_EVENT_TYPES = new Set([
  "user.message",
  "user.interrupt",
  "user.custom_tool_result",
  "user.tool_confirmation",
] as const);

export function parseSendRequest(input: unknown): SendSessionEventsRequest {
  const obj = objectInput(input);
  const value = obj.events;
  if (!Array.isArray(value)) {
    throw invalidRequest("`events` must be a non-empty array");
  }
  if (value.length === 0) {
    throw invalidRequest("`events` must be a non-empty array");
  }
  if (value.length > MAX_EVENTS_PER_REQUEST) {
    throw invalidRequest(
      `\`events\` must contain at most ${MAX_EVENTS_PER_REQUEST} items`,
    );
  }
  const events = value.map((item, index) => parseUserEvent(item, index));
  rejectMixedInterruptAndMessage(events);
  return { events };
}

export function eventPayload(
  event: SendSessionEventsRequest["events"][number],
): JsonObject {
  const { type: _type, ...payload } = event;
  return payload as Record<string, JsonValue>;
}

export function toSendResponseEvent(
  row: PersistedSessionEvent | undefined,
): ManagedAgentsEvent {
  if (!row) throw new Error("Persisted event row missing");
  const event = toManagedAgentsEvent(row);
  if (row.type === "user.tool_confirmation") {
    return { ...event, processed_at: null };
  }
  return event;
}

export function sameToolConfirmation(
  completed: {
    result: "allow" | "deny";
    denyMessage?: string | null;
  },
  event: ManagedAgentsUserToolConfirmationEventInput,
): boolean {
  return (
    completed.result === event.result &&
    (completed.denyMessage ?? null) === (event.deny_message ?? null)
  );
}

export function sameCustomToolResult(
  left: ManagedAgentsUserCustomToolResultEventInput,
  right: ManagedAgentsUserCustomToolResultEventInput,
): boolean {
  return (
    left.custom_tool_use_id === right.custom_tool_use_id &&
    JSON.stringify(left.content ?? null) === JSON.stringify(right.content ?? null) &&
    (left.is_error ?? false) === (right.is_error ?? false)
  );
}

export function sameCustomToolResultPayload(
  payload: JsonObject,
  event: ManagedAgentsUserCustomToolResultEventInput,
): boolean {
  return (
    payload.custom_tool_use_id === event.custom_tool_use_id &&
    JSON.stringify(payload.content ?? null) === JSON.stringify(event.content ?? null) &&
    (payload.is_error ?? false) === (event.is_error ?? false)
  );
}

export function hasToolResultForToolUseId(
  rows: readonly PersistedSessionEvent[],
  toolUseId: string,
): boolean {
  return rows.some(
    (row) =>
      (row.type === "agent.tool_result" &&
        row.payload.tool_use_id === toolUseId) ||
      (row.type === "agent.mcp_tool_result" &&
        row.payload.mcp_tool_use_id === toolUseId),
  );
}

export function lostToolConfirmationPayload(toolUseId: string): JsonObject {
  return {
    tool_use_id: toolUseId,
    content: [
      {
        type: "text",
        text: `Tool confirmation ${toolUseId} was accepted, but runtime state is no longer available and the builtin tool execution outcome is unknown.`,
      },
    ],
    is_error: true,
  };
}

export function lostMcpToolConfirmationPayload(toolUseId: string): JsonObject {
  return {
    mcp_tool_use_id: toolUseId,
    content: [
      {
        type: "text",
        text: `Tool confirmation ${toolUseId} was accepted, but runtime state is no longer available and the MCP tool execution outcome is unknown.`,
      },
    ],
    is_error: true,
  };
}

export function objectInput(input: unknown): Record<string, unknown> {
  if (!isJsonObject(input)) {
    throw invalidRequest("Request body must be a JSON object");
  }
  return input;
}

export function nonEmptyString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw invalidRequest(`\`${field}\` must be a non-empty string`);
}

function rejectMixedInterruptAndMessage(
  events: readonly SendSessionEventsRequest["events"][number][],
): void {
  const hasInterrupt = events.some((event) => event.type === "user.interrupt");
  if (!hasInterrupt) return;
  const hasMessage = events.some((event) => event.type === "user.message");
  if (!hasMessage) return;
  throw invalidRequest(
    "`events` cannot mix user.interrupt and user.message in one request",
  );
}

function parseUserEvent(
  input: unknown,
  index: number,
): SendSessionEventsRequest["events"][number] {
  const event = objectInput(input);
  if ("session_id" in event) {
    throw invalidRequest(
      `\`events[${index}].session_id\` is not allowed; session ID comes from the URL path`,
    );
  }
  const type = nonEmptyString(event.type, `events[${index}].type`);
  if (!SUPPORTED_USER_EVENT_TYPES.has(type as never)) {
    throw invalidRequest(
      `\`events[${index}].type\` must be one of user.message, user.interrupt, user.custom_tool_result, user.tool_confirmation`,
    );
  }
  if (!isJsonValue(event)) {
    throw invalidRequest(`\`events[${index}]\` must be JSON-compatible`);
  }
  if (type === "user.message") {
    const content = parseContentArray(event.content, `events[${index}].content`);
    return { type: "user.message", content };
  }
  if (type === "user.interrupt") {
    return { type: "user.interrupt" };
  }
  if (type === "user.custom_tool_result") {
    const customToolUseId = nonEmptyString(
      event.custom_tool_use_id,
      `events[${index}].custom_tool_use_id`,
    );
    const contentValue = event.content;
    return {
      type: "user.custom_tool_result",
      custom_tool_use_id: customToolUseId,
      ...(contentValue === undefined
        ? {}
        : {
            content: parseContentArray(
              contentValue,
              `events[${index}].content`,
            ),
          }),
      ...optionalBooleanSpread(event.is_error, `events[${index}].is_error`),
    };
  }
  const toolUseId = nonEmptyString(
    event.tool_use_id,
    `events[${index}].tool_use_id`,
  );
  const result = event.result;
  if (result !== "allow" && result !== "deny") {
    throw invalidRequest(
      `\`events[${index}].result\` must be \`allow\` or \`deny\``,
    );
  }
  const denyMessage = event.deny_message;
  if (result === "allow" && denyMessage !== undefined) {
    throw invalidRequest(
      `\`events[${index}].deny_message\` is only valid when result is \`deny\``,
    );
  }
  if (
    result === "deny" &&
    denyMessage !== undefined &&
    denyMessage !== null &&
    typeof denyMessage !== "string"
  ) {
    throw invalidRequest(
      `\`events[${index}].deny_message\` must be a string or null`,
    );
  }
  const normalizedDenyMessage =
    denyMessage === undefined || denyMessage === null || typeof denyMessage === "string"
      ? denyMessage
      : undefined;
  return {
    type: "user.tool_confirmation",
    tool_use_id: toolUseId,
    result,
    ...(normalizedDenyMessage === undefined
      ? {}
      : { deny_message: normalizedDenyMessage }),
  };
}

function parseContentArray(
  input: unknown,
  field: string,
): ManagedAgentsContentBlock[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidRequest(`\`${field}\` must be a non-empty array`);
  }
  return input.map((block, index) => parseContentBlock(block, `${field}[${index}]`));
}

function parseContentBlock(
  input: unknown,
  field: string,
): ManagedAgentsContentBlock {
  const block = objectInput(input);
  if (!isJsonValue(block)) {
    throw invalidRequest(`\`${field}\` must be JSON-compatible`);
  }
  const type = nonEmptyString(block.type, `${field}.type`);
  if (type === "text") {
    return {
      type,
      text: nonEmptyString(block.text, `${field}.text`),
    };
  }
  return block as ManagedAgentsOpaqueContentBlock;
}

function optionalBooleanSpread(
  value: unknown,
  field: string,
): { is_error?: boolean } {
  if (value === undefined) return {};
  if (typeof value === "boolean") return { is_error: value };
  throw invalidRequest(`\`${field}\` must be a boolean`);
}
