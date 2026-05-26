import { describe, expect, it } from "vitest";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";
import { createControlPlaneApp } from "../app.ts";
import { DefaultAgentService } from "../agents/service.ts";
import { SqliteAgentStore } from "../agents/store.ts";
import { DefaultEnvironmentService } from "../environments/service.ts";
import { SqliteEnvironmentStore } from "../environments/store.ts";
import { SessionEventBroadcaster } from "../events/broadcaster.ts";
import { DefaultSessionEventsService } from "../events/service.ts";
import { EventStore } from "../events/store.ts";
import type { RuntimeEventRunner } from "../events/types.ts";
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

describe("Cycle C.2 API", () => {
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
    const liveAssistant = await reader.nextEvent();
    const liveIdle = await reader.nextEvent();
    expect(liveUser?.data.type).toBe("user.message");
    expect(liveAssistant?.data.type).toBe("agent.message");
    expect(liveAssistant?.data.content).toEqual([
      { type: "text", text: "runtime: ping" },
    ]);
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
      "agent.message",
      "session.status_idle",
    ]);
    expect(runner.prompts).toEqual(["ping"]);
    await reader.cancel();
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
    yield {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `runtime: ${text}` }],
        stopReason: "stop",
      },
    };
  }
}

function makeFixture(runner: RuntimeEventRunner): {
  app: ReturnType<typeof createControlPlaneApp>;
  broadcaster: SessionEventBroadcaster;
} {
  const agentStore = SqliteAgentStore.open(":memory:");
  const environmentStore = SqliteEnvironmentStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  const eventStore = EventStore.open(":memory:");
  const broadcaster = new SessionEventBroadcaster(eventStore);
  return {
    broadcaster,
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
