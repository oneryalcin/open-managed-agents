import { describe, expect, it } from "vitest";
import {
  createControlPlaneApp,
  createInMemoryControlPlaneApp,
} from "./helpers.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type {
  ManagedAgentsUserCustomToolResultEventInput,
  ManagedAgentsUserToolConfirmationEventInput,
} from "../../types/events.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";
import type {
  RuntimeCustomToolUseEvent,
  RuntimeEventRunner,
  RuntimeToolPermissionUseEvent,
} from "../events/types.ts";
import { DefaultAgentService } from "../agents/service.ts";
import { SqliteAgentStore } from "../agents/store.ts";
import { DefaultEnvironmentService } from "../environments/service.ts";
import { SqliteEnvironmentStore } from "../environments/store.ts";
import { SessionEventBroadcaster } from "../events/broadcaster.ts";
import { materializePersistedEvents } from "../events/persist.ts";
import { DefaultSessionEventsService } from "../events/service.ts";
import { EventStore } from "../events/store.ts";
import { translatePiEvent } from "../sessions/pi/translator.ts";
import { DefaultSessionService } from "../sessions/service.ts";
import { SqliteSessionStore } from "../sessions/store.ts";
import { STREAM_TEST_TIMEOUT_MS, hasTimedOut } from "./test-timeouts.ts";

const VALID_AGENT = {
  name: "Tool Confirmation Agent",
  model: "claude-opus-4-7",
  tools: [
    {
      type: "agent_toolset_20260401",
      default_config: { permission_policy: { type: "always_ask" } },
    },
  ],
};

const VALID_ENVIRONMENT = {
  name: "Tool Confirmation Environment",
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
  },
};

