import { describe, expect, it } from "vitest";
import {
  createControlPlaneApp,
  createInMemoryControlPlaneApp,
} from "./helpers.ts";
import { DefaultAgentService } from "../agents/service.ts";
import { SqliteAgentStore } from "../agents/store.ts";
import { createBestEffortRuntimeEventCoordinator } from "../deployment-runtime-event-coordinator.ts";
import { DefaultEnvironmentService } from "../environments/service.ts";
import { SqliteEnvironmentStore } from "../environments/store.ts";
import { SessionEventBroadcaster } from "../events/broadcaster.ts";
import { DefaultSessionEventsService } from "../events/service.ts";
import { EventStore } from "../events/store.ts";
import type {
  PersistedSessionEvent,
  RuntimeCustomToolUseEvent,
  RuntimeEventRunner,
  RuntimeEventTranslator,
  SessionEventBroadcaster as SessionEventBroadcasterContract,
} from "../events/types.ts";
import { SqliteSessionStore } from "../sessions/store.ts";
import type {
  CreateSessionRecord,
  ListSessionsOptions,
  SessionFileMountSnapshotRow,
  SessionRow,
  SessionStore,
} from "../sessions/types.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type {
  ManagedAgentsDeletedSession,
  ManagedAgentsSession,
  ManagedAgentsSessionStatus,
} from "../../types/sessions.ts";
import { DefaultSessionService } from "../sessions/service.ts";
import type { WorkspaceId } from "../workspace.ts";

const VALID_AGENT = {
  name: "Lifecycle Agent",
  model: "claude-opus-4-7",
  tools: [{ type: "agent_toolset_20260401" }],
};

