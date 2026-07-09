import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceId } from "../../workspace.ts";
import { PendingActionStore } from "../pending-actions.ts";

const WS = "wrk_default" as WorkspaceId;
const SID = "sesn_pending";

describe("PendingActionStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces back-to-back adds into a single scheduled flush", () => {
    const flush = vi.fn();
    const store = new PendingActionStore(flush);

    store.add(WS, SID, "a");
    store.add(WS, SID, "b");
    expect(flush).not.toHaveBeenCalled(); // deferred by one macrotask

    vi.runAllTimers();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(WS, SID);
  });

  it("clear removes an entry WITH an armed timer and cancels the flush", () => {
    const flush = vi.fn();
    const store = new PendingActionStore(flush);
    store.add(WS, SID, "a"); // arms a timer

    expect(store.clear(WS, SID)).toEqual(["a"]);
    expect(store.has(WS, SID)).toBe(false);

    // The armed timer must have been cancelled — no spurious flush fires.
    vi.runAllTimers();
    expect(flush).not.toHaveBeenCalled();
  });

  it("remove keeps the entry alive while its timer is still armed", () => {
    const flush = vi.fn();
    const store = new PendingActionStore(flush);
    store.add(WS, SID, "a"); // arms a timer

    store.remove(WS, SID, "a"); // ids now empty, but timer still armed
    // Entry survives (timer armed) so a later flush can still coalesce/drain it.
    expect(store.drainForFlush(WS, SID)).toEqual([]);
    // has() reports empty (length 0) regardless.
    expect(store.has(WS, SID)).toBe(false);
  });

  it("drainForFlush snapshots ids and cancels the timer but does NOT consume the ids", () => {
    const flush = vi.fn();
    const store = new PendingActionStore(flush);
    store.add(WS, SID, "a");

    expect(store.drainForFlush(WS, SID)).toEqual(["a"]);
    // Timer was force-cleared, so the deferred flush no longer fires.
    vi.runAllTimers();
    expect(flush).not.toHaveBeenCalled();
    // Ids persist until resolved via remove() — a re-flush re-emits the full
    // pending set (the "re-emit requires_action with all pending IDs" contract).
    expect(store.drainForFlush(WS, SID)).toEqual(["a"]);
  });

  it("re-arms a fresh flush after a drain and re-emits the full remaining set", () => {
    const flush = vi.fn();
    const store = new PendingActionStore(flush);
    store.add(WS, SID, "a");
    store.drainForFlush(WS, SID); // snapshots "a", clears the timer (ids persist)

    store.add(WS, SID, "b"); // timer was cleared, so this must re-arm a flush
    vi.runAllTimers();
    expect(flush).toHaveBeenCalledTimes(1);
    // "a" was never resolved, so the re-emit carries both.
    expect(store.drainForFlush(WS, SID)).toEqual(["a", "b"]);
  });

  it("scopes pending ids per session key", () => {
    const store = new PendingActionStore(vi.fn());
    store.add(WS, "sesn_a", "x");
    store.add(WS, "sesn_b", "y");

    expect(store.drainForFlush(WS, "sesn_a")).toEqual(["x"]);
    expect(store.drainForFlush(WS, "sesn_b")).toEqual(["y"]);
  });
});