describe("builtin tool confirmations", () => {
  it("emits requires_action, accepts allow, and resumes with a public tool_result", async () => {
    const runner = new FakeToolPermissionRunner("ask");
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: translatePiEvent },
    });
    const session = await setupSession(app);

    await sendMessage(app, session.id, "write a file");
    const waiting = await eventuallyEvents(
      app,
      session.id,
      (events) =>
        events.some((event) => event.type === "agent.tool_use") &&
        events.some(
          (event) =>
            event.type === "session.status_idle" &&
            (event.stop_reason as { type?: unknown } | undefined)?.type ===
              "requires_action",
        ),
    );

    const toolUse = waiting.find((event) => event.type === "agent.tool_use");
    expect(toolUse?.id).toEqual(expect.stringMatching(/^sevt_/));
    expect(toolUse).toMatchObject({
      name: "bash",
      input: { command: "touch /workspace/probe" },
      evaluated_permission: "ask",
    });
    expect(toolUse).not.toHaveProperty("tool_use_id");
    expect(runner.boundToolUseId).toBe(toolUse?.id);

    const requiresAction = waiting.find(
      (event) =>
        event.type === "session.status_idle" &&
        (event.stop_reason as { type?: unknown } | undefined)?.type ===
          "requires_action",
    );
    expect(requiresAction?.stop_reason).toEqual({
      type: "requires_action",
      event_ids: [toolUse?.id],
    });

    const confirmation = await sendToolConfirmation(app, session.id, {
      type: "user.tool_confirmation",
      tool_use_id: toolUse?.id as string,
      result: "allow",
    });
    expect(confirmation.id).toEqual(expect.stringMatching(/^sevt_/));
    expect(confirmation.processed_at).toBe(null);

    const completed = await eventuallyEvents(
      app,
      session.id,
      (events) => events.some((event) => event.type === "agent.tool_result"),
    );
    const toolResult = completed.find((event) => event.type === "agent.tool_result");
    expect(toolResult).toMatchObject({
      tool_use_id: toolUse?.id,
      is_error: false,
    });

    const persistedConfirmation = completed.find(
      (event) => event.id === confirmation.id,
    );
    expect(persistedConfirmation?.processed_at).toEqual(expect.any(String));

    const replay = await sendToolConfirmation(app, session.id, {
      type: "user.tool_confirmation",
      tool_use_id: toolUse?.id as string,
      result: "allow",
    });
    expect(replay.id).toBe(confirmation.id);
    expect(replay.processed_at).toBe(null);

    const conflict = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "user.tool_confirmation",
            tool_use_id: toolUse?.id,
            result: "deny",
            deny_message: "changed",
          },
        ],
      }),
    });
    expect(conflict.status).toBe(400);
  });

  it("accepts deny without executing the builtin and publishes an error result", async () => {
    const runner = new FakeToolPermissionRunner("ask");
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: translatePiEvent },
    });
    const session = await setupSession(app);

    await sendMessage(app, session.id, "delete the repo");
    const waiting = await eventuallyEvents(
      app,
      session.id,
      (events) => events.some((event) => event.type === "agent.tool_use"),
    );
    const toolUse = waiting.find((event) => event.type === "agent.tool_use");

    const confirmation = await sendToolConfirmation(app, session.id, {
      type: "user.tool_confirmation",
      tool_use_id: toolUse?.id as string,
      result: "deny",
      deny_message: "not safe",
    });
    expect(confirmation.processed_at).toBe(null);

    const completed = await eventuallyEvents(
      app,
      session.id,
      (events) => events.some((event) => event.type === "agent.tool_result"),
    );
    expect(completed.find((event) => event.type === "agent.tool_result")).toMatchObject({
      tool_use_id: toolUse?.id,
      is_error: true,
    });
  });

  it("rejects oversized builtin tool permission events without leaving the runtime waiting", async () => {
    const runner = new OversizedToolPermissionRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: translatePiEvent },
    });
    const session = await setupSession(app);

    await sendMessage(app, session.id, "large input");
    const events = await eventuallyEvents(
      app,
      session.id,
      (rows) => rows.some((event) => event.type === "session.error"),
    );

    expect(runner.bound).toBe(false);
    expect(runner.rejected?.message).toContain("Serialized event payload exceeds");
    expect(events.some((event) => event.type === "agent.tool_use")).toBe(false);
  });

  it("replays a completed confirmation from persisted history after service recreation", async () => {
    const fixture = makeSharedFixture(new FakeToolPermissionRunner("ask"));
    const session = await setupSession(fixture.app);

    await sendMessage(fixture.app, session.id, "write");
    const waiting = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.tool_use"),
    );
    const toolUse = waiting.find((event) => event.type === "agent.tool_use");
    const confirmation = await sendToolConfirmation(fixture.app, session.id, {
      type: "user.tool_confirmation",
      tool_use_id: toolUse?.id as string,
      result: "allow",
    });
    await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.tool_result"),
    );

    const recreated = fixture.recreate(new NoPendingToolPermissionRunner());
    const replay = await sendToolConfirmation(recreated, session.id, {
      type: "user.tool_confirmation",
      tool_use_id: toolUse?.id as string,
      result: "allow",
    });

    expect(replay.id).toBe(confirmation.id);
    expect(replay.processed_at).toBe(null);
  });

  it("pages through long histories when replaying completed confirmations", async () => {
    const fixture = makeSharedFixture(new NoPendingToolPermissionRunner());
    const session = await setupSession(fixture.app);
    const toolUseId = "sevt_paged_tool_use";
    const rows = materializePersistedEvents(
      "wrk_default",
      session.id,
      [
        ...Array.from({ length: 1001 }, (_, index) => ({
          type: "agent.tool_result" as const,
          payload: {
            tool_use_id: `sevt_noise_${index}`,
            content: [],
            is_error: true,
          },
        })),
        {
          type: "user.tool_confirmation" as const,
          payload: {
            tool_use_id: toolUseId,
            result: "allow",
          },
        },
        {
          type: "agent.tool_result" as const,
          payload: {
            tool_use_id: toolUseId,
            content: [],
            is_error: false,
          },
        },
      ],
      "2026-01-01T00:00:00.000Z",
    );
    fixture.eventStore.appendBatch(rows);
    const acceptedRow = rows[1001];

    const replay = await sendToolConfirmation(fixture.app, session.id, {
      type: "user.tool_confirmation",
      tool_use_id: toolUseId,
      result: "allow",
    });

    expect(replay.id).toBe(acceptedRow.id);
    expect(replay.processed_at).toBe(null);
  });

  it("reuses a persisted accepted confirmation row when the runtime is still pending", async () => {
    const fixture = makeSharedFixture(new FakeToolPermissionRunner("ask"));
    const session = await setupSession(fixture.app);

    await sendMessage(fixture.app, session.id, "write");
    const waiting = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.tool_use"),
    );
    const toolUse = waiting.find((event) => event.type === "agent.tool_use");
    const toolUseId = toolUse?.id as string;
    const [acceptedRow] = materializePersistedEvents(
      "wrk_default",
      session.id,
      [
        {
          type: "user.tool_confirmation",
          payload: {
            tool_use_id: toolUseId,
            result: "allow",
          },
        },
      ],
      "2026-01-01T00:00:00.000Z",
    );
    fixture.eventStore.append(acceptedRow);

    const confirmation = await sendToolConfirmation(fixture.app, session.id, {
      type: "user.tool_confirmation",
      tool_use_id: toolUseId,
      result: "allow",
    });

    expect(confirmation.id).toBe(acceptedRow.id);
    expect(confirmation.processed_at).toBe(null);
    const completed = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.tool_result"),
    );
    expect(
      completed.filter(
        (event) =>
          event.type === "user.tool_confirmation" &&
          event.tool_use_id === toolUseId,
      ),
    ).toHaveLength(1);
  });

  it("replays an identical in-flight confirmation without terminalizing the turn", async () => {
    const fixture = makeSharedFixture(new DelayedToolPermissionRunner("ask"));
    const session = await setupSession(fixture.app);

    await sendMessage(fixture.app, session.id, "write");
    const waiting = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.tool_use"),
    );
    const toolUse = waiting.find((event) => event.type === "agent.tool_use");
    const toolUseId = toolUse?.id as string;

    const accepted = await sendToolConfirmation(fixture.app, session.id, {
      type: "user.tool_confirmation",
      tool_use_id: toolUseId,
      result: "allow",
    });
    const replay = await sendToolConfirmation(fixture.app, session.id, {
      type: "user.tool_confirmation",
      tool_use_id: toolUseId,
      result: "allow",
    });

    expect(replay.id).toBe(accepted.id);

    const runner = fixture.runner as DelayedToolPermissionRunner;
    expect(runner.claimCount).toBe(1);
    runner.release();

    const completed = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.tool_result"),
    );
    expect(
      completed.filter(
        (event) =>
          event.type === "user.tool_confirmation" &&
          event.tool_use_id === toolUseId,
      ),
    ).toHaveLength(1);
    expect(completed.some((event) => event.type === "session.error")).toBe(false);
  });

  it("terminalizes an accepted confirmation when runtime state is lost", async () => {
    const fixture = makeSharedFixture(new FakeToolPermissionRunner("ask"), {
      leaseTtlMs: -1,
    });
    const session = await setupSession(fixture.app);

    await sendMessage(fixture.app, session.id, "write");
    const waiting = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.tool_use"),
    );
    const toolUse = waiting.find((event) => event.type === "agent.tool_use");
    const toolUseId = toolUse?.id as string;
    const [acceptedRow] = materializePersistedEvents(
      "wrk_default",
      session.id,
      [
        {
          type: "user.tool_confirmation",
          payload: {
            tool_use_id: toolUseId,
            result: "allow",
          },
        },
      ],
      "2026-01-01T00:00:00.000Z",
    );
    fixture.eventStore.append(acceptedRow);

    const recreated = fixture.recreate(new NoPendingToolPermissionRunner());
    const replay = await sendToolConfirmation(recreated, session.id, {
      type: "user.tool_confirmation",
      tool_use_id: toolUseId,
      result: "allow",
    });

    expect(replay.id).toBe(acceptedRow.id);
    const events = await getEvents(recreated, session.id);
    expect(events.find((event) => event.type === "agent.tool_result")).toMatchObject({
      tool_use_id: toolUseId,
      is_error: true,
      content: [
        {
          type: "text",
          text: `Tool confirmation ${toolUseId} was accepted, but runtime state is no longer available and the builtin tool execution outcome is unknown.`,
        },
      ],
    });
    expect(events.at(-1)).toMatchObject({
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
    });
  });

  it("terminalizes the first confirmation after restart when runtime state is lost", async () => {
    const fixture = makeSharedFixture(new FakeToolPermissionRunner("ask"), {
      leaseTtlMs: -1,
    });
    const session = await setupSession(fixture.app);

    await sendMessage(fixture.app, session.id, "write");
    const waiting = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.tool_use"),
    );
    const toolUse = waiting.find((event) => event.type === "agent.tool_use");
    const toolUseId = toolUse?.id as string;

    const recreated = fixture.recreate(new NoPendingToolPermissionRunner());
    const accepted = await sendToolConfirmation(recreated, session.id, {
      type: "user.tool_confirmation",
      tool_use_id: toolUseId,
      result: "allow",
    });

    expect(accepted.tool_use_id).toBe(toolUseId);
    const events = await getEvents(recreated, session.id);
    expect(events.find((event) => event.type === "agent.tool_result")).toMatchObject({
      tool_use_id: toolUseId,
      is_error: true,
    });
    expect(events.at(-1)).toMatchObject({
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
    });
  });

  it("does not emit stale requires_action when custom and builtin waits resolve in one batch", async () => {
    const runner = new MixedPendingRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: translatePiEvent },
    });
    const session = await setupSession(app);

    await sendMessage(app, session.id, "ask both");
    const waiting = await eventuallyEvents(
      app,
      session.id,
      (events) =>
        events.some((event) => event.type === "agent.custom_tool_use") &&
        events.some((event) => event.type === "agent.tool_use") &&
        events.some(
          (event) =>
            event.type === "session.status_idle" &&
            (event.stop_reason as { type?: unknown } | undefined)?.type ===
              "requires_action",
        ),
    );
    const customUse = waiting.find(
      (event) => event.type === "agent.custom_tool_use",
    );
    const toolUse = waiting.find((event) => event.type === "agent.tool_use");

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: customUse?.id,
            content: [{ type: "text", text: "ok" }],
          },
          {
            type: "user.tool_confirmation",
            tool_use_id: toolUse?.id,
            result: "allow",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };

    const completed = await eventuallyEvents(
      app,
      session.id,
      (events) =>
        events.some(
          (event) =>
            event.type === "session.status_idle" &&
            (event.stop_reason as { type?: unknown } | undefined)?.type !==
              "requires_action",
        ),
    );
    const firstAcceptedIndex = completed.findIndex(
      (event) => event.id === body.data[0]?.id,
    );
    expect(firstAcceptedIndex).toBeGreaterThanOrEqual(0);
    expect(
      completed.slice(firstAcceptedIndex).filter(
        (event) =>
          event.type === "session.status_idle" &&
          (event.stop_reason as { type?: unknown } | undefined)?.type ===
            "requires_action",
      ),
    ).toEqual([]);
  });

  it("rejects tool confirmations when no pending builtin confirmation exists", async () => {
    const app = createInMemoryControlPlaneApp();
    const session = await setupSession(app);

    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "user.tool_confirmation",
            tool_use_id: "sevt_missing",
            result: "allow",
          },
        ],
      }),
    });

    expect(res.status).toBe(404);
  });

  it("interrupt clears a pending builtin confirmation and rejects stale confirmation", async () => {
    const runner = new FakeToolPermissionRunner("ask");
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: translatePiEvent },
    });
    const session = await setupSession(app);

    await sendMessage(app, session.id, "ask");
    const waiting = await eventuallyEvents(
      app,
      session.id,
      (events) => events.some((event) => event.type === "agent.tool_use"),
    );
    const toolUse = waiting.find((event) => event.type === "agent.tool_use");

    await sendInterrupt(app, session.id);
    const res = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "user.tool_confirmation",
            tool_use_id: toolUse?.id,
            result: "allow",
          },
        ],
      }),
    });

    expect(res.status).toBe(404);
  });

  it("allows archiving a session paused on a builtin confirmation", async () => {
    const runner = new FakeToolPermissionRunner("ask");
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: translatePiEvent },
    });
    const session = await setupSession(app);

    await sendMessage(app, session.id, "ask");
    await eventuallyEvents(
      app,
      session.id,
      (events) =>
        events.some(
          (event) =>
            event.type === "session.status_idle" &&
            (event.stop_reason as { type?: unknown } | undefined)?.type ===
              "requires_action",
        ),
    );

    const res = await app.request(`/v1/sessions/${session.id}/archive`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { status?: unknown }).status).toBe("terminated");
  });
});

