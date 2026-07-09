import { createWakeLoop, type WakeLoop } from "../wake-loop.ts";
import type { RefreshCoordinator } from "./oauth-refresh.ts";
import type { OauthRefreshDueCredential, VaultStore } from "./types.ts";

export const OAUTH_TICKER_BATCH_SIZE = 50;
export const OAUTH_TICKER_CONCURRENCY = 5;
export const OAUTH_TICKER_MAX_SLEEP_MS = 15 * 60_000;
export const OAUTH_TICKER_MIN_SLEEP_MS = 30_000;

export function createOauthRefreshTicker(opts: {
  store: VaultStore;
  refresh: RefreshCoordinator;
  onError(error: unknown): void;
  now?: () => Date;
}): WakeLoop {
  const now = opts.now ?? (() => new Date());
  return createWakeLoop({
    nextWakeAt: () => {
      const next = opts.store.nextDueRefreshAt(now().toISOString());
      return next === null ? null : new Date(next);
    },
    run: async () => {
      const due = opts.store.listDueRefreshes(
        now().toISOString(),
        OAUTH_TICKER_BATCH_SIZE,
      );
      await mapConcurrent(due, OAUTH_TICKER_CONCURRENCY, async (credential) => {
        await refreshDue(opts.refresh, credential);
      });
    },
    maxSleepMs: OAUTH_TICKER_MAX_SLEEP_MS,
    minSleepMs: OAUTH_TICKER_MIN_SLEEP_MS,
    onError: opts.onError,
    now: () => now().getTime(),
  });
}

function refreshDue(
  refresh: RefreshCoordinator,
  credential: OauthRefreshDueCredential,
) {
  return refresh.refreshCredential({
    workspaceId: credential.workspaceId,
    vaultId: credential.vaultId,
    credentialId: credential.credentialId,
    expectedAuthVersion: credential.authVersion,
  });
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (index < values.length) {
        const value = values[index];
        index += 1;
        if (value !== undefined) await visit(value);
      }
    }),
  );
}
