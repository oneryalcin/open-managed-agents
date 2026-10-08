import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSingleDatabaseRuntimeEventCoordinator } from "../../deployment-runtime-event-coordinator.ts";
import { EventStore } from "../store.ts";
import {
  RuntimeTurnOwnershipLostError,
  type ConversationEntryRecord,
  type PersistedSessionEvent,
  type RuntimeConversationCheckpoint,
} from "../types.ts";

// Plan 0147 slice 1: the conversation table beside the event log.
const WORKSPACE_ID = "wrk_default";
const SESSION_ID = "sesn_conversation";
const TURN_ID = "rtun_conversation";

function entry(id: string): ConversationEntryRecord {
  return { entryId: id, json: JSON.stringify({ type: "message", id }) };
}

function acceptTurn(store: EventStore, sessionId = SESSION_ID, turnId = TURN_ID): void {
  const now = new Date().toISOString();
  store.appendBatchWithRuntimeChanges([], {
    acceptedTurns: [
      {
        workspaceId: WORKSPACE_ID,
        sessionId,
        turnId,
        ownerId: "owner_a",
        ownerGeneration: 1,
        leaseExpiresAt: now,
        triggerEventIds: ["sevt_trigger"],
        now,
      },
    ],
  });
}

function checkpoint(
  entries: ConversationEntryRecord[],
  overrides: Partial<RuntimeConversationCheckpoint> = {},
): RuntimeConversationCheckpoint {
  return {
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    ownerId: "owner_a",
    ownerGeneration: 1,
    piVersion: "0.85.1",
    entries,
    now: new Date().toISOString(),
    ...overrides,
  };
}

const ids = (store: EventStore, sessionId = SESSION_ID) =>
  store.listConversationEntries(WORKSPACE_ID, sessionId).map((row) => row.entryId);

