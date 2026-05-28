import { describe, expect, it } from "vitest";
import { createInMemoryControlPlaneApp } from "../app.ts";
import { SessionEventBroadcaster } from "../events/broadcaster.ts";
import { DefaultSessionEventsService } from "../events/service.ts";
import { EventStore } from "../events/store.ts";
import type { RuntimeEventRunner } from "../events/types.ts";
import { SqliteSessionStore } from "../sessions/store.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type {
  ManagedAgentsDeletedSession,
  ManagedAgentsSession,
} from "../../types/sessions.ts";

const VALID_AGENT = {
  name: "Lifecycle Agent",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
};

const VALID_ENVIRONMENT = {
  name: "Lifecycle Environment",
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
  },
};

describe("session lifecycle API", () => {
  it("archives a session without deleting its event history", async () => {
    const runner = new CloseTrackingRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: () => [] },
    });
    const session = await setupSession(app);
    await sendMessage(app, session.id, "before archive");

    const archiveRes = await app.request(`/v1/sessions/${session.id}/archive`, {
      method: "POST",
    });
    expect(archiveRes.status).toBe(200);
    const archived = (await archiveRes.json()) as ManagedAgentsSession;
    expect(archived.id).toBe(session.id);
    expect(archived.status).toBe("terminated");
    expect(archived.archived_at).toEqual(expect.any(String));
    expect(runner.closed).toEqual([session.id]);

    const getRes = await app.request(`/v1/sessions/${session.id}`);
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as ManagedAgentsSession).archived_at).toEqual(
      archived.archived_at,
    );

    const defaultList = await listSessions(app, "/v1/sessions");
    expect(defaultList.data.map((s) => s.id)).not.toContain(session.id);
    const archivedList = await listSessions(app, "/v1/sessions?include_archived=true");
    expect(archivedList.data.map((s) => s.id)).toContain(session.id);

    const sendRes = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          { type: "user.message", content: [{ type: "text", text: "after" }] },
        ],
      }),
    });
    expect(sendRes.status).toBe(404);

    const events = await listEvents(app, session.id);
    expect(events.data.map((event) => event.type)).toEqual([
      "user.message",
      "session.status_terminated",
    ]);
    const streamRes = await app.request(
      `/v1/sessions/${session.id}/events/stream`,
    );
    expect(streamRes.status).toBe(200);
    const streamText = await streamRes.text();
    expect(streamText).toContain("event: user.message");
    expect(streamText).toContain("event: session.status_terminated");

    const secondArchiveRes = await app.request(
      `/v1/sessions/${session.id}/archive`,
      { method: "POST" },
    );
    expect(secondArchiveRes.status).toBe(200);
    const afterSecondArchive = await listEvents(app, session.id);
    expect(afterSecondArchive.data.map((event) => event.type)).toEqual([
      "user.message",
      "session.status_terminated",
    ]);
  });

  it("permanently deletes a session and removes its event history", async () => {
    const runner = new CloseTrackingRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: () => [] },
    });
    const session = await setupSession(app);
    await sendMessage(app, session.id, "before delete");

    const deleteRes = await app.request(`/v1/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);
    expect((await deleteRes.json()) as ManagedAgentsDeletedSession).toEqual({
      id: session.id,
      type: "session_deleted",
    });
    expect(runner.closed).toEqual([session.id]);

    expect((await app.request(`/v1/sessions/${session.id}`)).status).toBe(404);
    expect((await app.request(`/v1/sessions/${session.id}/events`)).status).toBe(404);
    const archivedList = await listSessions(app, "/v1/sessions?include_archived=true");
    expect(archivedList.data.map((s) => s.id)).not.toContain(session.id);
  });

  it("treats runtime cleanup failures as best-effort during archive/delete", async () => {
    const errorSpy = viSpyConsoleError();
    try {
      const runner = new ThrowingCloseRunner();
      const app = createInMemoryControlPlaneApp({
        runtime: { runner, translate: () => [] },
      });
      const archivedSession = await setupSession(app);
      await sendMessage(app, archivedSession.id, "before archive");

      const archiveRes = await app.request(
        `/v1/sessions/${archivedSession.id}/archive`,
        { method: "POST" },
      );
      expect(archiveRes.status).toBe(200);
      expect(runner.closed).toContain(archivedSession.id);
      const archiveEvents = await listEvents(app, archivedSession.id);
      expect(archiveEvents.data.map((event) => event.type)).toEqual([
        "user.message",
        "session.status_terminated",
      ]);

      const deletedSession = await setupSession(app);
      const deleteRes = await app.request(`/v1/sessions/${deletedSession.id}`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(200);
      expect(runner.closed).toContain(deletedSession.id);
      expect((await app.request(`/v1/sessions/${deletedSession.id}`)).status)
        .toBe(404);
      expect((await app.request(`/v1/sessions/${deletedSession.id}/events`)).status)
        .toBe(404);
    } finally {
      errorSpy.restore();
    }
  });

  it("sends a terminal deletion event to live streams before closing them", async () => {
    const app = createInMemoryControlPlaneApp();
    const session = await setupSession(app);
    await sendMessage(app, session.id, "before stream delete");

    const streamRes = await app.request(
      `/v1/sessions/${session.id}/events/stream`,
    );
    expect(streamRes.status).toBe(200);
    const streamText = streamRes.text();
    await delay(10);

    const deleteRes = await app.request(`/v1/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);
    const text = await withTimeout(streamText, 1_000);

    const events = text.match(/^event: .+$/gm) ?? [];
    expect(events.at(0)).toBe("event: user.message");
    expect(events.at(-1)).toBe("event: session.deleted");
  });

  it("does not append late runtime output after archive closes the session", async () => {
    const runner = new DelayedRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: {
        runner,
        translate: (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "late_output"
            ? [
                {
                  type: "agent.message",
                  payload: { content: [{ type: "text", text: "late" }] },
                },
              ]
            : [],
      },
    });
    const session = await setupSession(app);
    await sendMessage(app, session.id, "start runtime");
    await runner.started;

    const archiveRes = await app.request(`/v1/sessions/${session.id}/archive`, {
      method: "POST",
    });
    expect(archiveRes.status).toBe(200);
    runner.release();
    await delay(0);

    const events = await listEvents(app, session.id);
    expect(events.data.map((event) => event.type)).toEqual([
      "user.message",
      "session.status_terminated",
    ]);
  });

  it("retires archive lifecycle guards after in-flight runtime settles", async () => {
    const { eventStore, runner, service, sessionId } = createGuardHarness();

    service.send("wrk_default", sessionId, {
      events: [
        { type: "user.message", content: [{ type: "text", text: "start" }] },
      ],
    });
    await runner.started;

    await service.archiveSession("wrk_default", sessionId);
    expect(guardState(service).closedSessions.has(sessionId)).toBe(true);
    expect(guardState(service).activeRuntimeTasks.get(sessionId)).toBe(1);

    runner.release();
    await waitFor(() => !guardState(service).activeRuntimeTasks.has(sessionId));

    expect(guardState(service).closedSessions.has(sessionId)).toBe(false);
    expect(guardState(service).deletedSessions.has(sessionId)).toBe(false);
    expect(eventStore.list(sessionId).map((event) => event.type)).toEqual([
      "user.message",
      "session.status_terminated",
    ]);
  });

  it("retires delete lifecycle guards after in-flight runtime settles", async () => {
    const { eventStore, runner, service, sessionId } = createGuardHarness();

    service.send("wrk_default", sessionId, {
      events: [
        { type: "user.message", content: [{ type: "text", text: "start" }] },
      ],
    });
    await runner.started;

    await service.deleteSession("wrk_default", sessionId);
    expect(guardState(service).closedSessions.has(sessionId)).toBe(true);
    expect(guardState(service).deletedSessions.has(sessionId)).toBe(true);
    expect(guardState(service).activeRuntimeTasks.get(sessionId)).toBe(1);
    expect(eventStore.list(sessionId)).toEqual([]);

    runner.release();
    await waitFor(() => !guardState(service).activeRuntimeTasks.has(sessionId));

    expect(guardState(service).closedSessions.has(sessionId)).toBe(false);
    expect(guardState(service).deletedSessions.has(sessionId)).toBe(false);
    expect(eventStore.list(sessionId)).toEqual([]);
  });
});

