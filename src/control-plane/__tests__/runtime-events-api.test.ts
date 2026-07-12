import { describe, expect, it } from "vitest";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";
import { createControlPlaneApp } from "./helpers.ts";
import { DefaultAgentService } from "../agents/service.ts";
import { SqliteAgentStore } from "../agents/store.ts";
import { DefaultEnvironmentService } from "../environments/service.ts";
import { SqliteEnvironmentStore } from "../environments/store.ts";
import { SessionEventBroadcaster } from "../events/broadcaster.ts";
import { DefaultSessionEventsService } from "../events/service.ts";
import { EventStore } from "../events/store.ts";
import {
  createBestEffortRuntimeEventCoordinator,
  type DeploymentRuntimeEventCoordinator,
  type RuntimeTurnEventCommit,
} from "../deployment-runtime-event-coordinator.ts";
import { createBestEffortSessionOutputCoordinator } from "../deployment-session-output-coordinator.ts";
import {
  RuntimeTurnOwnershipLostError,
  type RuntimeEventRunner,
  type RuntimeSessionOutputCollection,
  type RuntimeSessionOutputFile,
} from "../events/types.ts";
import { DefaultFileService } from "../files/service.ts";
import { InMemoryFileStorage } from "../files/store.ts";
import { DefaultSessionService } from "../sessions/service.ts";
import { translatePiEvent } from "../sessions/pi/translator.ts";
import { SqliteSessionStore } from "../sessions/store.ts";
import { STREAM_TEST_TIMEOUT_MS, hasTimedOut } from "./test-timeouts.ts";

const VALID_AGENT = {
  name: "C2 Agent",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
};

const VALID_ENVIRONMENT = {
  name: "C2 Environment",
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
  },
};