const VALID_ENVIRONMENT = {
  name: "Lifecycle Environment",
  config: {
    type: "cloud",
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

  it("publishes archive terminal event to live streams without closing them", async () => {
    const app = createInMemoryControlPlaneApp();
    const session = await setupSession(app);
    await sendMessage(app, session.id, "before stream archive");

    const streamRes = await app.request(
      `/v1/sessions/${session.id}/events/stream`,
    );
    expect(streamRes.status).toBe(200);
    const reader = createSseReader(streamRes);
    const first = await reader.nextEvent();
    expect(first?.event).toBe("user.message");

    const archiveRes = await app.request(`/v1/sessions/${session.id}/archive`, {
      method: "POST",
    });
    expect(archiveRes.status).toBe(200);

    const terminal = await reader.nextEvent();
    expect(terminal?.event).toBe("session.status_terminated");

    await expect(reader.nextReadWithin(50)).resolves.toBe("timeout");
    await reader.cancel();
  });

  it("rejects archive while a runtime turn is active without mutation or cleanup", async () => {
    const runner = new DelayedRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: {
        runner,
        translate: () => [],
      },
    });
    const session = await setupSession(app);
    await sendMessage(app, session.id, "start runtime");
    await runner.started;

    const archiveRes = await app.request(`/v1/sessions/${session.id}/archive`, {
      method: "POST",
    });
    expect(archiveRes.status).toBe(400);
    expect(await archiveRes.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: archiveRunningMessage(session.id, "running"),
      },
    });
    expect(runner.closed).toEqual([]);

    const activeRes = await app.request(`/v1/sessions/${session.id}`);
    expect(activeRes.status).toBe(200);
    const active = (await activeRes.json()) as ManagedAgentsSession;
    expect(active.archived_at).toBe(null);

    const eventsBeforeRelease = await listEvents(app, session.id);
    expect(eventsBeforeRelease.data.map((event) => event.type)).toEqual([
      "user.message",
    ]);

    runner.release();
    await waitFor(() => runner.completed === 1);

    const events = await listEvents(app, session.id);
    expect(events.data.map((event) => event.type)).toEqual(["user.message"]);
  });

  it("archives after interrupt lets the active runtime settle", async () => {
    const runner = new DelayedRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: () => [] },
    });
    const session = await setupSession(app);
    await sendMessage(app, session.id, "start runtime");
    await runner.started;

    await sendInterrupt(app, session.id);
    await waitFor(() => runner.completed === 1);

    const archiveRes = await app.request(`/v1/sessions/${session.id}/archive`, {
      method: "POST",
    });
    expect(archiveRes.status).toBe(200);
    expect(runner.interrupted).toEqual([session.id]);
    expect(runner.closed).toEqual([session.id]);

    const archived = (await archiveRes.json()) as ManagedAgentsSession;
    expect(archived.status).toBe("terminated");
    expect(archived.archived_at).toEqual(expect.any(String));

    const events = await listEvents(app, session.id);
    expect(events.data.map((event) => event.type)).toEqual([
      "user.message",
      "user.interrupt",
      "session.status_terminated",
    ]);
  });

  it("rejects delete while a runtime turn is active without mutation or cleanup", async () => {
    const runner = new DelayedRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: {
        runner,
        translate: () => [],
      },
    });
    const session = await setupSession(app);
    await sendMessage(app, session.id, "start runtime");
    await runner.started;

    const deleteRes = await app.request(`/v1/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(400);
    expect(await deleteRes.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        message: DELETE_RUNNING_MESSAGE,
      },
    });
    expect(runner.closed).toEqual([]);

    // The rejected delete must leave the session running and readable (probe 38).
    const activeRes = await app.request(`/v1/sessions/${session.id}`);
    expect(activeRes.status).toBe(200);

    const eventsBeforeRelease = await listEvents(app, session.id);
    expect(eventsBeforeRelease.data.map((event) => event.type)).toEqual([
      "user.message",
    ]);

    runner.release();
    await waitFor(() => runner.completed === 1);
  });

  it("deletes after interrupt lets the active runtime settle", async () => {
    const runner = new DelayedRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: () => [] },
    });
    const session = await setupSession(app);
    await sendMessage(app, session.id, "start runtime");
    await runner.started;

    await sendInterrupt(app, session.id);
    await waitFor(() => runner.completed === 1);

    const deleteRes = await app.request(`/v1/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);
    expect((await deleteRes.json()) as ManagedAgentsDeletedSession).toEqual({
      id: session.id,
      type: "session_deleted",
    });
    expect(runner.interrupted).toEqual([session.id]);
    expect(runner.closed).toEqual([session.id]);

    expect((await app.request(`/v1/sessions/${session.id}`)).status).toBe(404);
  });

  it("archives a session paused on custom-tool requires_action", async () => {
    const runner = new PausedCustomToolRunner();
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: () => [] },
    });
    const session = await setupSession(app);
    await sendMessage(app, session.id, "ask external");
    await waitFor(() => runner.boundCustomToolUseId !== undefined);
    await waitFor(async () => {
      const events = await listEvents(app, session.id);
      return events.data.some(
        (event) =>
          event.type === "session.status_idle" &&
          (event.stop_reason as { type?: unknown } | undefined)?.type ===
            "requires_action",
      );
    });

    const archiveRes = await app.request(`/v1/sessions/${session.id}/archive`, {
      method: "POST",
    });

    expect(archiveRes.status).toBe(200);
    expect(runner.closed).toEqual([session.id]);
    const archived = (await archiveRes.json()) as ManagedAgentsSession;
    expect(archived.status).toBe("terminated");
    expect(archived.archived_at).toEqual(expect.any(String));

    const events = await listEvents(app, session.id);
    expect(events.data.map((event) => event.type)).toEqual([
      "user.message",
      "agent.custom_tool_use",
      "session.status_idle",
      "session.status_terminated",
    ]);
  });

  it("deletes a session paused on custom-tool requires_action without accepting stale results", async () => {
    const runner = new PausedCustomToolRunner();
    const fixture = createLifecycleFixture({
      runner,
      translate: () => [],
    });
    const session = await setupSession(fixture.app);
    await sendMessage(fixture.app, session.id, "ask external");
    await waitFor(() => runner.boundCustomToolUseId !== undefined);
    await waitFor(async () => {
      const events = await listEvents(fixture.app, session.id);
      return events.data.some(
        (event) =>
          event.type === "session.status_idle" &&
          (event.stop_reason as { type?: unknown } | undefined)?.type ===
            "requires_action",
      );
    });

    const deleteRes = await fixture.app.request(`/v1/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);
    expect(runner.closed).toEqual([session.id]);

    const staleResult = await fixture.app.request(
      `/v1/sessions/${session.id}/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: runner.boundCustomToolUseId,
              content: [{ type: "text", text: "too late" }],
            },
          ],
        }),
      },
    );
    expect(staleResult.status).toBe(404);
    expect((await fixture.app.request(`/v1/sessions/${session.id}/events`)).status)
      .toBe(404);
    expect(fixture.eventStore.listPendingRuntimeTurns("wrk_default")).toEqual([]);
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
    expect(guardState(service).closedSessions.has(sessionScopeKey("wrk_default", sessionId))).toBe(true);
    expect(guardState(service).activeRuntimeTasks.get(sessionScopeKey("wrk_default", sessionId))).toBe(1);

    runner.release();
    await waitFor(
      () =>
        !guardState(service).activeRuntimeTasks.has(
          sessionScopeKey("wrk_default", sessionId),
        ),
    );

    expect(guardState(service).closedSessions.has(sessionScopeKey("wrk_default", sessionId))).toBe(false);
    expect(guardState(service).deletedSessions.has(sessionScopeKey("wrk_default", sessionId))).toBe(false);
    expect(eventStore.list("wrk_default", sessionId).map((event) => event.type)).toEqual([
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
    expect(guardState(service).closedSessions.has(sessionScopeKey("wrk_default", sessionId))).toBe(true);
    expect(guardState(service).deletedSessions.has(sessionScopeKey("wrk_default", sessionId))).toBe(true);
    expect(guardState(service).activeRuntimeTasks.get(sessionScopeKey("wrk_default", sessionId))).toBe(1);
    expect(eventStore.list("wrk_default", sessionId)).toEqual([]);

    runner.release();
    await waitFor(
      () =>
        !guardState(service).activeRuntimeTasks.has(
          sessionScopeKey("wrk_default", sessionId),
        ),
    );

    expect(guardState(service).closedSessions.has(sessionScopeKey("wrk_default", sessionId))).toBe(false);
    expect(guardState(service).deletedSessions.has(sessionScopeKey("wrk_default", sessionId))).toBe(false);
    expect(eventStore.list("wrk_default", sessionId)).toEqual([]);
  });

  it("does not emit runtime failure events after archive closes a running session", async () => {
    const { eventStore, runner, service, sessionId } =
      createRuntimeFailureHarness();

    service.send("wrk_default", sessionId, {
      events: [
        { type: "user.message", content: [{ type: "text", text: "start" }] },
      ],
    });
    await runner.started;

    await service.archiveSession("wrk_default", sessionId);
    await waitFor(
      () =>
        !guardState(service).activeRuntimeTasks.has(
          sessionScopeKey("wrk_default", sessionId),
        ),
    );

    expect(eventStore.list("wrk_default", sessionId).map((event) => event.type))
      .toEqual(["user.message", "session.status_terminated"]);
  });

  it("does not resurrect deleted event history after runtime failure", async () => {
    const { eventStore, runner, service, sessionId } =
      createRuntimeFailureHarness();

    service.send("wrk_default", sessionId, {
      events: [
        { type: "user.message", content: [{ type: "text", text: "start" }] },
      ],
    });
    await runner.started;

    await service.deleteSession("wrk_default", sessionId);
    await waitFor(
      () =>
        !guardState(service).activeRuntimeTasks.has(
          sessionScopeKey("wrk_default", sessionId),
        ),
    );

    expect(eventStore.list("wrk_default", sessionId)).toEqual([]);
  });

  it("allows terminated sessions and rejects rescheduling sessions at archive preflight", () => {
    const terminated = createGuardHarness({ status: "terminated" });
    const archivedTerminated = terminated.service.archiveSessionRowAfterPreflight(
      "wrk_default",
      terminated.sessionId,
    );
    expect(archivedTerminated.status).toBe("terminated");
    expect(archivedTerminated.archived_at).toEqual(expect.any(String));

    const archivedAgain = terminated.service.archiveSessionRowAfterPreflight(
        "wrk_default",
        terminated.sessionId,
    );
    expect(archivedAgain.archived_at).toBe(archivedTerminated.archived_at);

    const rescheduling = createGuardHarness({ status: "rescheduling" });
    expect(() =>
      rescheduling.service.archiveSessionRowAfterPreflight(
        "wrk_default",
        rescheduling.sessionId,
      ),
    ).toThrow(archiveRunningMessage(rescheduling.sessionId, "rescheduling"));

    const running = createGuardHarness({ status: "running" });
    expect(() =>
      running.service.archiveSessionRowAfterPreflight(
        "wrk_default",
        running.sessionId,
      ),
    ).toThrow(archiveRunningMessage(running.sessionId, "running"));
  });

  it("rejects sends during the archive preflight-to-mutation window without side effects", () => {
    const runner = new ClaimingRunner();
    const { broadcaster, eventStore, service, sessionId, store } =
      createArchiveGuardHarness({ runner });
    guardState(service).pendingCustomToolActions.entries.set(sessionScopeKey("wrk_default", sessionId), {
      workspaceId: "wrk_default",
      ids: ["sevt_pending_tool"],
      timer: undefined,
    });
    let observed = false;

    store.onArchive = () => {
      observed = true;
      expect(() =>
        service.send("wrk_default", sessionId, {
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: "sevt_pending_tool",
              content: [{ type: "text", text: "done" }],
            },
          ],
        }),
      ).toThrow(`Session ${sessionId} not found`);
      expect(eventStore.list("wrk_default", sessionId)).toEqual([]);
      expect(broadcaster.published).toEqual([]);
      expect(runner.claimed).toEqual([]);
      expect(
        guardState(service).activeRuntimeTasks.has(
          sessionScopeKey("wrk_default", sessionId),
        ),
      ).toBe(false);
      expect(
        guardState(service).pendingCustomToolActions.entries.get(
          sessionScopeKey("wrk_default", sessionId),
        )?.ids,
      ).toEqual(["sevt_pending_tool"]);
    };

    const archived = service.archiveSessionRowAfterPreflight(
      "wrk_default",
      sessionId,
    );

    expect(observed).toBe(true);
    expect(archived.status).toBe("terminated");
  });

  it("releases the archive guard if row mutation throws", () => {
    const { eventStore, service, sessionId, store } = createArchiveGuardHarness();
    store.throwNextArchive = true;

    expect(() =>
      service.archiveSessionRowAfterPreflight("wrk_default", sessionId),
    ).toThrow("archive failed");

    service.send("wrk_default", sessionId, {
      events: [
        { type: "user.message", content: [{ type: "text", text: "after" }] },
      ],
    });
    expect(eventStore.list("wrk_default", sessionId).map((event) => event.type)).toEqual([
      "user.message",
    ]);
  });

  it("keeps sends blocked until overlapping archive preflights fully release", () => {
    const { eventStore, service, sessionId, store } = createArchiveGuardHarness();
    let checkedDuringOuterArchive = false;

    store.onArchive = () => {
      if (checkedDuringOuterArchive) return;
      checkedDuringOuterArchive = true;
      store.throwNextArchive = true;
      expect(() =>
        service.archiveSessionRowAfterPreflight("wrk_default", sessionId),
      ).toThrow("archive failed");
      expect(() =>
        service.send("wrk_default", sessionId, {
          events: [
            {
              type: "user.message",
              content: [{ type: "text", text: "during outer" }],
            },
          ],
        }),
      ).toThrow(`Session ${sessionId} not found`);
      expect(eventStore.list("wrk_default", sessionId)).toEqual([]);
    };

    service.archiveSessionRowAfterPreflight("wrk_default", sessionId);

    expect(checkedDuringOuterArchive).toBe(true);
    expect(eventStore.list("wrk_default", sessionId)).toEqual([]);
  });

  it("scopes the archive guard by workspace and session identity", () => {
    const sharedSessionId = "sesn_shared_guard";
    const { eventStore, service, store } = createArchiveGuardHarness({
      sessionId: sharedSessionId,
      workspaces: ["wrk_a", "wrk_b"],
    });
    let sentInOtherWorkspace = false;

    store.onArchive = (workspaceId) => {
      if (workspaceId !== "wrk_a") return;
      service.send("wrk_b", sharedSessionId, {
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "other workspace" }],
          },
        ],
      });
      sentInOtherWorkspace = true;
    };

    service.archiveSessionRowAfterPreflight("wrk_a", sharedSessionId);

    expect(sentInOtherWorkspace).toBe(true);
    expect(store.retrieveAny("wrk_a", sharedSessionId)?.archived_at).toEqual(
      expect.any(String),
    );
    expect(store.retrieveAny("wrk_b", sharedSessionId)?.archived_at).toBe(null);
    expect(eventStore.list("wrk_b", sharedSessionId).map((event) => event.type)).toEqual([
      "user.message",
    ]);
  });
});

