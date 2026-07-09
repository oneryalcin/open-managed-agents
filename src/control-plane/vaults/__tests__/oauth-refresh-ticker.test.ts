import { afterEach, describe, expect, it, vi } from "vitest";
import { createOauthRefreshTicker, OAUTH_TICKER_CONCURRENCY } from "../oauth-refresh-ticker.ts";
import type { RefreshCoordinator } from "../oauth-refresh.ts";
import type { OauthRefreshDueCredential, VaultStore } from "../types.ts";

describe("OAuth refresh ticker", () => {
  afterEach(() => vi.useRealTimers());

  it("bounds refresh concurrency", async () => {
    vi.useFakeTimers();
    const due = Array.from({ length: 50 }, (_, index) => row(index));
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const refresh = {
      refreshCredential: vi.fn(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        return { outcome: "ok" };
      }),
    } as unknown as RefreshCoordinator;
    const store = {
      nextDueRefreshAt: () => "2026-07-09T12:00:00.000Z",
      listDueRefreshes: () => due,
    } as unknown as VaultStore;
    const ticker = createOauthRefreshTicker({
      store,
      refresh,
      onError: () => undefined,
      now: () => new Date("2026-07-09T12:00:00.000Z"),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(peak).toBe(OAUTH_TICKER_CONCURRENCY);
    release();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await ticker.close();
    expect(refresh.refreshCredential).toHaveBeenCalledTimes(50);
  });
});

function row(index: number): OauthRefreshDueCredential {
  return {
    workspaceId: "wrk_default",
    vaultId: "vlt_default",
    credentialId: `vcrd_${index}`,
    authVersion: 1,
    nextRefreshAt: "2026-07-09T12:00:00.000Z",
  };
}