describe("Runtime events API", () => {
  it("persists translated runtime events and delivers them on existing list/stream routes", async () => {
    const runner = new FakeRunner();
    const fixture = makeFixture(runner);
    const session = await setupSession(fixture.app);

    const stream = await fixture.app.request(`/v1/sessions/${session.id}/events/stream`, {
      headers: { accept: "text/event-stream" },
    });
    const reader = sseReader(stream);
    await until(
      () => fixture.broadcaster.subscriberCount(session.id) > 0,
      "Timed out waiting for stream subscriber registration",
    );

    const send = await fixture.app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: "ping" }] }],
      }),
    });
    expect(send.status).toBe(200);
    const sendBody = (await send.json()) as { data: Array<Record<string, unknown>> };
    expect(sendBody.data.map((event) => event.type)).toEqual(["user.message"]);

    const liveUser = await reader.nextEvent();
    const liveRunning = await reader.nextEvent();
    const liveSpanStart = await reader.nextEvent();
    const liveAssistant = await reader.nextEvent();
    const liveSpanEnd = await reader.nextEvent();
    const liveIdle = await reader.nextEvent();
    expect(liveUser?.data.type).toBe("user.message");
    expect(liveRunning?.data.type).toBe("session.status_running");
    expect(liveSpanStart?.data.type).toBe("span.model_request_start");
    expect(liveAssistant?.data.type).toBe("agent.message");
    expect(liveAssistant?.data.content).toEqual([
      { type: "text", text: "runtime: ping" },
    ]);
    expect(liveSpanEnd?.data).toMatchObject({
      type: "span.model_request_end",
      model_request_start_id: liveSpanStart?.data.id,
      is_error: false,
      model_usage: {
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 11,
        input_tokens: 13,
        output_tokens: 17,
        speed: null,
      },
    });
    expect(liveIdle?.data.type).toBe("session.status_idle");
    expect(liveIdle?.data.stop_reason).toEqual({ type: "end_turn" });

    const list = await eventuallyList(
      fixture.app,
      `/v1/sessions/${session.id}/events?order=asc`,
      (body) =>
        body.data.some((event) => event.type === "agent.message") &&
        body.data.some((event) => event.type === "session.status_idle"),
    );
    expect(list.data.map((event) => event.type)).toEqual([
      "user.message",
      "session.status_running",
      "span.model_request_start",
      "agent.message",
      "span.model_request_end",
      "session.status_idle",
    ]);
    const spanStart = list.data.find(
      (event) => event.type === "span.model_request_start",
    );
    const spanEnd = list.data.find(
      (event) => event.type === "span.model_request_end",
    );
    expect(spanEnd?.model_request_start_id).toBe(spanStart?.id);
    const filtered = await eventuallyList(
      fixture.app,
      `/v1/sessions/${session.id}/events?order=asc&types[]=span.model_request_end`,
      (body) => body.data.length === 1,
    );
    expect(filtered.data.map((event) => event.type)).toEqual([
      "span.model_request_end",
    ]);
    expect(runner.prompts).toEqual(["ping"]);
    await reader.cancel();
  });

  it("persists session.error when runtime runner fails", async () => {
    const fixture = makeFixture(new ThrowingRunner());
    const session = await setupSession(fixture.app);

    const send = await fixture.app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: "boom" }] }],
      }),
    });
    expect(send.status).toBe(200);

    const list = await eventuallyList(
      fixture.app,
      `/v1/sessions/${session.id}/events?order=asc`,
      (body) => body.data.some((event) => event.type === "session.error"),
    );
    expect(list.data.map((event) => event.type)).toEqual([
      "user.message",
      "span.model_request_start",
      "span.model_request_end",
      "session.error",
      "session.status_idle",
    ]);
    const spanStart = list.data.find(
      (event) => event.type === "span.model_request_start",
    );
    const spanEnd = list.data.find(
      (event) => event.type === "span.model_request_end",
    );
    expect(spanEnd).toMatchObject({
      model_request_start_id: spanStart?.id,
      is_error: true,
      model_usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        speed: null,
      },
    });
    const errorEvent = list.data.find((event) => event.type === "session.error");
    expect(errorEvent?.message).toBe("Runtime execution failed");
  });

  it("defensively closes an open model span when runtime completes without message_end", async () => {
    const fixture = makeFixture(new UnpairedStartRunner());
    const session = await setupSession(fixture.app);

    const send = await fixture.app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: "done" }] }],
      }),
    });
    expect(send.status).toBe(200);

    const list = await eventuallyList(
      fixture.app,
      `/v1/sessions/${session.id}/events?order=asc`,
      (body) => body.data.some((event) => event.type === "span.model_request_end"),
    );
    expect(list.data.map((event) => event.type)).toEqual([
      "user.message",
      "span.model_request_start",
      "span.model_request_end",
    ]);
    const spanStart = list.data.find(
      (event) => event.type === "span.model_request_start",
    );
    const spanEnd = list.data.find(
      (event) => event.type === "span.model_request_end",
    );
    expect(spanEnd).toMatchObject({
      model_request_start_id: spanStart?.id,
      is_error: true,
      model_usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        speed: null,
      },
    });
  });

  it("indexes generated output files from a live runtime terminal idle", async () => {
    const runner = new OutputCollectingRunner([
      {
        relativePath: "reports/summary.md",
        filename: "summary.md",
        mimeType: "text/markdown",
        sizeBytes: 17,
        sha256: "c59c73e280c05a9e363b88b8759655f5c6b897c2b5d2783f7b7eff39dcbb9125",
        bytes: new TextEncoder().encode("# Session output\n"),
      },
    ]);
    const fixture = makeFixture(runner);
    const session = await setupSession(fixture.app);

    const send = await fixture.app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: "write" }] }],
      }),
    });
    expect(send.status).toBe(200);

    const files = await eventuallyFileList(
      fixture.app,
      `/v1/files?scope_id=${session.id}&limit=10`,
      (body) => body.data.length === 1,
    );
    expect(runner.collectCount).toBe(1);
    expect(files.data[0]).toMatchObject({
      type: "file",
      filename: "summary.md",
      mime_type: "text/markdown",
      size_bytes: 17,
      downloadable: true,
      scope: { type: "session", id: session.id },
    });

    const download = await fixture.app.request(
      `/v1/files/${files.data[0]?.id}/content`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("request-id")).toEqual(expect.any(String));
    expect(download.headers.get("content-type")).toBe("text/markdown");
    await expect(download.text()).resolves.toBe("# Session output\n");

    runner.files = [];
    const emptyCollectSend = await fixture.app.request(
      `/v1/sessions/${session.id}/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            { type: "user.message", content: [{ type: "text", text: "empty" }] },
          ],
        }),
      },
    );
    expect(emptyCollectSend.status).toBe(200);
    await eventuallyList(
      fixture.app,
      `/v1/sessions/${session.id}/events?order=asc`,
      (body) =>
        body.data.filter((event) => event.type === "session.status_idle")
          .length >= 2,
    );
    const afterEmptyCollect = await fixture.app.request(
      `/v1/files?scope_id=${session.id}&limit=10`,
    );
    expect(afterEmptyCollect.status).toBe(200);
    await expect(afterEmptyCollect.json()).resolves.toMatchObject({
      data: [files.data[0]],
    });
    expect(runner.collectCount).toBe(2);

    const outputId = files.data[0]?.id as string;
    const deleted = await fixture.app.request(`/v1/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);

    const afterDelete = await fixture.app.request(
      `/v1/files?scope_id=${session.id}&limit=10`,
    );
    expect(afterDelete.status).toBe(200);
    await expect(afterDelete.json()).resolves.toMatchObject({ data: [] });
    const deletedDownload = await fixture.app.request(
      `/v1/files/${outputId}/content`,
    );
    expect(deletedDownload.status).toBe(404);
  });

  it("blocks delete during output collection, then cleans up once the turn settles", async () => {
    const runner = new DelayedOutputCollectingRunner([
      {
        relativePath: "late.txt",
        filename: "late.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        sha256: "089001a35679a33ef3db0ca350db9b9a2f0136e0e327577b04b3b98127470961",
        bytes: new TextEncoder().encode("late"),
      },
    ]);
    const fixture = makeFixture(runner);
    const session = await setupSession(fixture.app);

    const send = await fixture.app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: "late" }] }],
      }),
    });
    expect(send.status).toBe(200);
    await runner.collectionStarted;

    // The turn is still running (output collection is mid-flight), so hosted
    // rejects the delete (probe 38). Because the guard refuses any delete while
    // the runtime task is live, a delete can never run concurrently with output
    // indexing — the resurrection race is unreachable, not merely cleaned up after.
    const rejected = await fixture.app.request(`/v1/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(rejected.status).toBe(400);

    runner.releaseCollection();
    await runner.collectionFinished;
    await eventuallyList(
      fixture.app,
      `/v1/sessions/${session.id}/events?order=asc`,
      (body) =>
        body.data.some((event) => event.type === "session.status_idle"),
    );

    const deleted = await fixture.app.request(`/v1/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);

    const outputs = await fixture.app.request(
      `/v1/files?scope_id=${session.id}&limit=10`,
    );
    expect(outputs.status).toBe(200);
    await expect(outputs.json()).resolves.toMatchObject({ data: [] });
  });

  it("interrupts the local runner when runtime turn ownership is lost", async () => {
    const runner = new InterruptTrackingRunner();
    const fixture = makeFixture(runner, {
      runtimeEventCoordinator: new OwnershipLostRuntimeEventCoordinator(),
    });
    const session = await setupSession(fixture.app);

    const send = await fixture.app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: "lost" }] }],
      }),
    });
    expect(send.status).toBe(200);

    await until(
      () => runner.interruptedSessionIds.includes(session.id),
      "Timed out waiting for ownership-loss interrupt",
    );
    const list = await fixture.app.request(
      `/v1/sessions/${session.id}/events?order=asc`,
    );
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      data: [{ type: "user.message" }],
    });
  });
});

