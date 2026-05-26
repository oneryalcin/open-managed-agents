import { describe, expect, it } from "vitest";
import { createControlPlaneApp } from "../app.ts";
import type { ApiErrorBody } from "../errors.ts";
import { DefaultAgentService } from "../agents/service.ts";
import { SqliteAgentStore } from "../agents/store.ts";
import { DefaultEnvironmentService } from "../environments/service.ts";
import { SqliteEnvironmentStore } from "../environments/store.ts";
import { SessionEventBroadcaster } from "../events/broadcaster.ts";
import { DefaultSessionEventsService } from "../events/service.ts";
import { EventStore } from "../events/store.ts";
import { DefaultSessionService } from "../sessions/service.ts";
import { SqliteSessionStore } from "../sessions/store.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";

const VALID_AGENT = {
  name: "B3 Agent",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
};

const VALID_ENVIRONMENT = {
  name: "B3 Environment",
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
  },
};

describe("Cycle B.3 API", () => {
  it("streams SSE frames with id/event/data and receives live events after replay barrier", async () => {
    const fixture = makeFixture();
    const session = await setupSession(fixture.app);
    await sendMessage(fixture.app, session.id, "sentinel");

    const streamController = new AbortController();
    const streamRes = await fixture.app.request(
      `/v1/sessions/${session.id}/events/stream`,
      {
        headers: { accept: "text/event-stream" },
        signal: streamController.signal,
      },
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toContain("text/event-stream");
    expect(streamRes.headers.get("request-id")).toEqual(
      expect.stringMatching(/^req_/),
    );

    const reader = sseReader(streamRes);
    const first = await reader.nextEvent();
    expect(first?.event).toBe("user.message");
    expect(first?.id).toEqual(expect.stringMatching(/^sevt_/));
    expect(first?.data.type).toBe("user.message");
    expect(first?.data.content).toEqual([{ type: "text", text: "sentinel" }]);

    // Synchronization barrier: sentinel replay completed + active subscriber.
    expect(fixture.broadcaster.subscriberCount(session.id)).toBeGreaterThan(0);

    await sendMessage(fixture.app, session.id, "live");
    const live = await reader.nextEvent();
    expect(live?.event).toBe("user.message");
    expect(live?.data.content).toEqual([{ type: "text", text: "live" }]);
    expect(live?.id).not.toBe(first?.id);

    streamController.abort();
  });

  it("resumes from valid Last-Event-ID and fail-opens for malformed or foreign cursors", async () => {
    const fixture = makeFixture();
    const primary = await setupSession(fixture.app);
    await sendMessage(fixture.app, primary.id, "a");
    await sendMessage(fixture.app, primary.id, "b");

    const list = await getEvents(fixture.app, `/v1/sessions/${primary.id}/events?order=asc`);
    const firstId = list.data[0].id as string;
    expect(firstId).toEqual(expect.stringMatching(/^sevt_/));

    const resumed = await fixture.app.request(`/v1/sessions/${primary.id}/events/stream`, {
      headers: { "last-event-id": firstId },
    });
    const resumedReader = sseReader(resumed);
    const resumedEvent = await resumedReader.nextEvent();
    expect(resumedEvent?.data.content).toEqual([{ type: "text", text: "b" }]);

    const malformed = await fixture.app.request(`/v1/sessions/${primary.id}/events/stream`, {
      headers: { "last-event-id": "bad_cursor" },
    });
    const malformedReader = sseReader(malformed);
    const malformedFirst = await malformedReader.nextEvent();
    expect(malformedFirst?.data.content).toEqual([{ type: "text", text: "a" }]);

    const other = await setupSession(fixture.app);
    await sendMessage(fixture.app, other.id, "other");
    const otherList = await getEvents(fixture.app, `/v1/sessions/${other.id}/events?order=asc`);
    const foreignId = otherList.data[0].id as string;

    const foreign = await fixture.app.request(`/v1/sessions/${primary.id}/events/stream`, {
      headers: { "last-event-id": foreignId },
    });
    const foreignReader = sseReader(foreign);
    const foreignFirst = await foreignReader.nextEvent();
    expect(foreignFirst?.data.content).toEqual([{ type: "text", text: "a" }]);
  });

  it("returns not_found_error envelope when opening stream for missing sessions", async () => {
    const fixture = makeFixture();
    const res = await fixture.app.request("/v1/sessions/sesn_missing/events/stream");
    expect(res.status).toBe(404);
    const requestId = res.headers.get("request-id");
    expect(requestId).toEqual(expect.stringMatching(/^req_/));
    const body = (await res.json()) as ApiErrorBody;
    expect(body).toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: "Session sesn_missing not found",
      },
      request_id: expect.stringMatching(/^req_/),
    });
    expect(body.request_id).toBe(requestId);
  });
});

function makeFixture(): {
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
      sessionEvents: new DefaultSessionEventsService(eventStore, sessionStore, broadcaster),
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

async function getEvents(
  app: ReturnType<typeof createControlPlaneApp>,
  path: string,
): Promise<{ data: Array<Record<string, unknown>>; next_page: string | null }> {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as { data: Array<Record<string, unknown>>; next_page: string | null };
}

function sseReader(response: Response): {
  nextEvent(): Promise<{ id?: string; event?: string; data: Record<string, unknown> } | null>;
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
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const frameIdx = buffer.indexOf("\n\n");
        if (frameIdx !== -1) {
          const frame = buffer.slice(0, frameIdx);
          buffer = buffer.slice(frameIdx + 2);
          const lines = frame.split("\n");
          const payload: { id?: string; event?: string; data?: string } = {};
          for (const line of lines) {
            if (line.startsWith("id: ")) payload.id = line.slice(4);
            else if (line.startsWith("event: ")) payload.event = line.slice(7);
            else if (line.startsWith("data: ")) payload.data = line.slice(6);
          }
          if (!payload.data) continue;
          return {
            id: payload.id,
            event: payload.event,
            data: JSON.parse(payload.data) as Record<string, unknown>,
          };
        }
        const next = await reader.read();
        if (next.done) return null;
        buffer += decoder.decode(next.value, { stream: true });
      }
      throw new Error("Timed out waiting for SSE event");
    },
  };
}
