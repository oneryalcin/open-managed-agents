import { describe, expect, it, vi } from "vitest";
import { createControlPlaneApp } from "./helpers.ts";
import { DefaultAgentService } from "../agents/service.ts";
import { SqliteAgentStore } from "../agents/store.ts";
import { DefaultEnvironmentService } from "../environments/service.ts";
import { SqliteEnvironmentStore } from "../environments/store.ts";
import { SessionEventBroadcaster } from "../events/broadcaster.ts";
import { createBestEffortRuntimeEventCoordinator } from "../deployment-runtime-event-coordinator.ts";
import { materializePersistedEvents } from "../events/persist.ts";
import { DefaultSessionEventsService } from "../events/service.ts";
import { EventStore } from "../events/store.ts";
import type {
  RuntimeActionCloseReason,
  RuntimeCustomToolUseEvent,
  RuntimeEventRunner,
} from "../events/types.ts";
import { DefaultSessionService } from "../sessions/service.ts";
import { translatePiEvent } from "../sessions/pi/translator.ts";
import { SqliteSessionStore } from "../sessions/store.ts";
import type { CreateSessionRecord, SessionRow, SessionStore } from "../sessions/types.ts";
import { STREAM_TEST_TIMEOUT_MS, hasTimedOut } from "./test-timeouts.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsListPage } from "../../types/common.ts";
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