interface GuardHarness {
  eventStore: EventStore;
  runner: DelayedRunner;
  service: DefaultSessionEventsService;
  sessionId: string;
}

interface ArchiveGuardHarness {
  broadcaster: RecordingBroadcaster;
  eventStore: EventStore;
  runner: RuntimeEventRunner | undefined;
  service: DefaultSessionEventsService;
  sessionId: string;
  store: HookedSessionStore;
}

interface LifecycleFixture {
  app: ReturnType<typeof createControlPlaneApp>;
  eventStore: EventStore;
}

interface GuardState {
  archivingSessions: Map<string, number>;
  closedSessions: Set<string>;
  deletedSessions: Set<string>;
  activeRuntimeTasks: Map<string, number>;
  pendingCustomToolActions: {
    entries: Map<
      string,
      {
        workspaceId: WorkspaceId;
        ids: string[];
        timer: ReturnType<typeof setTimeout> | undefined;
      }
    >;
  };
}

function createGuardHarness(
  opts: { status?: ManagedAgentsSessionStatus } = {},
): GuardHarness {
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
      runtimeEventCoordinator: createBestEffortRuntimeEventCoordinator({
        sessions: sessionStore,
        events: eventStore,
      }),
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
      status: opts.status ?? "idle",
      title: null,
      metadata: {},
      created_at: now,
      updated_at: now,
      archived_at: null,
      usage: null,
      resources: [],
    },
  });
  return { eventStore, runner, service, sessionId };
}