class FakeRunner implements RuntimeEventRunner {
  readonly prompts: string[] = [];

  async *runUserMessage(
    _workspaceId: string,
    _sessionId: string,
    text: string,
  ): AsyncIterable<unknown> {
    this.prompts.push(text);
    await Promise.resolve();
    yield { type: "agent_start" };
    yield {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    };
    yield {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `runtime: ${text}` }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        usage: {
          input: 13,
          output: 17,
          cacheRead: 11,
          cacheWrite: 7,
        },
        stopReason: "stop",
      },
    };
    yield { type: "agent_end", messages: [], willRetry: false };
  }
}

class InterruptTrackingRunner extends FakeRunner {
  readonly interruptedSessionIds: string[] = [];

  interruptSession(_workspaceId: string, sessionId: string): void {
    this.interruptedSessionIds.push(sessionId);
  }
}

class OwnershipLostRuntimeEventCoordinator
  implements DeploymentRuntimeEventCoordinator
{
  commitRuntimeEventsForTurn(input: RuntimeTurnEventCommit): void {
    throw new RuntimeTurnOwnershipLostError(input.turnId);
  }
}

class ThrowingRunner implements RuntimeEventRunner {
  async *runUserMessage(
    _workspaceId: string,
    _sessionId: string,
    _text: string,
  ): AsyncIterable<unknown> {
    await Promise.resolve();
    yield {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    };
    throw new Error("runtime boom");
  }
}

class UnpairedStartRunner implements RuntimeEventRunner {
  async *runUserMessage(
    _workspaceId: string,
    _sessionId: string,
    _text: string,
  ): AsyncIterable<unknown> {
    await Promise.resolve();
    yield {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    };
  }
}

class OutputCollectingRunner extends FakeRunner {
  collectCount = 0;

  constructor(public files: readonly RuntimeSessionOutputFile[]) {
    super();
  }

  async collectSessionOutputs(): Promise<RuntimeSessionOutputCollection> {
    this.collectCount += 1;
    return { kind: "collected", files: this.files };
  }
}

class DelayedOutputCollectingRunner extends OutputCollectingRunner {
  private readonly started = deferred<void>();
  private readonly release = deferred<void>();
  private readonly finished = deferred<void>();

  readonly collectionStarted = this.started.promise;
  readonly collectionFinished = this.finished.promise;

