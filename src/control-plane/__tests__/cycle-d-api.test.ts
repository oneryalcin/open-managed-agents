import { describe, expect, it } from "vitest";
import { createControlPlaneApp } from "../app.ts";
import { DefaultAgentService } from "../agents/service.ts";
import { SqliteAgentStore } from "../agents/store.ts";
import { DefaultEnvironmentService } from "../environments/service.ts";
import { SqliteEnvironmentStore } from "../environments/store.ts";
import { SessionEventBroadcaster } from "../events/broadcaster.ts";
import { DefaultSessionEventsService } from "../events/service.ts";
import { EventStore } from "../events/store.ts";
import type {
  RuntimeCustomToolUseEvent,
  RuntimeEventRunner,
} from "../events/types.ts";
import { DefaultSessionService } from "../sessions/service.ts";
import { translatePiEvent } from "../sessions/pi/translator.ts";
import { SqliteSessionStore } from "../sessions/store.ts";
import { STREAM_TEST_TIMEOUT_MS, hasTimedOut } from "./test-timeouts.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type {
  ManagedAgentsContentBlock,
  ManagedAgentsUserCustomToolResultEventInput,
} from "../../types/events.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";

const VALID_AGENT = {
  name: "D Agent",
  model: "claude-opus-4-7",
  tools: [
    {
      type: "custom",
      name: "ask_user",
      description: "Ask the user for external input.",
      input_schema: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
      },
    },
  ],
};

const VALID_ENVIRONMENT = {
  name: "D Environment",
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
  },
};