function createLifecycleFixture(opts: {
  runner: RuntimeEventRunner;
  translate: RuntimeEventTranslator;
}): LifecycleFixture {
  const agentStore = SqliteAgentStore.open(":memory:");
  const environmentStore = SqliteEnvironmentStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  const eventStore = EventStore.open(":memory:");
  const broadcaster = new SessionEventBroadcaster(eventStore);
  let sessionEvents!: DefaultSessionEventsService;
  sessionEvents = new DefaultSessionEventsService(
    eventStore,
    sessionStore,
    broadcaster,
    {
      runner: opts.runner,
      translate: opts.translate,
      runtimeEventCoordinator: createBestEffortRuntimeEventCoordinator({
        sessions: sessionStore,
        events: eventStore,
      }),
    },
  );
  return {
    app: createControlPlaneApp({
      agents: new DefaultAgentService(agentStore, undefined),
      environments: new DefaultEnvironmentService(environmentStore),
      sessions: new DefaultSessionService(
        sessionStore,
        agentStore,
        environmentStore,
        undefined,
        {
          assertDeletable: (workspaceId, sessionId) =>
            sessionEvents.assertSessionDeletable(workspaceId, sessionId),
        },
      ),
      sessionEvents,
    }),
    eventStore,
  };
}

function createRuntimeFailureHarness(): {
  eventStore: EventStore;
  runner: ThrowingAfterCloseRunner;
  service: DefaultSessionEventsService;
  sessionId: string;
} {
  const sessionId = `sesn_${Math.random().toString(16).slice(2)}`;
  const eventStore = EventStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  const runner = new ThrowingAfterCloseRunner();
  const service = new DefaultSessionEventsService(
    eventStore,
    sessionStore,
    new SessionEventBroadcaster(eventStore),
    {
      runner,
      translate: () => [],
      runtimeEventCoordinator: createBestEffortRuntimeEventCoordinator({
        sessions: sessionStore,
        events: eventStore,
      }),
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
      resources: [],
    },
  });
  return { eventStore, runner, service, sessionId };
}