describe("Custom tool API round trip", () => {
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

  it("emits model request spans across a live custom-tool wait", async () => {
    const runner = new ModelSpanningCustomToolRunner();
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
            event.type === "span.model_request_end" &&
            event.model_request_start_id !== undefined,
        ) &&
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

    await sendCustomToolResult(fixture.app, session.id, customUse?.id as string, [
      { type: "text", text: "external answer" },
    ]);

    const final = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) =>
        events.some((event) => event.type === "agent.message") &&
        events.filter((event) => event.type === "span.model_request_end").length ===
          2,
    );

    expect(types(final)).toEqual([
      "user.message",
      "session.status_running",
      "span.model_request_start",
      "agent.custom_tool_use",
      "span.model_request_end",
      "session.status_idle",
      "user.custom_tool_result",
      "session.status_running",
      "span.model_request_start",
      "agent.message",
      "span.model_request_end",
      "session.status_idle",
    ]);
    const spanStarts = final.filter(
      (event) => event.type === "span.model_request_start",
    );
    const spanEnds = final.filter(
      (event) => event.type === "span.model_request_end",
    );
    expect(spanEnds).toHaveLength(2);
    expect(spanEnds[0]).toMatchObject({
      model_request_start_id: spanStarts[0]?.id,
      is_error: false,
      model_usage: {
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
        input_tokens: 101,
        output_tokens: 11,
        speed: null,
      },
    });
    expect(spanEnds[1]).toMatchObject({
      model_request_start_id: spanStarts[1]?.id,
      is_error: false,
      model_usage: {
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 5,
        input_tokens: 103,
        output_tokens: 13,
        speed: null,
      },
    });
    expect(final[9]?.content).toEqual([
      { type: "text", text: "runtime saw: external answer" },
    ]);
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

  it("accepts an identical stale custom tool result without resolving runtime twice", async () => {
    const runner = new FakeCustomToolRunner();
    const fixture = makeFixture(runner);
    const session = await setupSession(fixture.app);

    await sendMessage(fixture.app, session.id, "ask");
    const waiting = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.custom_tool_use"),
    );
    const customUse = waiting.find(
      (event) => event.type === "agent.custom_tool_use",
    );
    const content = [{ type: "text" as const, text: "external answer" }];

    await sendCustomToolResult(
      fixture.app,
      session.id,
      customUse?.id as string,
      content,
    );
    await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.message"),
    );

    await sendCustomToolResult(
      fixture.app,
      session.id,
      customUse?.id as string,
      content,
    );

    const final = await getEvents(fixture.app, session.id);
    expect(
      final.filter((event) => event.type === "user.custom_tool_result"),
    ).toHaveLength(2);
    expect(
      final.filter((event) => event.type === "agent.message"),
    ).toHaveLength(1);
    expect(runner.claimCount).toBe(1);
  });

  it("replays an identical in-flight custom tool result without terminalizing the turn", async () => {
    const runner = new DelayedResumeCustomToolRunner();
    const fixture = makeFixture(runner);
    const session = await setupSession(fixture.app);

    await sendMessage(fixture.app, session.id, "ask");
    const waiting = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.custom_tool_use"),
    );
    const customUse = waiting.find(
      (event) => event.type === "agent.custom_tool_use",
    );
    const content = [{ type: "text" as const, text: "external answer" }];

    const accepted = await sendCustomToolResult(
      fixture.app,
      session.id,
      customUse?.id as string,
      content,
    );
    const replay = await sendCustomToolResult(
      fixture.app,
      session.id,
      customUse?.id as string,
      content,
    );

    expect(replay.id).toBe(accepted.id);
    expect(runner.claimCount).toBe(1);

    runner.release();
    const final = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.message"),
    );
    expect(
      final.filter((event) => event.type === "user.custom_tool_result"),
    ).toHaveLength(1);
    expect(final.some((event) => event.type === "session.error")).toBe(false);
  });

  it("replays an idempotent live custom tool result without resolving runtime twice", async () => {
    const runner = new DelayedResumeCustomToolRunner();
    const fixture = makeFixture(runner);
    const session = await setupSession(fixture.app);

    await sendMessage(fixture.app, session.id, "ask");
    const waiting = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.custom_tool_use"),
    );
    const customUse = waiting.find(
      (event) => event.type === "agent.custom_tool_use",
    );
    const content = [{ type: "text" as const, text: "external answer" }];

    const accepted = await sendCustomToolResult(
      fixture.app,
      session.id,
      customUse?.id as string,
      content,
      "custom-tool-idempotent-retry",
    );
    const replay = await sendCustomToolResult(
      fixture.app,
      session.id,
      customUse?.id as string,
      content,
      "custom-tool-idempotent-retry",
    );

    expect(replay).toEqual(accepted);
    expect(runner.claimCount).toBe(1);

    runner.release();
    const final = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.message"),
    );
    expect(
      final.filter((event) => event.type === "user.custom_tool_result"),
    ).toHaveLength(1);
    expect(final.some((event) => event.type === "session.error")).toBe(false);
  });

  it("keeps an idempotent custom tool result committed when the callback throws", async () => {
    const runner = new ThrowingCommitCustomToolRunner();
    const fixture = makeFixture(runner);
    const session = await setupSession(fixture.app);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await sendMessage(fixture.app, session.id, "ask");
      const waiting = await eventuallyEvents(
        fixture.app,
        session.id,
        (events) => events.some((event) => event.type === "agent.custom_tool_use"),
      );
      const customUse = waiting.find(
        (event) => event.type === "agent.custom_tool_use",
      );
      const content = [{ type: "text" as const, text: "external answer" }];

      const accepted = await sendCustomToolResult(
        fixture.app,
        session.id,
        customUse?.id as string,
        content,
        "throwing-custom-tool-result",
      );
      const replay = await sendCustomToolResult(
        fixture.app,
        session.id,
        customUse?.id as string,
        content,
        "throwing-custom-tool-result",
      );

      expect(replay).toEqual(accepted);
      expect(runner.claimCount).toBe(1);
      // Logger emits one JSON line per event (0121 C1).
      const callbackFailure = errorSpy.mock.calls
        .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
        .find((record) => record.event === "custom_tool_result_callback_failed");
      expect(callbackFailure).toMatchObject({
        sessionId: session.id,
        customToolUseId: customUse?.id,
        error: { name: "Error" },
      });
      const final = await getEvents(fixture.app, session.id);
      expect(
        final.filter((event) => event.type === "user.custom_tool_result"),
      ).toHaveLength(1);
    } finally {
      runner.release();
      errorSpy.mockRestore();
    }
  });

  it("rejects a different duplicate custom tool result before persistence", async () => {
    const runner = new FakeCustomToolRunner();
    const fixture = makeFixture(runner);
    const session = await setupSession(fixture.app);

    await sendMessage(fixture.app, session.id, "ask");
    const waiting = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.custom_tool_use"),
    );
    const customUse = waiting.find(
      (event) => event.type === "agent.custom_tool_use",
    );

    await sendCustomToolResult(
      fixture.app,
      session.id,
      customUse?.id as string,
      [{ type: "text", text: "external answer" }],
    );
    await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.message"),
    );

    const res = await fixture.app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: customUse?.id,
            content: [{ type: "text", text: "different" }],
            is_error: false,
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const final = await getEvents(fixture.app, session.id);
    expect(
      final.filter((event) => event.type === "user.custom_tool_result"),
    ).toHaveLength(1);
    expect(runner.claimCount).toBe(1);
  });

  it("terminalizes a custom tool result when runtime state is lost", async () => {
    const fixture = makeFixture(new FakeCustomToolRunner(), { leaseTtlMs: -1 });
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

    const recreated = fixture.recreate(new NoPendingCustomToolRunner());
    fixture.service.recoverAbandonedRuntimeTurns("wrk_default");
    await sendCustomToolResult(
      recreated,
      session.id,
      customUse?.id as string,
      [{ type: "text", text: "late" }],
    );

    const final = await getEvents(recreated, session.id);
    expect(final.at(-2)).toMatchObject({
      type: "session.error",
      message: expect.stringContaining("runtime state is no longer available"),
    });
    expect(final.at(-1)).toMatchObject({
      type: "session.status_idle",
      stop_reason: { type: "end_turn" },
    });
    expect(
      final.filter((event) => event.type === "user.custom_tool_result"),
    ).toHaveLength(1);
  });

  it("interrupt closes durable custom tool waits after restart", async () => {
    const fixture = makeFixture(new FakeCustomToolRunner());
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

    const recreated = fixture.recreate(new NoPendingCustomToolRunner());
    const interrupt = await recreated.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ type: "user.interrupt" }] }),
    });
    expect(interrupt.status).toBe(200);

    const stale = await recreated.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: customUse?.id,
            content: [{ type: "text", text: "stale" }],
            is_error: false,
          },
        ],
      }),
    });
    expect(stale.status).toBe(404);
  });

  it("skips recovery for archived sessions left with pending runtime turns after restart", async () => {
    const runner = new FakeImmediateRunner();
    const fixture = makeFixture(runner);
    const session = await setupSession(fixture.app);
    const now = new Date().toISOString();
    const [row] = materializePersistedEvents(
      "wrk_default",
      session.id,
      [
        {
          type: "user.message",
          payload: { content: [{ type: "text", text: "should not recover" }] },
        },
      ],
      now,
    );
    fixture.eventStore.appendBatchWithRuntimeChanges([row], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId: session.id,
          turnId: "rtun_archived_skip",
          ownerId: "owner_crashed",
          ownerGeneration: 1,
          leaseExpiresAt: now,
          triggerEventIds: [row.id],
          now,
        },
      ],
    });

    fixture.service.archiveSessionRowAfterPreflight("wrk_default", session.id);
    const before = fixture.eventStore.list("wrk_default", session.id, { order: "asc" });

    const recreated = fixture.recreate(new FakeImmediateRunner());
    fixture.service.recoverAbandonedRuntimeTurns("wrk_default");

    const after = fixture.eventStore.list("wrk_default", session.id, { order: "asc" });
    expect(after).toHaveLength(before.length);
    expect(runner.prompts).toEqual([]);
    expect(after.map((event) => event.type)).toEqual(before.map((event) => event.type));
  });

  it("closes open model request spans before archive termination", async () => {
    const fixture = makeFixture(new FakeImmediateRunner());
    const session = await setupSession(fixture.app);
    const now = new Date().toISOString();
    const [userRow, spanStartRow] = materializePersistedEvents(
      "wrk_default",
      session.id,
      [
        {
          type: "user.message",
          payload: { content: [{ type: "text", text: "archive with open span" }] },
        },
        { type: "span.model_request_start", payload: {} },
      ],
      now,
    );
    fixture.eventStore.appendBatchWithRuntimeChanges([userRow, spanStartRow], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId: session.id,
          turnId: "rtun_archive_open_span",
          ownerId: "owner_crashed",
          ownerGeneration: 1,
          leaseExpiresAt: now,
          triggerEventIds: [userRow.id],
          now,
        },
      ],
    });
    fixture.eventStore.appendBatchWithRuntimeChanges([], {
      openedModelRequestStarts: [
        {
          workspaceId: "wrk_default",
          sessionId: session.id,
          turnId: "rtun_archive_open_span",
          ownerId: "owner_crashed",
          ownerGeneration: 1,
          startEventId: spanStartRow.id,
          now,
        },
      ],
    });

    await fixture.service.archiveSession("wrk_default", session.id);

    const final = fixture.eventStore.list("wrk_default", session.id, {
      order: "asc",
    });
    expect(final.map((event) => event.type)).toEqual([
      "user.message",
      "span.model_request_start",
      "span.model_request_end",
      "session.status_terminated",
    ]);
    expect(final[2]?.payload).toMatchObject({
      model_request_start_id: spanStartRow.id,
      is_error: true,
    });
    expect(fixture.eventStore.listPendingRuntimeTurns("wrk_default")).toEqual([]);
  });

  it("skips recovery for deleted sessions left with pending runtime turns after restart", async () => {
    const fixture = makeFixture(new FakeImmediateRunner());
    const session = await setupSession(fixture.app);
    const now = new Date().toISOString();
    const [row] = materializePersistedEvents(
      "wrk_default",
      session.id,
      [
        {
          type: "user.message",
          payload: { content: [{ type: "text", text: "should stay deleted" }] },
        },
      ],
      now,
    );
    fixture.eventStore.appendBatchWithRuntimeChanges([row], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId: session.id,
          turnId: "rtun_deleted_skip",
          ownerId: "owner_crashed",
          ownerGeneration: 1,
          leaseExpiresAt: now,
          triggerEventIds: [row.id],
          now,
        },
      ],
    });

    fixture.sessionStore.delete("wrk_default", session.id);
    const before = fixture.eventStore.list("wrk_default", session.id, { order: "asc" });

    fixture.service.recoverAbandonedRuntimeTurns("wrk_default");

    const after = fixture.eventStore.list("wrk_default", session.id, { order: "asc" });
    expect(after).toHaveLength(before.length);
    expect(after.map((event) => event.type)).toEqual(before.map((event) => event.type));
  });

  it("recovers an accepted user-message turn from durable trigger event IDs", async () => {
    const runner = new FakeImmediateRunner();
    const fixture = makeFixture(runner);
    const session = await setupSession(fixture.app);
    const now = new Date().toISOString();
    const [row] = materializePersistedEvents(
      "wrk_default",
      session.id,
      [
        {
          type: "user.message",
          payload: { content: [{ type: "text", text: "recover me" }] },
        },
      ],
      now,
    );
    fixture.eventStore.appendBatchWithRuntimeChanges([row], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId: session.id,
          turnId: "rtun_recover_accepted",
          ownerId: "owner_crashed",
          ownerGeneration: 1,
          leaseExpiresAt: now,
          triggerEventIds: [row.id],
          now,
        },
      ],
    });

    fixture.service.recoverAbandonedRuntimeTurns("wrk_default");

    const final = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.message"),
    );
    expect(runner.prompts).toEqual(["recover me"]);
    expect(final.map((event) => event.type)).toEqual([
      "user.message",
      "agent.message",
      "session.status_idle",
    ]);
  });

  it("closes open model request spans when terminalizing an abandoned running turn", async () => {
    const fixture = makeFixture(new FakeImmediateRunner());
    const session = await setupSession(fixture.app);
    const now = new Date().toISOString();
    const [userRow, spanStartRow] = materializePersistedEvents(
      "wrk_default",
      session.id,
      [
        {
          type: "user.message",
          payload: { content: [{ type: "text", text: "lost running turn" }] },
        },
        { type: "span.model_request_start", payload: {} },
      ],
      now,
    );
    fixture.eventStore.appendBatchWithRuntimeChanges([userRow, spanStartRow], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId: session.id,
          turnId: "rtun_abandoned_open_span",
          ownerId: "owner_crashed",
          ownerGeneration: 1,
          leaseExpiresAt: now,
          triggerEventIds: [userRow.id],
          now,
        },
      ],
    });
    fixture.eventStore.appendBatchWithRuntimeChanges([], {
      turnStates: [
        {
          workspaceId: "wrk_default",
          sessionId: session.id,
          turnId: "rtun_abandoned_open_span",
          ownerId: "owner_crashed",
          ownerGeneration: 1,
          state: "running",
          now,
        },
      ],
      openedModelRequestStarts: [
        {
          workspaceId: "wrk_default",
          sessionId: session.id,
          turnId: "rtun_abandoned_open_span",
          ownerId: "owner_crashed",
          ownerGeneration: 1,
          startEventId: spanStartRow.id,
          now,
        },
      ],
    });

    fixture.service.recoverAbandonedRuntimeTurns("wrk_default");

    const final = fixture.eventStore.list("wrk_default", session.id, {
      order: "asc",
    });
    expect(final.map((event) => event.type)).toEqual([
      "user.message",
      "span.model_request_start",
      "span.model_request_end",
      "session.error",
      "session.status_idle",
    ]);
    expect(final[2]?.payload).toEqual({
      model_request_start_id: spanStartRow.id,
      is_error: true,
      model_usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        speed: null,
      },
    });
    expect(fixture.eventStore.listPendingRuntimeTurns("wrk_default")).toEqual([]);
  });

  it("retries startup recovery after a foreign runtime lease expires", async () => {
    const runner = new FakeImmediateRunner();
    const fixture = makeFixture(runner);
    const session = await setupSession(fixture.app);
    const now = new Date().toISOString();
    const [row] = materializePersistedEvents(
      "wrk_default",
      session.id,
      [
        {
          type: "user.message",
          payload: { content: [{ type: "text", text: "recover after ttl" }] },
        },
      ],
      now,
    );
    fixture.eventStore.appendBatchWithRuntimeChanges([row], {
      acceptedTurns: [
        {
          workspaceId: "wrk_default",
          sessionId: session.id,
          turnId: "rtun_recover_after_ttl",
          ownerId: "owner_crashed",
          ownerGeneration: 1,
          leaseExpiresAt: new Date(Date.now() + 20).toISOString(),
          triggerEventIds: [row.id],
          now,
        },
      ],
    });

    fixture.service.recoverAbandonedRuntimeTurns("wrk_default");
    expect(runner.prompts).toEqual([]);

    const final = await eventuallyEvents(
      fixture.app,
      session.id,
      (events) => events.some((event) => event.type === "agent.message"),
    );
    expect(runner.prompts).toEqual(["recover after ttl"]);
    expect(final.map((event) => event.type)).toEqual([
      "user.message",
      "agent.message",
      "session.status_idle",
    ]);
  });

  it("scopes abandoned-turn recovery guards by workspace when session IDs collide", async () => {
    const runner = new FakeImmediateRunner();
    const eventStore = EventStore.open(":memory:");
    const sessionStore = new CollidingSessionStore([
      sessionRow({ workspaceId: "wrk_default", sessionId: "sesn_shared_recovery" }),
      sessionRow({ workspaceId: "wrk_other", sessionId: "sesn_shared_recovery" }),
    ]);
    const service = new DefaultSessionEventsService(
      eventStore,
      sessionStore,
      new SessionEventBroadcaster(eventStore),
      {
        runner,
        translate: translatePiEvent,
        runtimeEventCoordinator: createBestEffortRuntimeEventCoordinator({
          sessions: sessionStore,
          events: eventStore,
        }),
      },
    );

    const now = new Date().toISOString();
    const [row] = materializePersistedEvents(
      "wrk_other",
      "sesn_shared_recovery",
      [
        {
          type: "user.message",
          payload: { content: [{ type: "text", text: "recover other workspace" }] },
        },
      ],
      now,
    );
    eventStore.appendBatchWithRuntimeChanges([row], {
      acceptedTurns: [
        {
          workspaceId: "wrk_other",
          sessionId: "sesn_shared_recovery",
          turnId: "rtun_cross_workspace_recover",
          ownerId: "owner_crashed",
          ownerGeneration: 1,
          leaseExpiresAt: now,
          triggerEventIds: [row.id],
          now,
        },
      ],
    });

    service.archiveSessionRowAfterPreflight("wrk_default", "sesn_shared_recovery");
    service.recoverAbandonedRuntimeTurns("wrk_other");

    const final = await eventuallyPersistedEvents(
      eventStore,
      "wrk_other",
      "sesn_shared_recovery",
      (events) => events.some((event) => event.type === "agent.message"),
    );
    expect(runner.prompts).toEqual(["recover other workspace"]);
    expect(final.map((event) => event.type)).toEqual([
      "user.message",
      "agent.message",
      "session.status_idle",
    ]);
  });

  it("arms abandoned-turn recovery when a new accepted turn is persisted", async () => {
    vi.useFakeTimers();
    try {
      const runner = new BlockingRunner();
      const fixture = makeFixture(runner, { leaseTtlMs: 5 });
      const recoverSpy = vi.spyOn(fixture.service, "recoverAbandonedRuntimeTurns");
      const session = await setupSession(fixture.app);

      await sendMessage(fixture.app, session.id, "hang");
      expect(recoverSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(20);
      expect(recoverSpy).toHaveBeenCalledWith("wrk_default");
      runner.release();
    } finally {
      vi.useRealTimers();
    }
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
    const staleResult = await fixture.app.request(
      `/v1/sessions/${session.id}/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: firstUse?.id,
              content: [{ type: "text", text: "stale" }],
              is_error: false,
            },
          ],
        }),
      },
    );
    expect(staleResult.status).toBe(404);
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
  claimCount = 0;
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
    return () => {
      this.claimCount += 1;
      this.resolveResult?.(event);
    };
  }

  customToolNames(): ReadonlySet<string> {
    return new Set(["ask_user"]);
  }
}

class ModelSpanningCustomToolRunner implements RuntimeEventRunner {
  boundCustomToolUseId: string | undefined;
  private resolveResult:
    | ((event: ManagedAgentsUserCustomToolResultEventInput) => void)
    | undefined;

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    yield assistantModelRequestStart();
    const result = new Promise<ManagedAgentsUserCustomToolResultEventInput>(
      (resolve) => {
        this.resolveResult = resolve;
      },
    );
    yield {
      type: "oma.custom_tool_use",
      piToolCallId: "toolu_fake_custom_span",
      name: "ask_user",
      input: { question: "probe?" },
      bindCustomToolUseId: (id) => {
        this.boundCustomToolUseId = id;
      },
      rejectCustomToolUse: () => {},
    } satisfies RuntimeCustomToolUseEvent;
    yield assistantModelRequestEnd({
      content: [],
      stopReason: "toolUse",
      usage: { input: 101, output: 11, cacheRead: 2, cacheWrite: 3 },
    });

    const toolResult = await result;
    const text = textContent(toolResult);
    yield assistantModelRequestStart();
    yield assistantModelRequestEnd({
      content: [{ type: "text", text: `runtime saw: ${text}` }],
      stopReason: "stop",
      usage: { input: 103, output: 13, cacheRead: 5, cacheWrite: 7 },
    });
    yield { type: "agent_end", messages: [], willRetry: false };
  }

  claimCustomToolResult(
    _workspaceId: string,
    _sessionId: string,
    event: ManagedAgentsUserCustomToolResultEventInput,
  ): (() => void) | undefined {
    if (event.custom_tool_use_id !== this.boundCustomToolUseId) return undefined;
    return () => {
      this.resolveResult?.(event);
    };
  }

  customToolNames(): ReadonlySet<string> {
    return new Set(["ask_user"]);
  }
}

class DelayedResumeCustomToolRunner implements RuntimeEventRunner {
  boundCustomToolUseId: string | undefined;
  claimCount = 0;
  private resolveResult:
    | ((event: ManagedAgentsUserCustomToolResultEventInput) => void)
    | undefined;
  private readonly releaseGate = deferred<void>();

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    const result = new Promise<ManagedAgentsUserCustomToolResultEventInput>(
      (resolve) => {
        this.resolveResult = resolve;
      },
    );
    yield {
      type: "oma.custom_tool_use",
      piToolCallId: "toolu_fake_custom_delayed",
      name: "ask_user",
      input: { question: "probe?" },
      bindCustomToolUseId: (id) => {
        this.boundCustomToolUseId = id;
      },
      rejectCustomToolUse: () => {},
    } satisfies RuntimeCustomToolUseEvent;

    const toolResult = await result;
    await this.releaseGate.promise;
    yield {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `runtime saw: ${textContent(toolResult)}` }],
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
    return () => {
      this.claimCount += 1;
      this.resolveResult?.(event);
      this.resolveResult = undefined;
    };
  }

  customToolNames(): ReadonlySet<string> {
    return new Set(["ask_user"]);
  }

  release(): void {
    this.releaseGate.resolve(undefined);
  }
}

class ThrowingCommitCustomToolRunner implements RuntimeEventRunner {
  boundCustomToolUseId: string | undefined;
  claimCount = 0;
  private readonly releaseGate = deferred<void>();

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    yield {
      type: "oma.custom_tool_use",
      piToolCallId: "toolu_throwing_commit",
      name: "ask_user",
      input: { question: "probe?" },
      bindCustomToolUseId: (id) => {
        this.boundCustomToolUseId = id;
      },
      rejectCustomToolUse: () => {},
    } satisfies RuntimeCustomToolUseEvent;
    await this.releaseGate.promise;
    yield { type: "agent_end", messages: [], willRetry: false };
  }

  claimCustomToolResult(
    _workspaceId: string,
    _sessionId: string,
    event: ManagedAgentsUserCustomToolResultEventInput,
  ): (() => void) | undefined {
    if (event.custom_tool_use_id !== this.boundCustomToolUseId) return undefined;
    return () => {
      this.claimCount += 1;
      throw new Error("custom tool callback failed");
    };
  }

  customToolNames(): ReadonlySet<string> {
    return new Set(["ask_user"]);
  }

  release(): void {
    this.releaseGate.resolve(undefined);
  }
}

class NoPendingCustomToolRunner implements RuntimeEventRunner {
  async *runUserMessage(): AsyncIterable<unknown> {}

  claimCustomToolResult(): (() => void) | undefined {
    return undefined;
  }

  customToolNames(): ReadonlySet<string> {
    return new Set(["ask_user"]);
  }
}

class FakeImmediateRunner implements RuntimeEventRunner {
  readonly prompts: string[] = [];

  async *runUserMessage(
    _workspaceId: string,
    _sessionId: string,
    text: string,
  ): AsyncIterable<unknown> {
    this.prompts.push(text);
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

  customToolNames(): ReadonlySet<string> {
    return new Set(["ask_user"]);
  }
}

class BlockingRunner implements RuntimeEventRunner {
  private readonly gate = deferred<void>();

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    await this.gate.promise;
    yield { type: "agent_end", messages: [], willRetry: false };
  }

  release(): void {
    this.gate.resolve(undefined);
  }
}

class CollidingSessionStore implements SessionStore {
  private readonly rows = new Map<string, SessionRow>();

  constructor(rows: SessionRow[]) {
    for (const row of rows) {
      this.rows.set(this.key(row.workspace_id, row.id), row);
    }
  }

  create(record: CreateSessionRecord): SessionRow {
    this.rows.set(this.key(record.row.workspace_id, record.row.id), record.row);
    return record.row;
  }

  countActive(workspaceId: string): number {
    return [...this.rows.values()].filter(
      (row) => row.workspace_id === workspaceId && row.archived_at === null,
    ).length;
  }

  retrieve(workspaceId: string, sessionId: string): SessionRow | undefined {
    const row = this.retrieveAny(workspaceId, sessionId);
    if (!row || row.archived_at !== null) return undefined;
    return row;
  }

  retrieveAny(workspaceId: string, sessionId: string): SessionRow | undefined {
    return this.rows.get(this.key(workspaceId, sessionId));
  }

  archive(
    workspaceId: string,
    sessionId: string,
    archivedAt: string,
  ): SessionRow | undefined {
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

  delete(workspaceId: string, sessionId: string): SessionRow | undefined {
    const row = this.retrieveAny(workspaceId, sessionId);
    if (!row) return undefined;
    this.rows.delete(this.key(workspaceId, sessionId));
    return row;
  }

  getFileMountSnapshots(): [] {
    return [];
  }
  getSkillSnapshots(): [] { return []; }

  listPendingInternalSnapshotDeleteWorkspaces(): [] {
    return [];
  }

  getPendingInternalSnapshotDeletes(): [] {
    return [];
  }

  recordPendingInternalSnapshotDeleteAttempt(): void {}

  clearPendingInternalSnapshotDelete(): void {}

  recordPendingInternalSnapshotCreateRollback(): void {}

  listPendingInternalSnapshotCreateRollbackWorkspaces(): [] {
    return [];
  }

  getPendingInternalSnapshotCreateRollbacks(): [] {
    return [];
  }

  recordPendingInternalSnapshotCreateRollbackAttempt(): void {}

  clearPendingInternalSnapshotCreateRollback(): void {}

  list(
    workspaceId: string,
    opts: { includeArchived?: boolean } = {},
  ): ManagedAgentsListPage<SessionRow> {
    return {
      data: [...this.rows.values()].filter((row) => {
        if (row.workspace_id !== workspaceId) return false;
        return opts.includeArchived === true || row.archived_at === null;
      }),
      next_page: null,
      has_more: false,
    };
  }

  private key(workspaceId: string, sessionId: string): string {
    return JSON.stringify([workspaceId, sessionId]);
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
  private releaseFirst:
    | ((reason?: RuntimeActionCloseReason) => void)
    | undefined;
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
    this.releaseFirst?.("timeout");
  }

  continueWithSecond(): void {
    this.continue.resolve(undefined);
  }
}

function makeFixture(
  runner: RuntimeEventRunner,
  opts: { leaseTtlMs?: number } = {},
): {
  app: ReturnType<typeof createControlPlaneApp>;
  eventStore: EventStore;
  sessionStore: SqliteSessionStore;
  service: DefaultSessionEventsService;
  recreate(runner: RuntimeEventRunner): ReturnType<typeof createControlPlaneApp>;
} {
  const agentStore = SqliteAgentStore.open(":memory:");
  const environmentStore = SqliteEnvironmentStore.open(":memory:");
  const sessionStore = SqliteSessionStore.open(":memory:");
  const eventStore = EventStore.open(":memory:");
  let currentService!: DefaultSessionEventsService;
  const buildApp = (runtimeRunner: RuntimeEventRunner) => {
    const broadcaster = new SessionEventBroadcaster(eventStore);
    currentService = new DefaultSessionEventsService(
      eventStore,
      sessionStore,
      broadcaster,
      {
        runner: runtimeRunner,
        translate: translatePiEvent,
        runtimeEventCoordinator: createBestEffortRuntimeEventCoordinator({
          sessions: sessionStore,
          events: eventStore,
        }),
        ...(opts.leaseTtlMs === undefined ? {} : { leaseTtlMs: opts.leaseTtlMs }),
      },
    );
    return createControlPlaneApp({
      agents: new DefaultAgentService(agentStore, undefined),
      environments: new DefaultEnvironmentService(environmentStore),
      sessions: new DefaultSessionService(sessionStore, agentStore, environmentStore, undefined, {
        assertDeletable: () => {},
      }),
      sessionEvents: currentService,
    });
  };
  const app = buildApp(runner);
  return {
    app,
    eventStore,
    sessionStore,
    get service() {
      return currentService;
    },
    recreate: buildApp,
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
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (idempotencyKey !== undefined) {
    headers["idempotency-key"] = idempotencyKey;
  }
  const res = await app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers,
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
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data[0];
}

async function getEvents(
  app: ReturnType<typeof createControlPlaneApp>,
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await app.request(`/v1/sessions/${sessionId}/events?order=asc`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
}

async function eventuallyPersistedEvents(
  eventStore: EventStore,
  workspaceId: string,
  sessionId: string,
  predicate: (events: Array<{ type: string }>) => boolean,
): Promise<Array<{ type: string }>> {
  const startedAt = Date.now();
  while (!hasTimedOut(startedAt, STREAM_TEST_TIMEOUT_MS)) {
    const events = eventStore.list(workspaceId, sessionId, { order: "asc" });
    if (predicate(events)) return events;
    await delay(5);
  }
  throw new Error("timed out waiting for expected persisted events");
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

function assistantModelRequestStart(): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      role: "assistant",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-4-7",
    },
  };
}

function assistantModelRequestEnd(opts: {
  content: ManagedAgentsContentBlock[];
  stopReason: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}): Record<string, unknown> {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: opts.content,
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-4-7",
      usage: opts.usage,
      stopReason: opts.stopReason,
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionRow(opts: {
  workspaceId: string;
  sessionId: string;
}): SessionRow {
  return {
    id: opts.sessionId,
    workspace_id: opts.workspaceId,
    type: "session",
    agent: { type: "agent", id: "agent_collision", version: 1 },
    environment_id: "env_collision",
    status: "idle",
    title: null,
    metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null,
    usage: null,
    resources: [],
  };
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