describe("Cycle D custom tool round trip", () => {
  it("emits requires_action, accepts custom_tool_result, and resumes the runtime", async () => {
    const runner = new FakeCustomToolRunner();
    const fixture = makeFixture(runner);
    const session = await setupSession(fixture.app);

    await sendMessage(fixture.app, session.id, "ask");
    const waiting = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) =>
        events.some((event) => event.type === "agent.custom_tool_use") &&
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
    expect(customUse?.id).toEqual(expect.stringMatching(/^sevt_/));
    expect(customUse?.name).toBe("ask_user");
    expect(customUse?.input).toEqual({ question: "probe?" });
    expect(runner.boundCustomToolUseId).toBe(customUse?.id);

    const requiresAction = waiting.find(
      (event) =>
        event.type === "session.status_idle" &&
        (event.stop_reason as { type?: unknown } | undefined)?.type ===
          "requires_action",
    );
    expect(requiresAction?.stop_reason).toEqual({
      type: "requires_action",
      event_ids: [customUse?.id],
    });

    await sendCustomToolResult(fixture.app, session.id, customUse?.id as string, [
      { type: "text", text: "external answer" },
    ]);

    const final = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) =>
        events.some((event) => event.type === "agent.message") &&
        events.filter((event) => event.type === "session.status_idle").length === 2,
    );

    expect(types(final)).toEqual([
      "user.message",
      "session.status_running",
      "agent.custom_tool_use",
      "session.status_idle",
      "user.custom_tool_result",
      "session.status_running",
      "agent.message",
      "session.status_idle",
    ]);
    expect(final[4]).toMatchObject({
      type: "user.custom_tool_result",
      custom_tool_use_id: customUse?.id,
      content: [{ type: "text", text: "external answer" }],
      is_error: false,
    });
    expect(final[6]?.content).toEqual([
      { type: "text", text: "runtime saw: external answer" },
    ]);
    expect(final[7]?.stop_reason).toEqual({ type: "end_turn" });
  });

  it("rejects a custom tool result when no pending runtime tool owns the ID", async () => {
    const fixture = makeFixture(new FakeCustomToolRunner());
    const session = await setupSession(fixture.app);

    const res = await fixture.app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: "sevt_missing",
            content: [{ type: "text", text: "late" }],
          },
        ],
      }),
    });

    expect(res.status).toBe(404);
    const events = await getEvents(fixture.app, session.id);
    expect(events).toEqual([]);
  });

  it("aggregates parallel custom tool waits and re-emits remaining actions after partial resolution", async () => {
    const runner = new FakeParallelCustomToolRunner();
    const fixture = makeFixture(runner);
    const session = await setupSession(fixture.app);

    await sendMessage(fixture.app, session.id, "ask both");
    const waiting = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) =>
        events.filter((event) => event.type === "agent.custom_tool_use").length ===
          2 &&
        events.some(
          (event) =>
            event.type === "session.status_idle" &&
            JSON.stringify(event.stop_reason).includes("requires_action"),
        ),
    );

    const customUses = waiting.filter(
      (event) => event.type === "agent.custom_tool_use",
    );
    const firstIdle = waiting.find(
      (event) => event.type === "session.status_idle",
    );
    expect(firstIdle?.stop_reason).toEqual({
      type: "requires_action",
      event_ids: customUses.map((event) => event.id),
    });

    await sendCustomToolResult(
      fixture.app,
      session.id,
      customUses[0]?.id as string,
      [{ type: "text", text: "first answer" }],
    );

    const partial = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) =>
        events.filter((event) => event.type === "session.status_idle").length ===
        2,
    );
    expect(partial.at(-1)?.stop_reason).toEqual({
      type: "requires_action",
      event_ids: [customUses[1]?.id],
    });

    await sendCustomToolResult(
      fixture.app,
      session.id,
      customUses[1]?.id as string,
      [{ type: "text", text: "second answer" }],
    );

    const final = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) =>
        events.some((event) => event.type === "agent.message") &&
        (events.at(-1)?.stop_reason as { type?: unknown } | undefined)?.type ===
          "end_turn",
    );

    expect(final.map((event) => event.type)).toEqual([
      "user.message",
      "session.status_running",
      "agent.custom_tool_use",
      "agent.custom_tool_use",
      "session.status_idle",
      "user.custom_tool_result",
      "session.status_running",
      "session.status_idle",
      "user.custom_tool_result",
      "session.status_running",
      "agent.message",
      "session.status_idle",
    ]);
  });

  it("re-emits requires_action with all pending IDs when a second tool wait arrives later", async () => {
    const runner = new FakeGappedCustomToolRunner();
    const fixture = makeFixture(runner);
    const session = await setupSession(fixture.app);

    await sendMessage(fixture.app, session.id, "ask two with a gap");
    const withTwoIdles = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) =>
        events.filter((event) => event.type === "agent.custom_tool_use").length ===
          2 &&
        events.filter((event) => event.type === "session.status_idle").length ===
          2,
    );

    const customUses = withTwoIdles.filter(
      (event) => event.type === "agent.custom_tool_use",
    );
    const idleEvents = withTwoIdles.filter(
      (event) => event.type === "session.status_idle",
    );
    expect(idleEvents[0]?.stop_reason).toEqual({
      type: "requires_action",
      event_ids: [customUses[0]?.id],
    });
    expect(idleEvents[1]?.stop_reason).toEqual({
      type: "requires_action",
      event_ids: customUses.map((event) => event.id),
    });

    await sendCustomToolResult(
      fixture.app,
      session.id,
      customUses[0]?.id as string,
      [{ type: "text", text: "first answer" }],
    );

    const partial = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) =>
        events.filter((event) => event.type === "session.status_idle").length ===
        3,
    );
    expect(partial.at(-1)?.stop_reason).toEqual({
      type: "requires_action",
      event_ids: [customUses[1]?.id],
    });
  });

  it("does not keep stale requires_action IDs after a runtime-side tool failure", async () => {
    const runner = new FakeExpiringCustomToolRunner();
    const fixture = makeFixture(runner);
    const session = await setupSession(fixture.app);

    await sendMessage(fixture.app, session.id, "ask then expire");
    const firstWait = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) =>
        events.some((event) => event.type === "agent.custom_tool_use") &&
        events.some((event) => event.type === "session.status_idle"),
    );
    const firstUse = firstWait.find(
      (event) => event.type === "agent.custom_tool_use",
    );
    expect(firstWait.at(-1)?.stop_reason).toEqual({
      type: "requires_action",
      event_ids: [firstUse?.id],
    });

    runner.expireFirst();
    runner.continueWithSecond();

    const secondWait = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) =>
        events.filter((event) => event.type === "agent.custom_tool_use").length ===
          2 &&
        events.filter((event) => event.type === "session.status_idle").length ===
          2,
    );
    const customUses = secondWait.filter(
      (event) => event.type === "agent.custom_tool_use",
    );
    expect(secondWait.at(-1)?.stop_reason).toEqual({
      type: "requires_action",
      event_ids: [customUses[1]?.id],
    });
  });
});