function guardState(service: DefaultSessionEventsService): GuardState {
  return service as unknown as GuardState;
}

function sessionScopeKey(workspaceId: WorkspaceId, sessionId: string): string {
  return JSON.stringify([workspaceId, sessionId]);
}

function createArchiveGuardHarness(
  opts: {
    runner?: RuntimeEventRunner;
    sessionId?: string;
    status?: ManagedAgentsSessionStatus;
    workspaces?: WorkspaceId[];
  } = {},
): ArchiveGuardHarness {
  const sessionId =
    opts.sessionId ?? `sesn_${Math.random().toString(16).slice(2)}`;
  const eventStore = EventStore.open(":memory:");
  const store = new HookedSessionStore();
  const broadcaster = new RecordingBroadcaster();
  const service = new DefaultSessionEventsService(
    eventStore,
    store,
    broadcaster,
    opts.runner === undefined
      ? undefined
      : {
          runner: opts.runner,
          translate: () => [],
          runtimeEventCoordinator: createBestEffortRuntimeEventCoordinator({
            sessions: store,
            events: eventStore,
          }),
        },
  );
  for (const workspaceId of opts.workspaces ?? ["wrk_default"]) {
    store.create({
      row: sessionRow({
        sessionId,
        status: opts.status ?? "idle",
        workspaceId,
      }),
    });
  }
  return {
    broadcaster,
    eventStore,
    runner: opts.runner,
    service,
    sessionId,
    store,
  };
}