interface GuardHarness {
  eventStore: EventStore;
  runner: DelayedRunner;
  service: DefaultSessionEventsService;
  sessionId: string;
}

interface GuardState {
  closedSessions: Set<string>;
  deletedSessions: Set<string>;
  activeRuntimeTasks: Map<string, number>;
}

function createGuardHarness(): GuardHarness {
  const sessionId = `sesn_${Math.random().toString(16).slice(2)}`;
  const eventStore = EventStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  const runner = new DelayedRunner();
  const service = new DefaultSessionEventsService(
    eventStore,
    sessionStore,
    new SessionEventBroadcaster(eventStore),
    {
      runner,
      translate: (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: unknown }).type === "late_output"
          ? [
              {
                type: "agent.message",
                payload: { content: [{ type: "text", text: "late" }] },
              },
            ]
          : [],
    },
  );
  const now = new Date().toISOString();
  sessionStore.create({
    row: {
      id: sessionId,
      workspace_id: "wrk_default",
      type: "session",
      agent: { type: "agent", id: "agent_guard", version: 1 },
      environment_id: "env_guard",
      status: "idle",
      title: null,
      metadata: {},
      created_at: now,
      updated_at: now,
      archived_at: null,
      usage: null,
    },
  });
  return { eventStore, runner, service, sessionId };
}

