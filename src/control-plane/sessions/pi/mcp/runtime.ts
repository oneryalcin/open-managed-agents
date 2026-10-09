import { RefreshCoordinator } from "../../../vaults/oauth-refresh.ts";
import type { VaultStore } from "../../../vaults/types.ts";
import { createGuardedFetch, type GuardedFetch } from "../../../egress/guarded-fetch.ts";

/** Default production composition: one guarded fetch for MCP and OAuth refresh. */
export function createDefaultMcpRuntime(
  store: VaultStore,
  fetch: GuardedFetch = createGuardedFetch(),
  opts: { onScheduled?: () => void } = {},
): { fetch: GuardedFetch; refreshCoordinator: RefreshCoordinator } {
  return {
    fetch,
    refreshCoordinator: new RefreshCoordinator({
      store,
      fetch,
      ...(opts.onScheduled === undefined ? {} : { onScheduled: opts.onScheduled }),
    }),
  };
}