function sessionRow(opts: {
  sessionId: string;
  status: ManagedAgentsSessionStatus;
  workspaceId: WorkspaceId;
}): SessionRow {
  const now = new Date().toISOString();
  return {
    id: opts.sessionId,
    workspace_id: opts.workspaceId,
    type: "session",
    agent: { type: "agent", id: "agent_guard", version: 1 },
    environment_id: "env_guard",
    status: opts.status,
    title: null,
    metadata: {},
    created_at: now,
    updated_at: now,
    archived_at: null,
    usage: null,
    resources: [],
  };
}

class HookedSessionStore implements SessionStore {
  private readonly rows = new Map<string, SessionRow>();
  onArchive:
    | ((workspaceId: WorkspaceId, sessionId: string) => void)
    | undefined;
  throwNextArchive = false;

  create(record: CreateSessionRecord): SessionRow {
    this.rows.set(this.key(record.row.workspace_id, record.row.id), record.row);
    return record.row;
  }

  countActive(workspaceId: WorkspaceId): number {
    return [...this.rows.values()].filter(
      (row) => row.workspace_id === workspaceId && row.archived_at === null,
    ).length;
  }

  hasEnvironmentReference(workspaceId: WorkspaceId, environmentId: string): boolean {
    return [...this.rows.values()].some(
      (row) => row.workspace_id === workspaceId && row.environment_id === environmentId,
    );
  }