function guardState(service: DefaultSessionEventsService): GuardState {
  return service as unknown as GuardState;
}

class CloseTrackingRunner implements RuntimeEventRunner {
  readonly closed: string[] = [];

  async *runUserMessage(): AsyncIterable<unknown> {}

  async closeSession(_workspaceId: string, sessionId: string): Promise<void> {
    this.closed.push(sessionId);
  }
}

class ThrowingCloseRunner extends CloseTrackingRunner {
  override async closeSession(
    workspaceId: string,
    sessionId: string,
  ): Promise<void> {
    await super.closeSession(workspaceId, sessionId);
    throw new Error("runtime cleanup failed");
  }
}

class DelayedRunner implements RuntimeEventRunner {
  private resume: (() => void) | undefined;
  readonly started: Promise<void>;
  private markStarted: (() => void) | undefined;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
  }

  async *runUserMessage(): AsyncIterable<unknown> {
    await new Promise<void>((resolve) => {
      this.resume = resolve;
      this.markStarted?.();
    });
    yield { type: "late_output" };
  }

  async closeSession(): Promise<void> {}

  release(): void {
    this.resume?.();
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) {
      throw new Error("timed out waiting for lifecycle guards to retire");
    }
    await delay(0);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function viSpyConsoleError(): { restore(): void } {
  const original = console.error;
  console.error = () => {};
  return {
    restore() {
      console.error = original;
    },
  };
}

async function setupSession(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
): Promise<ManagedAgentsSession> {
  const agent = await createAgent(app);
  const environment = await createEnvironment(app);
  return createSession(app, {
    agent: agent.id,
    environment_id: environment.id,
  });
}

async function sendMessage(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
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

async function listEvents(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  sessionId: string,
): Promise<{ data: Array<Record<string, unknown>>; next_page: string | null }> {
  const res = await app.request(`/v1/sessions/${sessionId}/events?order=asc`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    data: Array<Record<string, unknown>>;
    next_page: string | null;
  };
}

async function listSessions(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  path: string,
): Promise<{ data: ManagedAgentsSession[] }> {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as { data: ManagedAgentsSession[] };
}

async function createAgent(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
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
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
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
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
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