class FakeToolPermissionRunner implements RuntimeEventRunner {
  boundToolUseId: string | undefined;
  protected resolveConfirmation:
    | ((event: ManagedAgentsUserToolConfirmationEventInput) => void)
    | undefined;

  constructor(protected readonly permission: "allow" | "ask" | "deny") {}

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    const confirmation = new Promise<ManagedAgentsUserToolConfirmationEventInput>(
      (resolve) => {
        this.resolveConfirmation = resolve;
      },
    );
    yield {
      type: "oma.tool_permission_use",
      piToolCallId: "toolu_builtin",
      name: "bash",
      input: { command: "touch /workspace/probe" },
      evaluatedPermission: this.permission,
      bindToolUseId: (id) => {
        this.boundToolUseId = id;
      },
      rejectToolUse: () => {},
    } satisfies RuntimeToolPermissionUseEvent;

    const result =
      this.permission === "ask"
        ? await confirmation
        : ({ result: this.permission === "deny" ? "deny" : "allow" } as const);

    yield {
      type: "tool_execution_end",
      toolCallId: "toolu_builtin",
      toolName: "bash",
      result: {
        content: [
          {
            type: "text",
            text: result.result === "allow" ? "tool ok" : "tool denied",
          },
        ],
      },
      isError: result.result === "deny",
    };
    yield { type: "agent_end", messages: [], willRetry: false };
  }

  claimToolConfirmation(
    _workspaceId: string,
    _sessionId: string,
    event: ManagedAgentsUserToolConfirmationEventInput,
  ): (() => void) | undefined {
    if (event.tool_use_id !== this.boundToolUseId) return undefined;
    return () => this.resolveConfirmation?.(event);
  }

  publicToolUseIdForPiToolCallId(
    _workspaceId: string,
    _sessionId: string,
    piToolCallId: string,
  ): string | undefined {
    return piToolCallId === "toolu_builtin" ? this.boundToolUseId : undefined;
  }

  suppressPiToolUse(): boolean {
    return true;
  }
}