  retrieve(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): SessionRow | undefined {
    const row = this.retrieveAny(workspaceId, sessionId);
    if (!row || row.archived_at !== null || row.status === "terminated") {
      return undefined;
    }
    return row;
  }

  retrieveAny(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): SessionRow | undefined {
    return this.rows.get(this.key(workspaceId, sessionId));
  }

  archive(
    workspaceId: WorkspaceId,
    sessionId: string,
    archivedAt: string,
  ): SessionRow | undefined {
    const shouldThrow = this.throwNextArchive;
    this.throwNextArchive = false;
    this.onArchive?.(workspaceId, sessionId);
    if (shouldThrow) throw new Error("archive failed");
    const row = this.retrieveAny(workspaceId, sessionId);
    if (!row) return undefined;
    const next: SessionRow = {
      ...row,
      status: "terminated",
      archived_at: row.archived_at ?? archivedAt,
      updated_at: row.archived_at === null ? archivedAt : row.updated_at,
    };
    this.rows.set(this.key(workspaceId, sessionId), next);
    return next;
  }

  delete(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): SessionRow | undefined {
    const row = this.retrieveAny(workspaceId, sessionId);
    if (!row) return undefined;
    this.rows.delete(this.key(workspaceId, sessionId));
    return row;
  }

  getFileMountSnapshots(): SessionFileMountSnapshotRow[] {
    return [];
  }
  getSkillSnapshots(): [] { return []; }

  listPendingInternalSnapshotDeleteWorkspaces(): WorkspaceId[] {
    return [];
  }

  getPendingInternalSnapshotDeletes(): [] {
    return [];
  }

  recordPendingInternalSnapshotDeleteAttempt(): void {}

  clearPendingInternalSnapshotDelete(): void {}

  recordPendingInternalSnapshotCreateRollback(): void {}

  listPendingInternalSnapshotCreateRollbackWorkspaces(): WorkspaceId[] {
    return [];
  }

  getPendingInternalSnapshotCreateRollbacks(): [] {
    return [];
  }

  recordPendingInternalSnapshotCreateRollbackAttempt(): void {}

  clearPendingInternalSnapshotCreateRollback(): void {}

  list(
    workspaceId: WorkspaceId,
    opts: ListSessionsOptions = {},
  ): import("../sessions/types.ts").SessionListPage<SessionRow> {
    const data = [...this.rows.values()].filter((row) => {
      if (row.workspace_id !== workspaceId) return false;
      return opts.includeArchived === true
        ? true
        : row.archived_at === null && row.status !== "terminated";
    });
    return { data, next_page: null, prev_page: null };
  }

  private key(workspaceId: WorkspaceId, sessionId: string): string {
    return JSON.stringify([workspaceId, sessionId]);
  }
}

class RecordingBroadcaster implements SessionEventBroadcasterContract {
  readonly published: PersistedSessionEvent[] = [];
  readonly closed: string[] = [];

  publishPersisted(events: readonly PersistedSessionEvent[]): void {
    this.published.push(...events);
  }

  closeSession(sessionId: string): void {
    this.closed.push(sessionId);
  }

  async *subscribe(): AsyncIterable<PersistedSessionEvent> {}
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
  readonly closed: string[] = [];
  readonly interrupted: string[] = [];
  completed = 0;
  private markStarted: (() => void) | undefined;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
  }

  async *runUserMessage(): AsyncIterable<unknown> {
    try {
      await new Promise<void>((resolve) => {
        this.resume = resolve;
        this.markStarted?.();
      });
      yield { type: "late_output" };
    } finally {
      this.completed += 1;
    }
  }

  async interruptSession(_workspaceId: string, sessionId: string): Promise<void> {
    this.interrupted.push(sessionId);
    this.release();
  }

  async closeSession(_workspaceId: string, sessionId: string): Promise<void> {
    this.closed.push(sessionId);
  }

  release(): void {
    this.resume?.();
  }
}