describe("conversation store", () => {
  it("saves a turn's entries in order with their turn and Pi version", () => {
    const store = EventStore.open(":memory:");
    acceptTurn(store);

    store.appendBatchWithRuntimeChanges([], {
      conversationCheckpoints: [checkpoint([entry("hdr"), entry("e1"), entry("e2")])],
    });

    expect(store.listConversationEntries(WORKSPACE_ID, SESSION_ID)).toEqual([
      { entryId: "hdr", json: entry("hdr").json, turnId: TURN_ID, piVersion: "0.85.1" },
      { entryId: "e1", json: entry("e1").json, turnId: TURN_ID, piVersion: "0.85.1" },
      { entryId: "e2", json: entry("e2").json, turnId: TURN_ID, piVersion: "0.85.1" },
    ]);
  });

  it("ignores entries that are already saved, keeping the original order", () => {
    const store = EventStore.open(":memory:");
    acceptTurn(store);
    store.appendBatchWithRuntimeChanges([], {
      conversationCheckpoints: [checkpoint([entry("e1"), entry("e2")])],
    });

    store.appendBatchWithRuntimeChanges([], {
      conversationCheckpoints: [checkpoint([entry("e2"), entry("e3")])],
    });

    expect(ids(store)).toEqual(["e1", "e2", "e3"]);
  });

  it("rejects a stale owner and rolls back the whole batch", () => {
    const store = EventStore.open(":memory:");
    acceptTurn(store);
    const now = new Date().toISOString();
    store.claimAcceptedRuntimeTurnForRecovery({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      ownerId: "owner_b",
      leaseExpiresAt: now,
      now,
    });
    const event: PersistedSessionEvent = {
      id: "sevt_stale_output",
      workspace_id: WORKSPACE_ID,
      session_id: SESSION_ID,
      type: "agent.message",
      processed_at: now,
      payload: { content: [{ type: "text", text: "stale" }] },
      created_at: now,
    };

    expect(() =>
      store.appendBatchWithRuntimeChanges([event], {
        conversationCheckpoints: [checkpoint([entry("e1")])],
      }),
    ).toThrow(RuntimeTurnOwnershipLostError);
    expect({ events: store.list(WORKSPACE_ID, SESSION_ID), conversation: ids(store) })
      .toEqual({ events: [], conversation: [] });
  });

  it("rejects the old generation after the same owner reclaims its turn", () => {
    const store = EventStore.open(":memory:");
    acceptTurn(store);
    const now = new Date().toISOString();
    store.claimAcceptedRuntimeTurnForRecovery({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      ownerId: "owner_a",
      leaseExpiresAt: now,
      now,
    });

    expect(() =>
      store.appendBatchWithRuntimeChanges([], {
        conversationCheckpoints: [checkpoint([entry("e1")], { ownerGeneration: 1 })],
      }),
    ).toThrow(RuntimeTurnOwnershipLostError);
  });

  it("raises instead of silently dropping an entry that violates a constraint", () => {
    const store = EventStore.open(":memory:");
    acceptTurn(store);

    expect(() =>
      store.appendBatchWithRuntimeChanges([], {
        conversationCheckpoints: [
          checkpoint([entry("e1"), { entryId: "e2", json: null as unknown as string }]),
        ],
      }),
    ).toThrow();
  });

  it("still saves for a turn this owner has already closed", () => {
    const store = EventStore.open(":memory:");
    acceptTurn(store);
    store.appendBatchWithRuntimeChanges([], {
      closedTurns: [
        {
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
          turnId: TURN_ID,
          ownerId: "owner_a",
          ownerGeneration: 1,
          reason: "interrupted",
          state: "terminalized",
          now: new Date().toISOString(),
        },
      ],
    });

    store.appendBatchWithRuntimeChanges([], {
      conversationCheckpoints: [checkpoint([entry("e1")])],
    });

    expect(ids(store)).toEqual(["e1"]);
  });

  it("rejects a checkpoint after the session is deleted", () => {
    const store = EventStore.open(":memory:");
    acceptTurn(store);
    store.deleteForSession(WORKSPACE_ID, SESSION_ID);

    expect(() =>
      store.appendBatchWithRuntimeChanges([], {
        conversationCheckpoints: [checkpoint([entry("e1")])],
      }),
    ).toThrow(RuntimeTurnOwnershipLostError);
  });

  it("is refused by the runtime event coordinator, whose fence only knows pending turns", () => {
    const store = EventStore.open(":memory:");
    acceptTurn(store);
    const coordinator = createSingleDatabaseRuntimeEventCoordinator({
      sessions: { retrieve: () => ({}) as never },
      events: store,
    });

    expect(() =>
      coordinator.commitRuntimeEventsForTurn({
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        ownerId: "owner_a",
        ownerGeneration: 1,
        events: [],
        changes: { conversationCheckpoints: [checkpoint([entry("e1")])] },
      }),
    ).toThrow(/written with the turn close/);
  });

  it("keeps each session's conversation separate", () => {
    const store = EventStore.open(":memory:");
    acceptTurn(store);
    acceptTurn(store, "sesn_other", "rtun_other");
    store.appendBatchWithRuntimeChanges([], {
      conversationCheckpoints: [
        checkpoint([entry("e1")]),
        checkpoint([entry("x1")], { sessionId: "sesn_other", turnId: "rtun_other" }),
      ],
    });

    expect(ids(store)).toEqual(["e1"]);
  });

  it("deletes the conversation with the session's events", () => {
    const store = EventStore.open(":memory:");
    acceptTurn(store);
    store.appendBatchWithRuntimeChanges([], {
      conversationCheckpoints: [checkpoint([entry("e1")])],
    });

    store.deleteForSession(WORKSPACE_ID, SESSION_ID);

    expect(ids(store)).toEqual([]);
  });

  it("records why a turn closed, so a deliberate interrupt is not reported as unfinished", () => {
    const store = EventStore.open(":memory:");
    const now = new Date().toISOString();
    const message: PersistedSessionEvent = {
      id: "sevt_interrupted",
      workspace_id: WORKSPACE_ID,
      session_id: SESSION_ID,
      type: "user.message",
      processed_at: now,
      payload: { content: [{ type: "text", text: "stop me" }] },
      created_at: now,
    };
    store.appendBatchWithRuntimeChanges([message], {
      acceptedTurns: [{
        workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, turnId: TURN_ID, ownerId: "owner_a",
        ownerGeneration: 1, leaseExpiresAt: now, triggerEventIds: [message.id], now,
      }],
    });
    store.appendBatchWithRuntimeChanges([], {
      closedTurns: [{
        workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, turnId: TURN_ID, ownerId: "owner_a",
        ownerGeneration: 1, reason: "interrupted", state: "terminalized", now,
      }],
    });

    expect(store.loadConversation(WORKSPACE_ID, SESSION_ID).unfinished).toEqual([]);
  });

  it("keeps the conversation across a reopen of a file-backed store", () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-conversation-"));
    try {
      const path = join(dir, "events.sqlite");
      const first = EventStore.open(path);
      acceptTurn(first);
      first.appendBatchWithRuntimeChanges([], {
        conversationCheckpoints: [checkpoint([entry("e1"), entry("e2")])],
      });

      const reopened = EventStore.open(path);

      expect(ids(reopened)).toEqual(["e1", "e2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