  releaseCollection(): void {
    this.release.resolve();
  }

  override async collectSessionOutputs(): Promise<RuntimeSessionOutputCollection> {
    this.collectCount += 1;
    this.started.resolve();
    await this.release.promise;
    this.finished.resolve();
    return { kind: "collected", files: this.files };
  }
}

function makeFixture(
  runner: RuntimeEventRunner,
  opts: {
    runtimeEventCoordinator?: DeploymentRuntimeEventCoordinator;
  } = {},
): {
  app: ReturnType<typeof createControlPlaneApp>;
  broadcaster: SessionEventBroadcaster;
} {
  const agentStore = SqliteAgentStore.open(":memory:");
  const environmentStore = SqliteEnvironmentStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  const eventStore = EventStore.open(":memory:");
  const fileStorage = new InMemoryFileStorage();
  const broadcaster = new SessionEventBroadcaster(eventStore);
  const sessionOutputCoordinator = createBestEffortSessionOutputCoordinator({
    sessions: sessionStore,
    events: eventStore,
    files: fileStorage,
  });
  const runtimeEventCoordinator = createBestEffortRuntimeEventCoordinator({
    sessions: sessionStore,
    events: eventStore,
  });
  const sessionEvents = new DefaultSessionEventsService(eventStore, sessionStore, broadcaster, {
    runner,
    translate: translatePiEvent,
    sessionOutputCoordinator,
    runtimeEventCoordinator: opts.runtimeEventCoordinator ?? runtimeEventCoordinator,
  });
  return {
    broadcaster,
    app: createControlPlaneApp({
      agents: new DefaultAgentService(agentStore, undefined),
      environments: new DefaultEnvironmentService(environmentStore),
      files: new DefaultFileService(fileStorage),
      sessions: new DefaultSessionService(
        sessionStore,
        agentStore,
        environmentStore,
        fileStorage,
        {
          assertDeletable: (workspaceId, sessionId) =>
            sessionEvents.assertSessionDeletable(workspaceId, sessionId),
        },
      ),
      sessionEvents,
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

async function eventuallyList(
  app: ReturnType<typeof createControlPlaneApp>,
  path: string,
  predicate: (body: {
    data: Array<Record<string, unknown>>;
    next_page: string | null;
  }) => boolean,
): Promise<{ data: Array<Record<string, unknown>>; next_page: string | null }> {
  const startedAt = Date.now();
  while (true) {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<Record<string, unknown>>;
      next_page: string | null;
    };
    if (predicate(body)) return body;
    if (hasTimedOut(startedAt, STREAM_TEST_TIMEOUT_MS)) {
      throw new Error("Timed out waiting for translated runtime events in list response");
    }
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 25);
    });
  }
}

async function eventuallyFileList(
  app: ReturnType<typeof createControlPlaneApp>,
  path: string,
  predicate: (body: {
    data: Array<Record<string, unknown>>;
    has_more: boolean;
    first_id: string | null;
    last_id: string | null;
  }) => boolean,
): Promise<{
  data: Array<Record<string, unknown>>;
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}> {
  const startedAt = Date.now();
  while (true) {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<Record<string, unknown>>;
      has_more: boolean;
      first_id: string | null;
      last_id: string | null;
    };
    if (predicate(body)) return body;
    if (hasTimedOut(startedAt, STREAM_TEST_TIMEOUT_MS)) {
      throw new Error("Timed out waiting for indexed session output files");
    }
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 25);
    });
  }
}

function sseReader(response: Response): {
  nextEvent(): Promise<{ id?: string; event?: string; data: Record<string, unknown> } | null>;
  cancel(): Promise<void>;
} {
  const body = response.body;
  if (!body) {
    throw new Error("Expected streaming response body");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async nextEvent() {
      while (true) {
        const split = buffer.indexOf("\n\n");
        if (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (frame.length === 0) continue;
          return parseSseFrame(frame);
        }
        const chunk = await reader.read();
        if (chunk.done) {
          if (buffer.length === 0) return null;
          const last = parseSseFrame(buffer);
          buffer = "";
          return last;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async cancel() {
      await reader.cancel();
    },
  };
}

function parseSseFrame(frame: string): {
  id?: string;
  event?: string;
  data: Record<string, unknown>;
} {
  let id: string | undefined;
  let event: string | undefined;
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data = line.slice(6);
  }
  return { id, event, data: JSON.parse(data) as Record<string, unknown> };
}

async function until(
  predicate: () => boolean,
  timeoutMessage: string,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (hasTimedOut(startedAt, STREAM_TEST_TIMEOUT_MS)) {
      throw new Error(timeoutMessage);
    }
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 10);
    });
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