class DelayedToolPermissionRunner extends FakeToolPermissionRunner {
  claimCount = 0;
  private readonly releaseGate = deferred<void>();

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    const confirmation = new Promise<ManagedAgentsUserToolConfirmationEventInput>(
      (resolve) => {
        this.resolveConfirmation = resolve;
      },
    );
    yield {
      type: "oma.tool_permission_use",
      piToolCallId: "toolu_builtin",
      name: "bash",
      input: { command: "touch /workspace/probe" },
      evaluatedPermission: this.permission,
      bindToolUseId: (id) => {
        this.boundToolUseId = id;
      },
      rejectToolUse: () => {},
    } satisfies RuntimeToolPermissionUseEvent;

    const result =
      this.permission === "ask"
        ? await confirmation
        : ({ result: this.permission === "deny" ? "deny" : "allow" } as const);
    await this.releaseGate.promise;
    yield {
      type: "tool_execution_end",
      toolCallId: "toolu_builtin",
      toolName: "bash",
      result: {
        content: [
          {
            type: "text",
            text: result.result === "allow" ? "tool ok" : "tool denied",
          },
        ],
      },
      isError: result.result === "deny",
    };
    yield { type: "agent_end", messages: [], willRetry: false };
  }

  override claimToolConfirmation(
    _workspaceId: string,
    _sessionId: string,
    event: ManagedAgentsUserToolConfirmationEventInput,
  ): (() => void) | undefined {
    if (event.tool_use_id !== this.boundToolUseId) return undefined;
    return () => {
      this.claimCount += 1;
      this.resolveConfirmation?.(event);
      this.resolveConfirmation = undefined;
    };
  }

  release(): void {
    this.releaseGate.resolve(undefined);
  }
}

