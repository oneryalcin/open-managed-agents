import {
  type ListSessionEventsResponse,
  type ManagedAgentsContentBlock,
  type ManagedAgentsEvent,
  type ManagedAgentsOpaqueContentBlock,
  type ManagedAgentsUserCustomToolResultEventInput,
  type SendSessionEventsRequest,
} from "../../types/events.ts";
import {
  isJsonObject,
  isJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../types/json.ts";
import { invalidRequest, notFound } from "../errors.ts";
import type { SessionStore } from "../sessions/types.ts";
import type { WorkspaceId } from "../workspace.ts";
import { MAX_EVENTS_PER_REQUEST } from "./constants.ts";
import {
  materializePersistedEvents,
  persistAndPublish,
  type EventDraft,
} from "./persist.ts";
import type {
  ListSessionEventsOptions,
  RuntimeCustomToolUseEvent,
  RuntimeEventRunner,
  RuntimeEventTranslator,
  SessionEventBroadcaster,
  SessionEventStore,
  SessionEventsService,
  StreamSessionEventsOptions,
} from "./types.ts";
import { toManagedAgentsEvent } from "./types.ts";

const SUPPORTED_USER_EVENT_TYPES = new Set([
  "user.message",
  "user.custom_tool_result",
  "user.tool_confirmation",
] as const);

export class DefaultSessionEventsService implements SessionEventsService {
  private readonly runtimeRunner: RuntimeEventRunner | undefined;
  private readonly runtimeTranslator: RuntimeEventTranslator | undefined;
  private readonly pendingCustomToolActions = new Map<
    string,
    {
      ids: string[];
      timer: ReturnType<typeof setTimeout> | undefined;
    }
  >();

  constructor(
    private readonly events: SessionEventStore,
    private readonly sessions: SessionStore,
    private readonly broadcaster: SessionEventBroadcaster,
    runtime?: {
      runner: RuntimeEventRunner;
      translate: RuntimeEventTranslator;
    },
  ) {
    this.runtimeRunner = runtime?.runner;
    this.runtimeTranslator = runtime?.translate;
  }

  send(
    workspaceId: WorkspaceId,
    sessionId: string,
    input: unknown,
    opts: { signal?: AbortSignal } = {},
  ): ManagedAgentsEvent[] {
    requireSession(this.sessions, workspaceId, sessionId);
    const req = parseSendRequest(input);
    const customToolResultClaims = this.claimCustomToolResults(
      workspaceId,
      sessionId,
      req.events,
    );
    const now = new Date().toISOString();
    const drafts: EventDraft[] = req.events.map((event) => ({
      type: event.type,
      payload: eventPayload(event),
    }));
    const rows = materializePersistedEvents(sessionId, drafts, now);
    // TODO(idempotency): events.send is non-idempotent in B.2. Add request-level
    // dedupe before B.4 runtime consumers process irreversible actions
    // (notably user.tool_confirmation and user.custom_tool_result).
    persistAndPublish(this.events, this.broadcaster, rows);
    if (customToolResultClaims.length > 0) {
      for (const { customToolUseId } of customToolResultClaims) {
        this.removePendingCustomToolAction(sessionId, customToolUseId);
      }
      this.persistRuntimeDrafts(sessionId, [
        { type: "session.status_running", payload: {} },
      ]);
      for (const { commit } of customToolResultClaims) commit();
      this.flushPendingCustomToolActions(sessionId);
    }
    this.maybeRunRuntimeFromUserMessages(
      workspaceId,
      sessionId,
      req.events,
      opts.signal,
    );
    return rows.map(toManagedAgentsEvent);
  }

  list(
    workspaceId: WorkspaceId,
    sessionId: string,
    opts: ListSessionEventsOptions = {},
  ): ListSessionEventsResponse {
    requireSession(this.sessions, workspaceId, sessionId);
    const page = this.events.listPage(sessionId, opts);
    return {
      data: page.data.map(toManagedAgentsEvent),
      next_page: page.next_page,
    };
  }

  stream(
    workspaceId: WorkspaceId,
    sessionId: string,
    opts: StreamSessionEventsOptions = {},
  ): AsyncIterable<ManagedAgentsEvent> {
    requireSession(this.sessions, workspaceId, sessionId);
    const lastSeenId = this.resolveResumeCursor(sessionId, opts.lastEventId);
    const source = this.broadcaster.subscribe(sessionId, {
      lastSeenId,
      signal: opts.signal,
    });
    return (async function* () {
      for await (const event of source) {
        yield toManagedAgentsEvent(event);
      }
    })();
  }

  private resolveResumeCursor(
    sessionId: string,
    lastEventId: string | undefined,
  ): string | undefined {
    if (lastEventId === undefined || !lastEventId.startsWith("sevt_")) {
      return undefined;
    }
    const cursor = this.events.retrieve(lastEventId);
    if (!cursor || cursor.session_id !== sessionId) {
      return undefined;
    }
    return lastEventId;
  }

  private maybeRunRuntimeFromUserMessages(
    workspaceId: WorkspaceId,
    sessionId: string,
    events: SendSessionEventsRequest["events"],
    signal: AbortSignal | undefined,
  ): void {
    if (!this.runtimeRunner || !this.runtimeTranslator) return;
    const prompts = events
      .filter((event) => event.type === "user.message")
      .map((event) => textFromContent(event.content))
      .filter((text): text is string => text !== undefined);
    if (prompts.length === 0) return;

    void this.runRuntimePrompts(workspaceId, sessionId, prompts, signal);
  }

  private async runRuntimePrompts(
    workspaceId: WorkspaceId,
    sessionId: string,
    prompts: string[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!this.runtimeRunner || !this.runtimeTranslator) return;
    try {
      for (const prompt of prompts) {
        const source = this.runtimeRunner.runUserMessage(
          workspaceId,
          sessionId,
          prompt,
          { signal },
        );
        for await (const piEvent of source) {
          if (isRuntimeCustomToolUseEvent(piEvent)) {
            this.persistCustomToolUse(sessionId, piEvent);
            continue;
          }
          const drafts = this.runtimeTranslator(piEvent, {
            customToolNames: this.runtimeRunner.customToolNames?.(
              workspaceId,
              sessionId,
            ),
          });
          if (drafts.length === 0) continue;
          const now = new Date().toISOString();
          const rows = materializePersistedEvents(sessionId, drafts, now);
          persistAndPublish(this.events, this.broadcaster, rows);
        }
      }
    } catch (error) {
      console.error("runtime ingestion failed", { sessionId, error });
      this.persistRuntimeDrafts(sessionId, [runtimeErrorDraft(error)]);
    }
  }

  private persistRuntimeDrafts(
    sessionId: string,
    drafts: readonly EventDraft[],
  ): void {
    const now = new Date().toISOString();
    const rows = materializePersistedEvents(sessionId, drafts, now);
    persistAndPublish(this.events, this.broadcaster, rows);
  }

  private persistCustomToolUse(
    sessionId: string,
    event: RuntimeCustomToolUseEvent,
  ): void {
    const now = new Date().toISOString();
    const useRows = materializePersistedEvents(
      sessionId,
      [
        {
          type: "agent.custom_tool_use",
          payload: {
            name: event.name,
            input: event.input,
          },
        },
      ],
      now,
    );
    try {
      event.bindCustomToolUseId(useRows[0].id, () => {
        this.removePendingCustomToolAction(sessionId, useRows[0].id);
      });
      persistAndPublish(this.events, this.broadcaster, useRows);
      this.addPendingCustomToolAction(sessionId, useRows[0].id);
    } catch (error) {
      event.rejectCustomToolUse(toError(error));
      throw error;
    }
  }

  private claimCustomToolResults(
    workspaceId: WorkspaceId,
    sessionId: string,
    events: SendSessionEventsRequest["events"],
  ): Array<{ customToolUseId: string; commit: () => void }> {
    const commits: Array<{ customToolUseId: string; commit: () => void }> = [];
    for (const event of events) {
      if (event.type !== "user.custom_tool_result") continue;
      const commit = this.runtimeRunner?.claimCustomToolResult?.(
        workspaceId,
        sessionId,
        event,
      );
      if (!commit && this.runtimeRunner?.claimCustomToolResult) {
        throw notFound(`No pending custom tool call: ${event.custom_tool_use_id}`);
      }
      if (commit) {
        commits.push({
          customToolUseId: event.custom_tool_use_id,
          commit,
        });
      }
    }
    return commits;
  }

  private addPendingCustomToolAction(
    sessionId: string,
    customToolUseId: string,
  ): void {
    let pending = this.pendingCustomToolActions.get(sessionId);
    if (!pending) {
      pending = { ids: [], timer: undefined };
      this.pendingCustomToolActions.set(sessionId, pending);
    }
    pending.ids.push(customToolUseId);
    if (pending.timer) return;
    // Pi may emit parallel custom-tool calls back-to-back in one runtime burst.
    // Defer the idle by one macrotask so those calls coalesce into one
    // requires_action event. If another tool arrives later, we re-emit
    // requires_action with the full remaining pending set.
    pending.timer = setTimeout(() => {
      this.flushPendingCustomToolActions(sessionId);
    }, 0);
  }

  private removePendingCustomToolAction(
    sessionId: string,
    customToolUseId: string,
  ): void {
    const pending = this.pendingCustomToolActions.get(sessionId);
    if (!pending) return;
    pending.ids = pending.ids.filter((id) => id !== customToolUseId);
    if (pending.ids.length === 0 && pending.timer === undefined) {
      this.pendingCustomToolActions.delete(sessionId);
    }
  }

  private flushPendingCustomToolActions(sessionId: string): void {
    const pending = this.pendingCustomToolActions.get(sessionId);
    if (!pending) return;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    if (pending.ids.length === 0) {
      this.pendingCustomToolActions.delete(sessionId);
      return;
    }
    this.persistRuntimeDrafts(sessionId, [
      {
        type: "session.status_idle",
        payload: {
          stop_reason: {
            type: "requires_action",
            event_ids: [...pending.ids],
          },
        },
      },
    ]);
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

function eventPayload(event: SendSessionEventsRequest["events"][number]): JsonObject {
  const { type: _type, ...payload } = event;
  return payload as Record<string, JsonValue>;
}

function optionalBooleanSpread(
  value: unknown,
  field: string,
): { is_error?: boolean } {
  if (value === undefined) return {};
  if (typeof value === "boolean") return { is_error: value };
  throw invalidRequest(`\`${field}\` must be a boolean`);
}

function textFromContent(content: ManagedAgentsContentBlock[]): string | undefined {
  const text = content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function runtimeErrorDraft(error: unknown): EventDraft {
  const message = "Runtime execution failed";
  return {
    type: "session.error",
    payload: { message },
  };
}

function isRuntimeCustomToolUseEvent(
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
