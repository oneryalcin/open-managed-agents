import { describe, expect, it } from "vitest";
import { newEventId } from "../../../types/events.ts";
import { SessionEventBroadcaster } from "../broadcaster.ts";
import { EventStore } from "../store.ts";
import type { PersistedSessionEvent } from "../types.ts";
import { STREAM_TEST_TIMEOUT_MS, hasTimedOut } from "../../__tests__/test-timeouts.ts";

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
      for await (const event of broadcaster.subscribe(sessionId, { signal: ac.signal })) {
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
    for await (const event of broadcaster.subscribe(sessionId, {
      signal: ac.signal,
      lastSeenId: e1.id,
    })) {
      seen.push(event.id);
      if (seen.length === 2) ac.abort();
    }
    expect(seen).toEqual([e2.id, e3.id]);
  });

  it("appendAndPublish persists and notifies in one call", async () => {
    const store = EventStore.open(":memory:");
    const broadcaster = new SessionEventBroadcaster(store);
    const sessionId = "sesn_broadcaster_c";
    const event = makeEvent(sessionId, "x");
    broadcaster.appendAndPublish(event);
    expect(store.retrieve(event.id)?.id).toBe(event.id);
  });
});

function makeEvent(sessionId: string, text: string): PersistedSessionEvent {
  const now = new Date().toISOString();
  return {
    id: newEventId(),
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
