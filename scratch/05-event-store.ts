/**
 * Probe 05 — EventStore + SessionEventBroadcaster end-to-end
 *
 * Verifies the platform-shape primitives from ADR 0007 Patterns 1 & 2:
 *
 *   - EventStore round-trips events via in-memory SQLite.
 *   - Broadcaster persists-before-publish (every event hits the store before
 *     subscribers see it).
 *   - Replay-then-tail dedup works under racing publishes: a subscriber opened
 *     mid-stream replays history AND sees subsequent live events with no
 *     duplicates and no gaps.
 *
 * No Anthropic API calls. Pure platform-layer verification.
 *
 * Run: npx tsx scratch/05-event-store.ts
 */

import { EventStore } from "../src/control-plane/events/store.ts";
import { SessionEventBroadcaster } from "../src/control-plane/events/broadcaster.ts";
import type { PersistedSessionEvent } from "../src/control-plane/events/types.ts";
import type { JsonObject } from "../src/types/json.ts";
import { newEventId } from "../src/types/events.ts";

const log = (msg: string) => console.log(msg);

function makeEvent(
  sessionId: string,
  type: PersistedSessionEvent["type"],
  payload: JsonObject = {},
): PersistedSessionEvent {
  const now = new Date().toISOString();
  return {
    id: newEventId(),
    session_id: sessionId,
    type,
    processed_at: now,
    payload,
    created_at: now,
  };
}

const SID = "sesn_probe_05";
const store = EventStore.open(":memory:");
const broadcaster = new SessionEventBroadcaster(store);

// ──────────────────────────────────────────────────────────────────────
// Part 1 — round-trip via EventStore
// ──────────────────────────────────────────────────────────────────────
log("--- Part 1: EventStore round-trip ---");
const e1 = makeEvent(SID, "agent.message", { text: "hello" });
const e2 = makeEvent(SID, "agent.message", { text: "world" });
broadcaster.publish(e1);
broadcaster.publish(e2);
{
  const list = store.list(SID);
  log(`store.list(): ${list.length} events (expected 2)`);
  for (const [i, ev] of list.entries()) {
    log(`  [${i}] ${ev.type} ${JSON.stringify(ev.payload)}`);
  }
  log(`store.retrieve(e1.id) === e1.id: ${store.retrieve(e1.id)?.id === e1.id}`);
}

// ──────────────────────────────────────────────────────────────────────
// Part 2 — full-history replay (lastSeenId undefined)
// ──────────────────────────────────────────────────────────────────────
log("");
log("--- Part 2: subscribe() with no lastSeenId replays full history ---");
{
  const ac = new AbortController();
  const collected: PersistedSessionEvent[] = [];
  let iter = 0;
  for await (const event of broadcaster.subscribe(SID, { signal: ac.signal })) {
    collected.push(event);
    iter += 1;
    // We expect 2 events from history; abort once we've seen both.
    if (collected.length >= 2) ac.abort();
    if (iter > 10) {
      log("  guard: too many iterations, aborting");
      ac.abort();
      break;
    }
  }
  log(`collected: ${collected.length} events (expected 2)`);
  log(`subscriberCount after exit: ${broadcaster.subscriberCount(SID)} (expected 0)`);
}

// ──────────────────────────────────────────────────────────────────────
// Part 3 — replay-then-tail with concurrent publishes
// ──────────────────────────────────────────────────────────────────────
log("");
log("--- Part 3: replay-then-tail with concurrent publishes ---");
{
  // Add more history first.
  const e3 = makeEvent(SID, "agent.tool_use", { name: "bash" });
  const e4 = makeEvent(SID, "agent.tool_result", { result: "ok" });
  broadcaster.publish(e3);
  broadcaster.publish(e4);
  log(`Store now has 4 events: e1, e2, e3, e4`);

  // Subscribe with lastSeenId = e1 → expect to replay e2, e3, e4, then see
  // live e5, e6 arriving during/after replay.
  const ac = new AbortController();
  const collected: PersistedSessionEvent[] = [];
  const expected = 5; // e2, e3, e4 from replay + e5, e6 live (5 total since e1)
  const lastSeenId = e1.id;

  const consumePromise = (async () => {
    let n = 0;
    for await (const event of broadcaster.subscribe(SID, { lastSeenId, signal: ac.signal })) {
      collected.push(event);
      log(`  recv: ${event.type.padEnd(22)} id=${event.id.slice(0, 20)}…`);
      n += 1;
      if (collected.length >= expected) ac.abort();
      if (n > 20) {
        log("  guard: too many iterations");
        ac.abort();
        break;
      }
    }
  })();

  // Race in live events while replay is happening.
  // Microtask 1: yield once so the subscriber registers + starts replay.
  await new Promise((r) => setTimeout(r, 0));
  const e5 = makeEvent(SID, "agent.message", { text: "live-1" });
  broadcaster.publish(e5);
  // Microtask 2: another publish a bit later.
  await new Promise((r) => setTimeout(r, 5));
  const e6 = makeEvent(SID, "agent.message", { text: "live-2" });
  broadcaster.publish(e6);

  await consumePromise;

  const ids = collected.map((e) => e.id);
  const dupCount = ids.length - new Set(ids).size;
  const expectedIdsInOrder = [e2.id, e3.id, e4.id, e5.id, e6.id];
  const actualIds = collected.map((e) => e.id);

  log("");
  log(`collected: ${collected.length} events (expected ${expected})`);
  log(`duplicate IDs in collected: ${dupCount} (expected 0)`);
  log(
    `IDs match expected sequence [e2,e3,e4,e5,e6]: ${
      actualIds.length === expectedIdsInOrder.length &&
      actualIds.every((id, i) => id === expectedIdsInOrder[i])
    }`,
  );
  log(`subscriberCount after exit: ${broadcaster.subscriberCount(SID)} (expected 0)`);
}