class FakeCustomToolRunner implements RuntimeEventRunner {
  boundCustomToolUseId: string | undefined;
  private resolveResult:
    | ((event: ManagedAgentsUserCustomToolResultEventInput) => void)
    | undefined;

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    const result = new Promise<ManagedAgentsUserCustomToolResultEventInput>(
      (resolve) => {
        this.resolveResult = resolve;
      },
    );
    yield {
      type: "oma.custom_tool_use",
      piToolCallId: "toolu_fake_custom",
      name: "ask_user",
      input: { question: "probe?" },
      bindCustomToolUseId: (id) => {
        this.boundCustomToolUseId = id;
      },
      rejectCustomToolUse: () => {},
    } satisfies RuntimeCustomToolUseEvent;

    const toolResult = await result;
    const text = (toolResult.content ?? [])
      .filter((block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("\n");
    yield {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `runtime saw: ${text}` }],
        stopReason: "stop",
      },
    };
    yield { type: "agent_end", messages: [], willRetry: false };
  }

  claimCustomToolResult(
    _workspaceId: string,
    _sessionId: string,
    event: ManagedAgentsUserCustomToolResultEventInput,
  ): (() => void) | undefined {
    if (event.custom_tool_use_id !== this.boundCustomToolUseId) return undefined;
    return () => this.resolveResult?.(event);
  }

  customToolNames(): ReadonlySet<string> {
    return new Set(["ask_user"]);
  }
}

class FakeParallelCustomToolRunner implements RuntimeEventRunner {
  private readonly pending = new Map<
    string,
    (event: ManagedAgentsUserCustomToolResultEventInput) => void
  >();
  private boundIds: string[] = [];

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    yield this.makeCustomToolUse("ask_user", { question: "first?" });
    yield this.makeCustomToolUse("ask_user", { question: "second?" });

    const first = await this.waitForResult(0);
    const second = await this.waitForResult(1);
    yield {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `runtime saw: ${textContent(first)} / ${textContent(second)}`,
          },
        ],
        stopReason: "stop",
      },
    };
    yield { type: "agent_end", messages: [], willRetry: false };
  }

  claimCustomToolResult(
    _workspaceId: string,
    _sessionId: string,
    event: ManagedAgentsUserCustomToolResultEventInput,
  ): (() => void) | undefined {
    const resolve = this.pending.get(event.custom_tool_use_id);
    if (!resolve) return undefined;
    return () => {
      this.pending.delete(event.custom_tool_use_id);
      resolve(event);
    };
  }

  customToolNames(): ReadonlySet<string> {
    return new Set(["ask_user"]);
  }

  private makeCustomToolUse(
    name: string,
    input: { question: string },
  ): RuntimeCustomToolUseEvent {
    return {
      type: "oma.custom_tool_use",
      piToolCallId: `toolu_fake_${this.boundIds.length}`,
      name,
      input,
      bindCustomToolUseId: (id) => {
        this.boundIds.push(id);
      },
      rejectCustomToolUse: () => {},
    };
  }

  private waitForResult(
    index: number,
  ): Promise<ManagedAgentsUserCustomToolResultEventInput> {
    const id = this.boundIds[index];
    if (!id) throw new Error(`missing bound custom tool id at ${index}`);
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
    });
  }
}

class FakeGappedCustomToolRunner implements RuntimeEventRunner {
  private readonly pending = new Map<
    string,
    (event: ManagedAgentsUserCustomToolResultEventInput) => void
  >();
  private boundIds: string[] = [];

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    yield this.makeCustomToolUse("ask_user", { question: "first?" });
    await delay(5);
    yield this.makeCustomToolUse("ask_user", { question: "second?" });
    await this.waitForResult(0);
    await this.waitForResult(1);
    yield { type: "agent_end", messages: [], willRetry: false };
  }

  claimCustomToolResult(
    _workspaceId: string,
    _sessionId: string,
    event: ManagedAgentsUserCustomToolResultEventInput,
  ): (() => void) | undefined {
    const resolve = this.pending.get(event.custom_tool_use_id);
    if (!resolve) return undefined;
    return () => {
      this.pending.delete(event.custom_tool_use_id);
      resolve(event);
    };
  }

  customToolNames(): ReadonlySet<string> {
    return new Set(["ask_user"]);
  }

  private makeCustomToolUse(
    name: string,
    input: { question: string },
  ): RuntimeCustomToolUseEvent {
    return {
      type: "oma.custom_tool_use",
      piToolCallId: `toolu_fake_gap_${this.boundIds.length}`,
      name,
      input,
      bindCustomToolUseId: (id) => {
        this.boundIds.push(id);
      },
      rejectCustomToolUse: () => {},
    };
  }

  private waitForResult(
    index: number,
  ): Promise<ManagedAgentsUserCustomToolResultEventInput> {
    const id = this.boundIds[index];
    if (!id) throw new Error(`missing bound custom tool id at ${index}`);
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
    });
  }
}

