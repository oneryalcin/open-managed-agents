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
import type { SessionRow, SessionStore } from "../sessions/types.ts";
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
  "user.interrupt",
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
  private readonly closedSessions = new Set<string>();
  private readonly deletedSessions = new Set<string>();
  private readonly activeRuntimeTasks = new Map<string, number>();
  private readonly interruptedCustomToolActions = new Map<string, Set<string>>();
  private readonly archivingSessions = new Map<string, number>();

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
    if (this.isArchivingSession(workspaceId, sessionId)) {
      throw notFound(`Session ${sessionId} not found`);
    }
    requireActiveSession(this.sessions, workspaceId, sessionId);
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
    this.maybeInterruptRuntime(workspaceId, sessionId, req.events);
    return rows.map(toManagedAgentsEvent);
  }

  private maybeInterruptRuntime(
    workspaceId: WorkspaceId,
    sessionId: string,
    events: SendSessionEventsRequest["events"],
  ): void {
    if (!events.some((event) => event.type === "user.interrupt")) return;
    this.blockInterruptedCustomToolActions(
      sessionId,
      this.clearPendingCustomToolActions(sessionId),
    );
    void Promise.resolve(
      this.runtimeRunner?.interruptSession?.(workspaceId, sessionId),
    ).catch((error) => {
      console.error("runtime session interrupt failed", { sessionId, error });
    });
  }

  archiveSessionRowAfterPreflight(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): SessionRow {
    this.assertSessionArchivable(workspaceId, sessionId);
    this.incrementArchivingSession(workspaceId, sessionId);
    try {
      const archivedAt = new Date().toISOString();
      const row = this.sessions.archive(workspaceId, sessionId, archivedAt);
      if (!row) {
        throw notFound(`Session ${sessionId} not found`);
      }
      return row;
    } finally {
      this.decrementArchivingSession(workspaceId, sessionId);
    }
  }

  private assertSessionArchivable(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): void {
    const session = requireExistingSession(this.sessions, workspaceId, sessionId);
    if (session.archived_at !== null || session.status === "terminated") return;
    if (
      (this.activeRuntimeTasks.get(sessionId) ?? 0) > 0 &&
      !this.hasPendingCustomToolActions(sessionId)
    ) {
      throw sessionNotArchivable(sessionId, "running");
    }
    if (session.status === "running" || session.status === "rescheduling") {
      throw sessionNotArchivable(sessionId, session.status);
    }
  }

  private isArchivingSession(workspaceId: WorkspaceId, sessionId: string): boolean {
    return (
      (this.archivingSessions.get(archiveGuardKey(workspaceId, sessionId)) ?? 0) >
      0
    );
  }

  private incrementArchivingSession(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): void {
    const key = archiveGuardKey(workspaceId, sessionId);
    this.archivingSessions.set(key, (this.archivingSessions.get(key) ?? 0) + 1);
  }

  private decrementArchivingSession(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): void {
    const key = archiveGuardKey(workspaceId, sessionId);
    const remaining = (this.archivingSessions.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.archivingSessions.set(key, remaining);
      return;
    }
    this.archivingSessions.delete(key);
  }

  async archiveSession(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void> {
    requireExistingSession(this.sessions, workspaceId, sessionId);
    this.closedSessions.add(sessionId);
    this.clearPendingCustomToolActions(sessionId);
    this.interruptedCustomToolActions.delete(sessionId);
    if (!this.hasSessionEvent(sessionId, "session.status_terminated")) {
      this.persistLifecycleDrafts(sessionId, [
        { type: "session.status_terminated", payload: {} },
      ]);
    }
    await this.closeRuntimeBestEffort(workspaceId, sessionId);
    this.retireLifecycleGuardsIfIdle(sessionId);
  }

  async deleteSession(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void> {
    this.closedSessions.add(sessionId);
    this.clearPendingCustomToolActions(sessionId);
    this.interruptedCustomToolActions.delete(sessionId);
    this.persistLifecycleDrafts(sessionId, [
      { type: "session.deleted", payload: {} },
    ]);
    this.broadcaster.closeSession(sessionId);
    this.deletedSessions.add(sessionId);
    await this.closeRuntimeBestEffort(workspaceId, sessionId);
    this.events.deleteForSession(sessionId);
    this.retireLifecycleGuardsIfIdle(sessionId);
  }

  private async closeRuntimeBestEffort(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void> {
    try {
      await this.runtimeRunner?.closeSession?.(workspaceId, sessionId);
    } catch (error) {
      console.error("runtime session cleanup failed", { sessionId, error });
    }
  }

  private hasSessionEvent(sessionId: string, type: string): boolean {
    return this.events.list(sessionId, { limit: 1, types: [type] }).length > 0;
  }

  list(
    workspaceId: WorkspaceId,
    sessionId: string,
    opts: ListSessionEventsOptions = {},
  ): ListSessionEventsResponse {
    requireExistingSession(this.sessions, workspaceId, sessionId);
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
    const session = requireExistingSession(this.sessions, workspaceId, sessionId);
    const lastSeenId = this.resolveResumeCursor(sessionId, opts.lastEventId);
    if (session.archived_at !== null || session.status === "terminated") {
      return this.replayClosedSession(sessionId, lastSeenId, opts.signal);
    }
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

  private replayClosedSession(
    sessionId: string,
    lastSeenId: string | undefined,
    signal: AbortSignal | undefined,
  ): AsyncIterable<ManagedAgentsEvent> {
    const events = this.events;
    return (async function* () {
      let cursor = lastSeenId;
      while (!(signal?.aborted ?? false)) {
        const rows = events.list(sessionId, {
          afterId: cursor,
          limit: 500,
        });
        if (rows.length === 0) return;
        for (const row of rows) {
          if (signal?.aborted ?? false) return;
          cursor = row.id;
          yield toManagedAgentsEvent(row);
        }
        if (rows.length < 500) return;
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

    this.beginRuntimeTask(sessionId);
    void this.runRuntimePrompts(workspaceId, sessionId, prompts, signal)
      .finally(() => {
        this.finishRuntimeTask(sessionId);
      });
  }

  private beginRuntimeTask(sessionId: string): void {
    this.activeRuntimeTasks.set(
      sessionId,
      (this.activeRuntimeTasks.get(sessionId) ?? 0) + 1,
    );
  }

  private finishRuntimeTask(sessionId: string): void {
    const remaining = (this.activeRuntimeTasks.get(sessionId) ?? 1) - 1;
    if (remaining > 0) {
      this.activeRuntimeTasks.set(sessionId, remaining);
      return;
    }
    this.activeRuntimeTasks.delete(sessionId);
    this.interruptedCustomToolActions.delete(sessionId);
    this.retireLifecycleGuardsIfIdle(sessionId);
  }

  private retireLifecycleGuardsIfIdle(sessionId: string): void {
    if ((this.activeRuntimeTasks.get(sessionId) ?? 0) > 0) return;
    this.closedSessions.delete(sessionId);
    this.deletedSessions.delete(sessionId);
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
          if (this.closedSessions.has(sessionId)) return;
          if (this.deletedSessions.has(sessionId)) return;
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
    if (this.closedSessions.has(sessionId)) return;
    if (this.deletedSessions.has(sessionId)) return;
    this.persistLifecycleDrafts(sessionId, drafts);
  }

  private persistLifecycleDrafts(
    sessionId: string,
    drafts: readonly EventDraft[],
  ): void {
    if (this.deletedSessions.has(sessionId)) return;
    const now = new Date().toISOString();
    const rows = materializePersistedEvents(sessionId, drafts, now);
    persistAndPublish(this.events, this.broadcaster, rows);
  }

  private persistCustomToolUse(
    sessionId: string,
    event: RuntimeCustomToolUseEvent,
  ): void {
    if (this.closedSessions.has(sessionId)) return;
    if (this.deletedSessions.has(sessionId)) return;
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
    let interruptedInBatch = false;
    for (const event of events) {
      if (event.type === "user.interrupt") {
        interruptedInBatch = true;
        continue;
      }
      if (event.type !== "user.custom_tool_result") continue;
      if (
        interruptedInBatch ||
        this.interruptedCustomToolActions
          .get(sessionId)
          ?.has(event.custom_tool_use_id) === true
      ) {
        throw notFound(`No pending custom tool call: ${event.custom_tool_use_id}`);
      }
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

  private clearPendingCustomToolActions(sessionId: string): string[] {
    const pending = this.pendingCustomToolActions.get(sessionId);
    if (!pending) return [];
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingCustomToolActions.delete(sessionId);
    return [...pending.ids];
  }

  private hasPendingCustomToolActions(sessionId: string): boolean {
    return (this.pendingCustomToolActions.get(sessionId)?.ids.length ?? 0) > 0;
  }

  private blockInterruptedCustomToolActions(
    sessionId: string,
    customToolUseIds: readonly string[],
  ): void {
    if (customToolUseIds.length === 0) return;
    let blocked = this.interruptedCustomToolActions.get(sessionId);
    if (!blocked) {
      blocked = new Set<string>();
      this.interruptedCustomToolActions.set(sessionId, blocked);
    }
    for (const id of customToolUseIds) blocked.add(id);
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

function requireActiveSession(
  store: SessionStore,
  workspaceId: WorkspaceId,
  sessionId: string,
): void {
  if (!store.retrieve(workspaceId, sessionId)) {
    throw notFound(`Session ${sessionId} not found`);
  }
}

function requireExistingSession(
  store: SessionStore,
  workspaceId: WorkspaceId,
  sessionId: string,
): SessionRow {
  const session = store.retrieveAny(workspaceId, sessionId);
  if (!session) {
    throw notFound(`Session ${sessionId} not found`);
  }
  return session;
}

function sessionNotArchivable(
  sessionId: string,
  status: "running" | "rescheduling",
): Error {
  return invalidRequest(
    `Session ${sessionId} cannot be archived while its status is "${status}". Only pending or idle sessions may be archived.`,
  );
}

function archiveGuardKey(workspaceId: WorkspaceId, sessionId: string): string {
  return JSON.stringify([workspaceId, sessionId]);
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
  rejectMixedInterruptAndMessage(events);
  return { events };
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
