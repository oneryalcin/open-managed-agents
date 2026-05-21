import {
  EVENT_TYPES,
  newEventId,
  type ListSessionEventsResponse,
  type ManagedAgentsContentBlock,
  type ManagedAgentsEvent,
  type ManagedAgentsOpaqueContentBlock,
  type ManagedAgentsUserEventInput,
  type SendSessionEventsRequest,
} from "../../types/events.ts";
import { isJsonObject, isJsonValue, type JsonValue } from "../../types/json.ts";
import { invalidRequest, notFound } from "../errors.ts";
import type { SessionStore } from "../sessions/types.ts";
import type { WorkspaceId } from "../workspace.ts";
import type {
  ListSessionEventsOptions,
  PersistedSessionEvent,
  SessionEventStore,
  SessionEventsService,
} from "./types.ts";
import { toManagedAgentsEvent } from "./types.ts";

export const MAX_EVENTS_PER_REQUEST = 200;
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

const SUPPORTED_USER_EVENT_TYPES = new Set([
  "user.message",
  "user.custom_tool_result",
  "user.tool_confirmation",
] as const);

const ALL_EVENT_TYPES = new Set<string>(EVENT_TYPES);

export class DefaultSessionEventsService implements SessionEventsService {
  constructor(
    private readonly events: SessionEventStore,
    private readonly sessions: SessionStore,
  ) {}

  send(
    workspaceId: WorkspaceId,
    sessionId: string,
    input: unknown,
  ): ManagedAgentsEvent[] {
    requireSession(this.sessions, workspaceId, sessionId);
    const req = parseSendRequest(input);
    const now = new Date().toISOString();
    const rows = req.events.map((event) =>
      toPersistedEvent(sessionId, event, now),
    );
    // TODO(idempotency): events.send is non-idempotent in B.2. Add request-level
    // dedupe before B.4 runtime consumers process irreversible actions
    // (notably user.tool_confirmation and user.custom_tool_result).
    this.events.appendBatch(rows);
    return rows.map(toManagedAgentsEvent);
  }

  list(
    workspaceId: WorkspaceId,
    sessionId: string,
    opts: ListSessionEventsOptions = {},
  ): ListSessionEventsResponse {
    requireSession(this.sessions, workspaceId, sessionId);
    const types = opts.types ?? [];
    if (types.length > 0 && types.some((type) => !ALL_EVENT_TYPES.has(type))) {
      return { data: [], next_page: null };
    }
    const page = this.events.listPage(sessionId, opts);
    return {
      data: page.data.map(toManagedAgentsEvent),
      next_page: page.next_page,
    };
  }
}

function requireSession(
  store: SessionStore,
  workspaceId: WorkspaceId,
  sessionId: string,
): void {
  if (!store.retrieve(workspaceId, sessionId)) {
    throw notFound(`Session ${sessionId} not found`);
  }
}

function parseSendRequest(input: unknown): SendSessionEventsRequest {
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
  return { events };
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
      `\`events[${index}].type\` must be one of user.message, user.custom_tool_result, user.tool_confirmation`,
    );
  }
  if (!isJsonValue(event)) {
    throw invalidRequest(`\`events[${index}]\` must be JSON-compatible`);
  }
  if (type === "user.message") {
    const content = parseContentArray(event.content, `events[${index}].content`);
    return { type: "user.message", content };
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

function toPersistedEvent(
  sessionId: string,
  event: ManagedAgentsUserEventInput,
  now: string,
): PersistedSessionEvent {
  const { type, ...payload } = event;
  const payloadJson = JSON.stringify(payload);
  if (new TextEncoder().encode(payloadJson).byteLength > MAX_EVENT_PAYLOAD_BYTES) {
    throw invalidRequest(
      `Serialized event payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes`,
    );
  }
  return {
    id: newEventId(),
    session_id: sessionId,
    type,
    processed_at: now,
    payload: payload as Record<string, JsonValue>,
    created_at: now,
  };
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!isJsonObject(input)) {
    throw invalidRequest("Request body must be a JSON object");
  }
  return input;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw invalidRequest(`\`${field}\` must be a non-empty string`);
}
