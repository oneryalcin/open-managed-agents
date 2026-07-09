import { afterEach, describe, expect, it, vi } from "vitest";
import { createWakeLoop } from "../wake-loop.ts";

describe("createWakeLoop", () => {
  afterEach(() => vi.useRealTimers());

  it("clamps sleeps and wakes for an earlier deadline", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-09T12:00:00.000Z");
    vi.setSystemTime(now);
    let due = new Date(now.getTime() + 60 * 60_000);
    const run = vi.fn();
    const loop = createWakeLoop({
      nextWakeAt: () => due,
      run,
      maxSleepMs: 15 * 60_000,
      minSleepMs: 30_000,
      onError: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    due = new Date(now.getTime() + 60_000);
    loop.wake();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await loop.close();
  });

  it("awaits an in-flight run and ignores wake while running or closed", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(() => gate);
    const loop = createWakeLoop({
      nextWakeAt: () => new Date(0),
      run,
      maxSleepMs: 1000,
      minSleepMs: 10,
      onError: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    loop.wake();
    const closing = loop.close();
    loop.wake();
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports errors and keeps scheduling", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const loop = createWakeLoop({
      nextWakeAt: () => new Date(0),
      run,
      maxSleepMs: 1000,
      minSleepMs: 10,
      onError,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(2);
    await loop.close();
  });
});