// ──────────────────────────────────────────────────────────────────────
// Part 4 — paginated replay (>page-size events)
// ──────────────────────────────────────────────────────────────────────
log("");
log("--- Part 4: subscribe() paginates replay across many events ---");
{
  const SID4 = "sesn_probe_05_part4";
  const N = 1500; // larger than default pageSize (500)
  const ids: string[] = [];
  for (let i = 0; i < N; i++) {
    const e = makeEvent(SID4, "agent.message", { i });
    ids.push(e.id);
    broadcaster.publish(e);
  }

  const ac = new AbortController();
  const collected: string[] = [];
  for await (const event of broadcaster.subscribe(SID4, { signal: ac.signal })) {
    collected.push(event.id);
    if (collected.length >= N) ac.abort();
  }

  log(`collected: ${collected.length} (expected ${N})`);
  log(`unique IDs: ${new Set(collected).size} (expected ${N})`);
  log(
    `IDs match published order: ${
      collected.length === ids.length && collected.every((id, i) => id === ids[i])
    }`,
  );
  log(`subscriberCount after exit: ${broadcaster.subscriberCount(SID4)} (expected 0)`);
}

// ──────────────────────────────────────────────────────────────────────
// Part 5 — bounded live buffer with overflow recovery
// ──────────────────────────────────────────────────────────────────────
log("");
log("--- Part 5: live buffer overflow → refetch from store ---");
{
  const SID5 = "sesn_probe_05_part5";
  const TOTAL = 15_005;
  const collected: string[] = [];
  const ac = new AbortController();

  let firstEventReceivedResolve!: () => void;
  const firstEventReceived = new Promise<void>((r) => {
    firstEventReceivedResolve = r;
  });

  // Pre-populate 5 events before subscribe.
  for (let i = 0; i < 5; i++) {
    broadcaster.publish(makeEvent(SID5, "agent.message", { i }));
  }

  // Subscribe with a slow consumer: pause 200ms after first event so the
  // live buffer has time to overflow during a burst.
  const consumePromise = (async () => {
    let pausedOnce = false;
    for await (const event of broadcaster.subscribe(SID5, {
      signal: ac.signal,
      // Smaller maxBuffer makes the test faster while exercising the same path.
      maxBuffer: 1000,
    })) {
      collected.push(event.id);
      if (!pausedOnce) {
        pausedOnce = true;
        firstEventReceivedResolve();
        await new Promise((r) => setTimeout(r, 200));
      }
      if (collected.length >= TOTAL) ac.abort();
    }
  })();

  // Wait until consumer is verifiably paused on first event.
  await firstEventReceived;

  // Burst 15K events while consumer is paused. With maxBuffer=1000, this
  // forces ≥1 overflow → buffer drop → refetch from store recovery.
  for (let i = 5; i < TOTAL; i++) {
    broadcaster.publish(makeEvent(SID5, "agent.message", { i }));
  }

  await consumePromise;

  const uniq = new Set(collected);
  log(`collected: ${collected.length} (expected ${TOTAL})`);
  log(`unique IDs: ${uniq.size} (expected ${TOTAL})`);
  log(`duplicate IDs: ${collected.length - uniq.size} (expected 0)`);
  log(`subscriberCount after exit: ${broadcaster.subscriberCount(SID5)} (expected 0)`);

  // Sanity: ordering is monotonically non-decreasing.
  let orderOk = true;
  for (let i = 1; i < collected.length; i++) {
    if (collected[i] <= collected[i - 1]) {
      orderOk = false;
      break;
    }
  }
  log(`order strictly increasing: ${orderOk}`);
}

// ──────────────────────────────────────────────────────────────────────
// Verdict
// ──────────────────────────────────────────────────────────────────────
store.close();
log("");
log("=== done ===");
