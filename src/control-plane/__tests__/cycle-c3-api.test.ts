import { describe, expect, it } from "vitest";
import { createControlPlaneApp } from "../app.ts";
import { DefaultAgentService } from "../agents/service.ts";
import { SqliteAgentStore } from "../agents/store.ts";
import { DefaultEnvironmentService } from "../environments/service.ts";
import { SqliteEnvironmentStore } from "../environments/store.ts";
import { SessionEventBroadcaster } from "../events/broadcaster.ts";
import { DefaultSessionEventsService } from "../events/service.ts";
import { EventStore } from "../events/store.ts";
import { DefaultSessionService } from "../sessions/service.ts";
import { PiSessionRunner } from "../sessions/pi/runner.ts";
import { translatePiEvent } from "../sessions/pi/translator.ts";
import { SqliteSessionStore } from "../sessions/store.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";

const VALID_AGENT = {
  name: "C3 Agent",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
};

const VALID_ENVIRONMENT = {
  name: "C3 Environment",
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
  },
};

describe("Cycle C.3 API", () => {
  it("does not persist idle before a queued follow-up response drains", async () => {
    const gate = deferred<void>();
    const fixture = makeFixture(new FakeQueuedSessionFactory(gate.promise));
    const session = await setupSession(fixture.app);

    const first = sendMessage(fixture.app, session.id, "one");
    await until(() => fixture.factory.sessions[0]?.running === true);
    await sendMessage(fixture.app, session.id, "two");

    const beforeDrain = await getEvents(fixture.app, session.id);
    expect(types(beforeDrain)).not.toContain("session.status_idle");

    gate.resolve();
    await first;
    await until(() => {
      const events = fixture.eventStore.list(session.id);
      return (
        events.filter((event) => event.type === "agent.message").length === 2 &&
        events.filter((event) => event.type === "session.status_idle").length === 1
      );
    });

    const afterDrain = await getEvents(fixture.app, session.id);
    const eventTypes = types(afterDrain);
    const secondAgentIndex = eventTypes.lastIndexOf("agent.message");
    const idleIndex = eventTypes.indexOf("session.status_idle");
    expect(secondAgentIndex).toBeGreaterThan(-1);
    expect(idleIndex).toBeGreaterThan(secondAgentIndex);
    expect(eventTypes.filter((type) => type === "session.status_idle")).toHaveLength(1);
  });
});

class FakeQueuedSessionFactory {
  readonly sessions: FakeQueuedSession[] = [];

  constructor(private readonly gate: Promise<void>) {}

  async create(): Promise<FakeQueuedSession> {
    const session = new FakeQueuedSession(this.gate);
    this.sessions.push(session);
    return session;
  }
}

class FakeQueuedSession {
  readonly followUps: string[] = [];
  private readonly listeners = new Set<(event: unknown) => void>();
  running = false;

  constructor(private readonly gate: Promise<void>) {}

  async prompt(text: string): Promise<void> {
    this.emit({ type: "agent_start" });
    this.emitAssistant(text);
    await this.gate;
    for (const followUp of this.followUps) {
      this.emitAssistant(followUp);
    }
    this.emit({ type: "agent_end", messages: [], willRetry: false });
  }

  async followUp(text: string): Promise<void> {
    this.followUps.push(text);
  }

  async abort(): Promise<void> {}

  dispose(): void {
    this.listeners.clear();
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: unknown): void {
    const type = (event as { type?: unknown }).type;
    if (type === "agent_start") this.running = true;
    if (type === "agent_end") this.running = false;
    for (const listener of this.listeners) listener(event);
  }

  private emitAssistant(text: string): void {
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `runtime: ${text}` }],
        stopReason: "stop",
      },
    });
  }
}

function makeFixture(factory: FakeQueuedSessionFactory): {
  app: ReturnType<typeof createControlPlaneApp>;
  eventStore: EventStore;
  factory: FakeQueuedSessionFactory;
} {
  const agentStore = SqliteAgentStore.open(":memory:");
  const environmentStore = SqliteEnvironmentStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  const eventStore = EventStore.open(":memory:");
  const broadcaster = new SessionEventBroadcaster(eventStore);
  const runner = new PiSessionRunner({
    sessionFactory: () => factory.create(),
    idleTtlMs: 0,
  });
  return {
    eventStore,
    factory,
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

async function getEvents(
  app: ReturnType<typeof createControlPlaneApp>,
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await app.request(`/v1/sessions/${sessionId}/events?order=asc`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
}

function types(events: Array<Record<string, unknown>>): unknown[] {
  return events.map((event) => event.type);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1_000) {
      throw new Error("timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