class ThrowingAfterCloseRunner implements RuntimeEventRunner {
  readonly started: Promise<void>;
  private markStarted: (() => void) | undefined;
  private resume: (() => void) | undefined;

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
    throw new Error("runtime failed after close");
  }

  async closeSession(): Promise<void> {
    this.resume?.();
  }
}

class ClaimingRunner extends DelayedRunner {
  readonly claimed: string[] = [];

  claimCustomToolResult(
    _workspaceId: string,
    _sessionId: string,
    event: { custom_tool_use_id: string },
  ): () => void {
    this.claimed.push(event.custom_tool_use_id);
    return () => {};
  }
}

class PausedCustomToolRunner implements RuntimeEventRunner {
  readonly closed: string[] = [];
  boundCustomToolUseId: string | undefined;
  private resolveResult: (() => void) | undefined;

  async *runUserMessage(): AsyncIterable<unknown> {
    const result = new Promise<void>((resolve) => {
      this.resolveResult = resolve;
    });
    yield {
      type: "oma.custom_tool_use",
      piToolCallId: "toolu_archive_pause",
      name: "ask_user",
      input: { question: "continue?" },
      bindCustomToolUseId: (id) => {
        this.boundCustomToolUseId = id;
      },
      rejectCustomToolUse: () => {
        this.resolveResult?.();
      },
    } satisfies RuntimeCustomToolUseEvent;
    await result;
  }

  async closeSession(_workspaceId: string, sessionId: string): Promise<void> {
    this.closed.push(sessionId);
    this.resolveResult?.();
  }

  customToolNames(): ReadonlySet<string> {
    return new Set(["ask_user"]);
  }
}

function archiveRunningMessage(
  sessionId: string,
  status: "running" | "rescheduling",
): string {
  return `Session ${sessionId} cannot be archived while its status is "${status}". Only pending or idle sessions may be archived.`;
}

// Verbatim hosted CMA delete-while-running error (probe 38).
const DELETE_RUNNING_MESSAGE =
  "Cannot delete session while it is running. Send an interrupt event or wait for the session to complete.";

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
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

function createSseReader(response: Response): {
  nextEvent(): Promise<{ event?: string; data?: Record<string, unknown> } | null>;
  nextReadWithin(ms: number): Promise<"closed" | "data" | "timeout">;
  cancel(): Promise<void>;
} {
  const body = response.body;
  if (!body) throw new Error("Expected streaming response body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async nextEvent() {
      while (true) {
        const frameIdx = buffer.indexOf("\n\n");
        if (frameIdx !== -1) {
          const frame = buffer.slice(0, frameIdx);
          buffer = buffer.slice(frameIdx + 2);
          const lines = frame.split("\n");
          const payload: { event?: string; data?: string } = {};
          for (const line of lines) {
            if (line.startsWith("event: ")) payload.event = line.slice(7);
            else if (line.startsWith("data: ")) payload.data = line.slice(6);
          }
          return {
            event: payload.event,
            data:
              payload.data === undefined
                ? undefined
                : (JSON.parse(payload.data) as Record<string, unknown>),
          };
        }
        const next = await reader.read();
        if (next.done) return null;
        buffer += decoder.decode(next.value, { stream: true });
      }
    },
    async nextReadWithin(ms) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), ms);
          }),
        ]);
        if (result === "timeout") return "timeout";
        return result.done ? "closed" : "data";
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async cancel() {
      await reader.cancel();
    },
  };
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

async function sendInterrupt(
  app: ReturnType<typeof createInMemoryControlPlaneApp>,
  sessionId: string,
): Promise<void> {
  const res = await app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [{ type: "user.interrupt" }] }),
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