class NoPendingToolPermissionRunner implements RuntimeEventRunner {
  async *runUserMessage(): AsyncIterable<unknown> {}

  claimToolConfirmation(): (() => void) | undefined {
    return undefined;
  }
}

class OversizedToolPermissionRunner implements RuntimeEventRunner {
  bound = false;
  rejected: Error | undefined;

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    yield {
      type: "oma.tool_permission_use",
      piToolCallId: "toolu_oversized",
      name: "bash",
      input: { command: "x".repeat(1_100_000) },
      evaluatedPermission: "ask",
      bindToolUseId: () => {
        this.bound = true;
      },
      rejectToolUse: (error) => {
        this.rejected = error;
      },
    } satisfies RuntimeToolPermissionUseEvent;
    yield { type: "agent_end", messages: [], willRetry: false };
  }
}

function makeSharedFixture(
  runner: RuntimeEventRunner,
  opts: { leaseTtlMs?: number } = {},
): {
  app: ReturnType<typeof createControlPlaneApp>;
  recreate: (nextRunner: RuntimeEventRunner) => ReturnType<typeof createControlPlaneApp>;
  eventStore: EventStore;
  runner: RuntimeEventRunner;
} {
  const agentStore = SqliteAgentStore.open(":memory:");
  const environmentStore = SqliteEnvironmentStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  const eventStore = EventStore.open(":memory:");
  const makeApp = (nextRunner: RuntimeEventRunner) => {
    const broadcaster = new SessionEventBroadcaster(eventStore);
    return createControlPlaneApp({
      agents: new DefaultAgentService(agentStore),
      environments: new DefaultEnvironmentService(environmentStore),
      sessions: new DefaultSessionService(
        sessionStore,
        agentStore,
        environmentStore,
      ),
      sessionEvents: new DefaultSessionEventsService(
        eventStore,
        sessionStore,
        broadcaster,
        {
          runner: nextRunner,
          translate: translatePiEvent,
          ...(opts.leaseTtlMs === undefined
            ? {}
            : { leaseTtlMs: opts.leaseTtlMs }),
        },
      ),
    });
  };
  return {
    app: makeApp(runner),
    recreate: makeApp,
    eventStore,
    runner,
  };
}

