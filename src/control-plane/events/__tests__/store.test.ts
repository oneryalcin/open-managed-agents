import { describe, expect, it } from "vitest";
import { newEventId } from "../../../types/events.ts";
import { EventStore } from "../store.ts";
import type { PersistedSessionEvent } from "../types.ts";

describe("event store", () => {
  it("keeps legacy list() default limit (1000) for afterId scans when limit is omitted", () => {
    const store = EventStore.open(":memory:");
    const sessionId = "sesn_store_test";
    const events: PersistedSessionEvent[] = [];

    for (let index = 0; index < 31; index += 1) {
      const now = new Date().toISOString();
      const event: PersistedSessionEvent = {
        id: newEventId(),
        session_id: sessionId,
        type: "user.message",
        processed_at: now,
        payload: { content: [{ type: "text", text: `m${index}` }] },
        created_at: now,
      };
      events.push(event);
      store.append(event);
    }

    const sinceFirst = store.list(sessionId, {
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
        session_id: sessionId,
        type: "user.message",
        processed_at: now,
        payload: { content: [{ type: "text", text: `p${index}` }] },
        created_at: now,
      });
    }

    const page = store.listPage(sessionId);
    expect(page.data).toHaveLength(20);
    expect(page.next_page).toEqual(expect.stringMatching(/^sevt_/));
  });
});
