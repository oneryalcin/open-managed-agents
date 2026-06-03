import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { newEventId } from "../../../types/events.ts";
import { EventStore } from "../store.ts";
import type { PersistedSessionEvent } from "../types.ts";

const WORKSPACE_ID = "wrk_default";

describe("event store", () => {
  it("keeps legacy list() default limit (1000) for afterId scans when limit is omitted", () => {
    const store = EventStore.open(":memory:");
    const sessionId = "sesn_store_test";
    const events: PersistedSessionEvent[] = [];

    for (let index = 0; index < 31; index += 1) {
      const now = new Date().toISOString();
      const event: PersistedSessionEvent = {
        id: newEventId(),
        workspace_id: WORKSPACE_ID,
        session_id: sessionId,
        type: "user.message",
        processed_at: now,
        payload: { content: [{ type: "text", text: `m${index}` }] },
        created_at: now,
      };
      events.push(event);
      store.append(event);
    }

    const sinceFirst = store.list(WORKSPACE_ID, sessionId, {
      afterId: events[0].id,
    });

    expect(sinceFirst).toHaveLength(30);
    expect(sinceFirst[0].id).toBe(events[1].id);
    expect(sinceFirst[29].id).toBe(events[30].id);
  });

  it("uses listPage() API default limit (20) when limit is omitted", () => {
    const store = EventStore.open(":memory:");
    const sessionId = "sesn_store_test_page";

    for (let index = 0; index < 25; index += 1) {
      const now = new Date().toISOString();
      store.append({
        id: newEventId(),
        workspace_id: WORKSPACE_ID,
        session_id: sessionId,
        type: "user.message",
        processed_at: now,
        payload: { content: [{ type: "text", text: `p${index}` }] },
        created_at: now,
      });
    }

    const page = store.listPage(WORKSPACE_ID, sessionId);
    expect(page.data).toHaveLength(20);
    expect(page.next_page).toEqual(expect.stringMatching(/^sevt_/));
  });

  it("commits event rows and runtime ledger changes atomically", () => {
    const store = EventStore.open(":memory:");
    const sessionId = "sesn_store_runtime";
    const now = new Date().toISOString();
    const event: PersistedSessionEvent = {
      id: newEventId(),
      workspace_id: WORKSPACE_ID,
      session_id: sessionId,
      type: "user.message",
      processed_at: now,
      payload: { content: [{ type: "text", text: "start" }] },
      created_at: now,
    };

    store.appendBatchWithRuntimeChanges([event], {
      acceptedTurns: [
        {
          workspaceId: WORKSPACE_ID,
          sessionId,
          turnId: "rtun_store_runtime",
          ownerId: "owner_store",
          ownerGeneration: 1,
          leaseExpiresAt: now,
          triggerEventIds: [event.id],
          now,
        },
      ],
    });

    expect(store.list(WORKSPACE_ID, sessionId).map((row) => row.id)).toEqual([
      event.id,
    ]);
    expect(store.listPendingRuntimeTurns(WORKSPACE_ID)).toMatchObject([
      {
        session_id: sessionId,
        turn_id: "rtun_store_runtime",
        state: "accepted",
        trigger_event_ids: [event.id],
      },
    ]);
  });

  it("stores pending runtime actions and closes them with their turn", () => {
    const store = EventStore.open(":memory:");
    const sessionId = "sesn_store_runtime_action";
    const now = new Date().toISOString();

    store.appendBatchWithRuntimeChanges([], {
      acceptedTurns: [
        {
          workspaceId: WORKSPACE_ID,
          sessionId,
          turnId: "rtun_store_action",
          ownerId: "owner_store",
          ownerGeneration: 1,
          leaseExpiresAt: now,
          triggerEventIds: ["sevt_trigger"],
          now,
        },
      ],
      openedActions: [
        {
          workspaceId: WORKSPACE_ID,
          sessionId,
          turnId: "rtun_store_action",
          actionId: "sevt_action",
          actionType: "custom_tool",
          now,
        },
      ],
    });

    expect(
      store.findRuntimeAction(WORKSPACE_ID, sessionId, "sevt_action"),
    ).toMatchObject({
      action_id: "sevt_action",
      action_type: "custom_tool",
      state: "pending",
      turn: { state: "accepted" },
    });

    store.appendBatchWithRuntimeChanges([], {
      closedTurns: [
        {
          workspaceId: WORKSPACE_ID,
          sessionId,
          turnId: "rtun_store_action",
          reason: "terminalized",
          state: "terminalized",
          now,
        },
      ],
    });

    expect(
      store.findRuntimeAction(WORKSPACE_ID, sessionId, "sevt_action"),
    ).toMatchObject({
      state: "closed",
      close_reason: "terminalized",
      turn: { state: "terminalized" },
    });
    expect(store.listPendingRuntimeTurns(WORKSPACE_ID)).toEqual([]);

    store.deleteForSession(WORKSPACE_ID, sessionId);
    expect(store.findRuntimeAction(WORKSPACE_ID, sessionId, "sevt_action")).toBeUndefined();
  });

  it("tracks open model request start ids on pending runtime turns", () => {
    const store = EventStore.open(":memory:");
    const sessionId = "sesn_store_open_spans";
    const now = new Date().toISOString();

    store.appendBatchWithRuntimeChanges([], {
      acceptedTurns: [
        {
          workspaceId: WORKSPACE_ID,
          sessionId,
          turnId: "rtun_store_open_spans",
          ownerId: "owner_store",
          ownerGeneration: 1,
          leaseExpiresAt: now,
          triggerEventIds: ["sevt_trigger"],
          now,
        },
      ],
    });

    store.appendBatchWithRuntimeChanges([], {
      openedModelRequestStarts: [
        {
          workspaceId: WORKSPACE_ID,
          sessionId,
          turnId: "rtun_store_open_spans",
          ownerId: "owner_store",
          ownerGeneration: 1,
          startEventId: "sevt_model_start_1",
          now,
        },
      ],
    });

    expect(store.listPendingRuntimeTurns(WORKSPACE_ID)).toMatchObject([
      {
        turn_id: "rtun_store_open_spans",
        open_model_request_start_ids: ["sevt_model_start_1"],
      },
    ]);

    store.appendBatchWithRuntimeChanges([], {
      closedModelRequestStarts: [
        {
          workspaceId: WORKSPACE_ID,
          sessionId,
          turnId: "rtun_store_open_spans",
          ownerId: "owner_store",
          ownerGeneration: 1,
          startEventId: "sevt_model_start_1",
          now,
        },
      ],
    });

    expect(store.listPendingRuntimeTurns(WORKSPACE_ID)).toMatchObject([
      {
        turn_id: "rtun_store_open_spans",
        open_model_request_start_ids: [],
      },
    ]);
  });

  it("rejects stale-owner model request span mutations", () => {
    const store = EventStore.open(":memory:");
    const sessionId = "sesn_store_stale_span_owner";
    const now = new Date().toISOString();

    store.appendBatchWithRuntimeChanges([], {
      acceptedTurns: [
        {
          workspaceId: WORKSPACE_ID,
          sessionId,
          turnId: "rtun_store_stale_span_owner",
          ownerId: "owner_a",
          ownerGeneration: 1,
          leaseExpiresAt: now,
          triggerEventIds: ["sevt_trigger"],
          now,
        },
      ],
    });
    const claimed = store.claimAcceptedRuntimeTurnForRecovery({
      workspaceId: WORKSPACE_ID,
      sessionId,
      turnId: "rtun_store_stale_span_owner",
      ownerId: "owner_b",
      leaseExpiresAt: now,
      now,
    });
    expect(claimed).toMatchObject({
      owner_id: "owner_b",
      owner_generation: 2,
    });

    expect(() =>
      store.appendBatchWithRuntimeChanges([], {
        openedModelRequestStarts: [
          {
            workspaceId: WORKSPACE_ID,
            sessionId,
            turnId: "rtun_store_stale_span_owner",
            ownerId: "owner_a",
            ownerGeneration: 1,
            startEventId: "sevt_stale_start",
            now,
          },
        ],
      }),
    ).toThrow("Runtime turn ownership lost");
    expect(store.listPendingRuntimeTurns(WORKSPACE_ID)).toMatchObject([
      { open_model_request_start_ids: [] },
    ]);
  });

  it("ignores stale-owner runtime state and close writes after recovery claims a turn", () => {
    const store = EventStore.open(":memory:");
    const sessionId = "sesn_store_stale_owner";
    const now = new Date().toISOString();

    store.appendBatchWithRuntimeChanges([], {
      acceptedTurns: [
        {
          workspaceId: WORKSPACE_ID,
          sessionId,
          turnId: "rtun_store_stale_owner",
          ownerId: "owner_a",
          ownerGeneration: 1,
          leaseExpiresAt: now,
          triggerEventIds: ["sevt_trigger"],
          now,
        },
      ],
    });
    const claimed = store.claimAcceptedRuntimeTurnForRecovery({
      workspaceId: WORKSPACE_ID,
      sessionId,
      turnId: "rtun_store_stale_owner",
      ownerId: "owner_b",
      leaseExpiresAt: now,
      now,
    });
    expect(claimed).toMatchObject({
      owner_id: "owner_b",
      owner_generation: 2,
      state: "dispatching",
    });

    const staleEvent: PersistedSessionEvent = {
      id: "sevt_stale_owner_output",
      workspace_id: WORKSPACE_ID,
      session_id: sessionId,
      type: "agent.message",
      processed_at: now,
      payload: { content: [{ type: "text", text: "stale" }] },
      created_at: now,
    };
    expect(() =>
      store.appendBatchWithRuntimeChanges([staleEvent], {
        turnStates: [
          {
            workspaceId: WORKSPACE_ID,
            sessionId,
            turnId: "rtun_store_stale_owner",
            ownerId: "owner_a",
            ownerGeneration: 1,
            state: "running",
            now,
          },
        ],
      }),
    ).toThrow("Runtime turn ownership lost");
    expect(store.list(WORKSPACE_ID, sessionId)).toEqual([]);

    expect(() =>
      store.appendBatchWithRuntimeChanges([], {
        closedTurns: [
          {
            workspaceId: WORKSPACE_ID,
            sessionId,
            turnId: "rtun_store_stale_owner",
            ownerId: "owner_a",
            ownerGeneration: 1,
            reason: "completed",
            state: "completed",
            now,
          },
        ],
      }),
    ).toThrow("Runtime turn ownership lost");
    expect(store.listPendingRuntimeTurns(WORKSPACE_ID)).toMatchObject([
      {
        owner_id: "owner_b",
        owner_generation: 2,
        state: "dispatching",
      },
    ]);

    store.appendBatchWithRuntimeChanges([], {
      turnStates: [
        {
          workspaceId: WORKSPACE_ID,
          sessionId,
          turnId: "rtun_store_stale_owner",
          ownerId: "owner_b",
          ownerGeneration: 2,
          state: "running",
          now,
        },
      ],
    });
    expect(store.listPendingRuntimeTurns(WORKSPACE_ID)).toMatchObject([
      {
        owner_id: "owner_b",
        owner_generation: 2,
        state: "running",
      },
    ]);

    store.appendBatchWithRuntimeChanges([], {
      closedTurns: [
        {
          workspaceId: WORKSPACE_ID,
          sessionId,
          turnId: "rtun_store_stale_owner",
          ownerId: "owner_b",
          ownerGeneration: 2,
          reason: "completed",
          state: "completed",
          now,
        },
      ],
    });
    expect(store.listPendingRuntimeTurns(WORKSPACE_ID)).toEqual([]);
  });

  it("fails legacy event migration instead of assigning unknown workspace ids", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        processed_at TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO events (id, session_id, type, processed_at, payload, created_at)
      VALUES ('sevt_legacy', 'sesn_other_workspace', 'user.message',
        '2026-01-01T00:00:00.000Z', '{}', '2026-01-01T00:00:00.000Z');
    `);

    expect(() => new EventStore(db)).toThrow(
      "Cannot automatically migrate legacy events without workspace_id",
    );
    const columns = db.prepare("PRAGMA table_info(events)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).not.toContain("workspace_id");
    expect(() => new EventStore(db)).toThrow(
      "Cannot automatically migrate legacy events without workspace_id",
    );
    db.close();
  });

  it("backfills legacy event workspace ids when sessions are co-located", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        processed_at TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO sessions (id, workspace_id)
      VALUES ('sesn_other_workspace', 'wrk_other');
      INSERT INTO events (id, session_id, type, processed_at, payload, created_at)
      VALUES ('sevt_legacy', 'sesn_other_workspace', 'user.message',
        '2026-01-01T00:00:00.000Z', '{}', '2026-01-01T00:00:00.000Z');
    `);

    const store = new EventStore(db);

    expect(store.list("wrk_other", "sesn_other_workspace")).toHaveLength(1);
    expect(store.list(WORKSPACE_ID, "sesn_other_workspace")).toEqual([]);
    store.close();
  });
});