class MixedPendingRunner implements RuntimeEventRunner {
  private customToolUseId: string | undefined;
  private toolUseId: string | undefined;
  private resolveCustom:
    | ((event: { custom_tool_use_id: string }) => void)
    | undefined;
  private resolveTool:
    | ((event: ManagedAgentsUserToolConfirmationEventInput) => void)
    | undefined;

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    const custom = new Promise<{ custom_tool_use_id: string }>((resolve) => {
      this.resolveCustom = resolve;
    });
    const tool = new Promise<ManagedAgentsUserToolConfirmationEventInput>(
      (resolve) => {
        this.resolveTool = resolve;
      },
    );
    yield {
      type: "oma.custom_tool_use",
      piToolCallId: "toolu_custom",
      name: "lookup",
      input: { query: "status" },
      bindCustomToolUseId: (id) => {
        this.customToolUseId = id;
      },
      rejectCustomToolUse: () => {},
    } satisfies RuntimeCustomToolUseEvent;
    yield {
      type: "oma.tool_permission_use",
      piToolCallId: "toolu_builtin",
      name: "bash",
      input: { command: "printf ok" },
      evaluatedPermission: "ask",
      bindToolUseId: (id) => {
        this.toolUseId = id;
      },
      rejectToolUse: () => {},
    } satisfies RuntimeToolPermissionUseEvent;
    await Promise.all([custom, tool]);
    yield { type: "agent_end", messages: [], willRetry: false };
  }

  claimCustomToolResult(
    _workspaceId: string,
    _sessionId: string,
    event: ManagedAgentsUserCustomToolResultEventInput,
  ): (() => void) | undefined {
    if (event.custom_tool_use_id !== this.customToolUseId) return undefined;
    return () => this.resolveCustom?.(event);
  }

  claimToolConfirmation(
    _workspaceId: string,
    _sessionId: string,
    event: ManagedAgentsUserToolConfirmationEventInput,
  ): (() => void) | undefined {
    if (event.tool_use_id !== this.toolUseId) return undefined;
    return () => this.resolveTool?.(event);
  }
}