class FakeExpiringCustomToolRunner implements RuntimeEventRunner {
  private releaseFirst: (() => void) | undefined;
  private readonly continue = deferred<void>();

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    yield {
      type: "oma.custom_tool_use",
      piToolCallId: "toolu_fake_expire_0",
      name: "ask_user",
      input: { question: "first?" },
      bindCustomToolUseId: (_id, release) => {
        this.releaseFirst = release;
      },
      rejectCustomToolUse: () => {},
    } satisfies RuntimeCustomToolUseEvent;

    await this.continue.promise;
    yield {
      type: "oma.custom_tool_use",
      piToolCallId: "toolu_fake_expire_1",
      name: "ask_user",
      input: { question: "second?" },
      bindCustomToolUseId: () => {},
      rejectCustomToolUse: () => {},
    } satisfies RuntimeCustomToolUseEvent;
  }

  claimCustomToolResult(): (() => void) | undefined {
    return undefined;
  }

  customToolNames(): ReadonlySet<string> {
    return new Set(["ask_user"]);
  }

  expireFirst(): void {
    this.releaseFirst?.();
  }

  continueWithSecond(): void {
    this.continue.resolve(undefined);
  }
}

function makeFixture(runner: RuntimeEventRunner): {
  app: ReturnType<typeof createControlPlaneApp>;
} {
  const agentStore = SqliteAgentStore.open(":memory:");
  const environmentStore = SqliteEnvironmentStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  const eventStore = EventStore.open(":memory:");
  const broadcaster = new SessionEventBroadcaster(eventStore);
  return {
    app: createControlPlaneApp({
      agents: new DefaultAgentService(agentStore),
      environments: new DefaultEnvironmentService(environmentStore),
      sessions: new DefaultSessionService(sessionStore, agentStore, environmentStore),
      sessionEvents: new DefaultSessionEventsService(eventStore, sessionStore, broadcaster, {
        runner,
        translate: translatePiEvent,
      }),
    }),
  };
}

async function setupSession(
  app: ReturnType<typeof createControlPlaneApp>,
): Promise<ManagedAgentsSession> {
  const agent = await createAgent(app);
  const environment = await createEnvironment(app);
  return createSession(app, {
    agent: agent.id,
    environment_id: environment.id,
  });
}

async function createAgent(
  app: ReturnType<typeof createControlPlaneApp>,
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
  app: ReturnType<typeof createControlPlaneApp>,
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
  app: ReturnType<typeof createControlPlaneApp>,
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
  app: ReturnType<typeof createControlPlaneApp>,
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

async function sendCustomToolResult(
  app: ReturnType<typeof createControlPlaneApp>,
  sessionId: string,
  customToolUseId: string,
  content: ManagedAgentsContentBlock[],
): Promise<void> {
  const res = await app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [
        {
          type: "user.custom_tool_result",
          custom_tool_use_id: customToolUseId,
          content,
          is_error: false,
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
}

async function getEvents(
  app: ReturnType<typeof createControlPlaneApp>,
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await app.request(`/v1/sessions/${sessionId}/events?order=asc`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
}

async function eventuallyEvents(
  app: ReturnType<typeof createControlPlaneApp>,
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

function types(events: Array<Record<string, unknown>>): unknown[] {
  return events.map((event) => event.type);
}

function textContent(
  event: ManagedAgentsUserCustomToolResultEventInput,
): string {
  return (event.content ?? [])
    .filter((block): block is { type: "text"; text: string } =>
      block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
