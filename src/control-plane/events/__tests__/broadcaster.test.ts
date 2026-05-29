import { describe, expect, it } from "vitest";
import { newEventId } from "../../../types/events.ts";
import { SessionEventBroadcaster } from "../broadcaster.ts";
import { EventStore } from "../store.ts";
import type { PersistedSessionEvent } from "../types.ts";
import { STREAM_TEST_TIMEOUT_MS, hasTimedOut } from "../../__tests__/test-timeouts.ts";

const WORKSPACE_ID = "wrk_default";

describe("session event broadcaster", () => {
  it("replays persisted history then tails live notifications without duplicates", async () => {
    const store = EventStore.open(":memory:");
    const broadcaster = new SessionEventBroadcaster(store);
    const sessionId = "sesn_broadcaster_a";

    const first = makeEvent(sessionId, "a");
    const second = makeEvent(sessionId, "b");
    store.append(first);
    store.append(second);

    const ac = new AbortController();
    const seen: string[] = [];
    const consume = (async () => {
      for await (const event of broadcaster.subscribe(WORKSPACE_ID, sessionId, {
        signal: ac.signal,
      })) {
        seen.push(event.id);
        if (seen.length === 3) ac.abort();
      }
    })();

    await until(() => seen.length >= 2);
    broadcaster.publishPersisted([makeEvent(sessionId, "live")]);
    await consume;

    expect(new Set(seen).size).toBe(3);
    expect(seen[0]).toBe(first.id);
    expect(seen[1]).toBe(second.id);
  });

  it("resumes from lastSeenId with id > cursor semantics", async () => {
    const store = EventStore.open(":memory:");
    const broadcaster = new SessionEventBroadcaster(store);
    const sessionId = "sesn_broadcaster_b";
    const e1 = makeEvent(sessionId, "one");
    const e2 = makeEvent(sessionId, "two");
    const e3 = makeEvent(sessionId, "three");
    store.append(e1);
    store.append(e2);
    store.append(e3);

    const ac = new AbortController();
    const seen: string[] = [];
    for await (const event of broadcaster.subscribe(WORKSPACE_ID, sessionId, {
      signal: ac.signal,
      lastSeenId: e1.id,
    })) {
      seen.push(event.id);
      if (seen.length === 2) ac.abort();
    }
    expect(seen).toEqual([e2.id, e3.id]);
  });

  it("recovers overflow-dropped live events by refetching from the store", async () => {
    // The live queue is bounded by maxBuffer. When a suspended subscriber is
    // flooded past that bound, the queue is dropped and the subscriber refetches
    // from the store using its last-yielded ID as the cursor. This recovery
    // depends on persist-before-publish: the events must already be durable, so
    // the test appends them before notifying — mirroring `events.send`.
    const store = EventStore.open(":memory:");
    const broadcaster = new SessionEventBroadcaster(store);
    const sessionId = "sesn_broadcaster_overflow";
    const events = [
      makeEvent(sessionId, "1"),
      makeEvent(sessionId, "2"),
      makeEvent(sessionId, "3"),
    ];

    const ac = new AbortController();
    const seen: string[] = [];
    const consume = (async () => {
      for await (const event of broadcaster.subscribe(WORKSPACE_ID, sessionId, {
        signal: ac.signal,
        maxBuffer: 2,
      })) {
        seen.push(event.id);
        if (seen.length === events.length) ac.abort();
      }
    })();

    // Let the subscriber finish its (empty) replay and park before the flood,
    // so all three events land in the live queue and trip overflow (3 > 2).
    await until(() => broadcaster.subscriberCount(sessionId) > 0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    for (const event of events) store.append(event);
    broadcaster.publishPersisted(events);

    await consume;
    expect(seen).toEqual(events.map((event) => event.id));
  });

  it("publishPersisted does not write to the store", async () => {
    const store = EventStore.open(":memory:");
    const broadcaster = new SessionEventBroadcaster(store);
    const sessionId = "sesn_broadcaster_c";
    const event = makeEvent(sessionId, "x");
    broadcaster.publishPersisted([event]);
    expect(store.retrieve(WORKSPACE_ID, event.id)).toBeUndefined();
  });

  it("closeSession ends live subscribers after queued events drain", async () => {
    const store = EventStore.open(":memory:");
    const broadcaster = new SessionEventBroadcaster(store);
    const sessionId = "sesn_broadcaster_close";
    const event = makeEvent(sessionId, "deleted");
    store.append(event);

    const seen: string[] = [];
    const consume = (async () => {
      for await (const item of broadcaster.subscribe(WORKSPACE_ID, sessionId)) {
        seen.push(item.id);
      }
    })();

    await until(() => seen.length === 1);
    expect(broadcaster.subscriberCount(sessionId)).toBe(1);
    broadcaster.closeSession(WORKSPACE_ID, sessionId);
    await consume;

    expect(seen).toEqual([event.id]);
    expect(broadcaster.subscriberCount(sessionId)).toBe(0);
  });
});

function makeEvent(sessionId: string, text: string): PersistedSessionEvent {
  const now = new Date().toISOString();
  return {
    id: newEventId(),
    workspace_id: WORKSPACE_ID,
    session_id: sessionId,
    type: "user.message",
    processed_at: now,
    payload: { content: [{ type: "text", text }] },
    created_at: now,
  };
}

async function until(condition: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!hasTimedOut(startedAt, STREAM_TEST_TIMEOUT_MS)) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}