async function setupSession(
  app:
    | ReturnType<typeof createInMemoryControlPlaneApp>
    | ReturnType<typeof createControlPlaneApp>,
): Promise<ManagedAgentsSession> {
  const agent = await createAgent(app);
  const environment = await createEnvironment(app);
  return createSession(app, {
    agent: agent.id,
    environment_id: environment.id,
  });
}

async function createAgent(
  app:
    | ReturnType<typeof createInMemoryControlPlaneApp>
    | ReturnType<typeof createControlPlaneApp>,
): Promise<ManagedAgentsAgent> {
  const res = await app.request("/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(VALID_AGENT),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsAgent;
}

async function createEnvironment(
  app:
    | ReturnType<typeof createInMemoryControlPlaneApp>
    | ReturnType<typeof createControlPlaneApp>,
): Promise<ManagedAgentsEnvironment> {
  const res = await app.request("/v1/environments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(VALID_ENVIRONMENT),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsEnvironment;
}

async function createSession(
  app:
    | ReturnType<typeof createInMemoryControlPlaneApp>
    | ReturnType<typeof createControlPlaneApp>,
  body: unknown,
): Promise<ManagedAgentsSession> {
  const res = await app.request("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ManagedAgentsSession;
}

async function sendMessage(
  app:
    | ReturnType<typeof createInMemoryControlPlaneApp>
    | ReturnType<typeof createControlPlaneApp>,
  sessionId: string,
  text: string,
): Promise<void> {
  const res = await app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    }),
  });
  expect(res.status).toBe(200);
}

async function sendInterrupt(
  app:
    | ReturnType<typeof createInMemoryControlPlaneApp>
    | ReturnType<typeof createControlPlaneApp>,
  sessionId: string,
): Promise<void> {
  const res = await app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{ type: "user.interrupt" }],
    }),
  });
  expect(res.status).toBe(200);
}

async function sendToolConfirmation(
  app:
    | ReturnType<typeof createInMemoryControlPlaneApp>
    | ReturnType<typeof createControlPlaneApp>,
  sessionId: string,
  event: ManagedAgentsUserToolConfirmationEventInput,
): Promise<Record<string, unknown>> {
  const res = await app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [event] }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data[0];
}

async function getEvents(
  app:
    | ReturnType<typeof createInMemoryControlPlaneApp>
    | ReturnType<typeof createControlPlaneApp>,
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await app.request(`/v1/sessions/${sessionId}/events?order=asc`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
}

async function eventuallyEvents(
  app:
    | ReturnType<typeof createInMemoryControlPlaneApp>
    | ReturnType<typeof createControlPlaneApp>,
  sessionId: string,
  predicate: (events: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const startedAt = Date.now();
  while (!hasTimedOut(startedAt, STREAM_TEST_TIMEOUT_MS)) {
    const events = await getEvents(app, sessionId);
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for expected events");
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
