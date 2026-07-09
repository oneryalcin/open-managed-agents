import { RefreshCoordinator } from "../../../vaults/oauth-refresh.ts";
import type { VaultStore } from "../../../vaults/types.ts";
import { createGuardedMcpFetch, type McpFetch } from "./fetch.ts";

/** Default production composition: one guarded fetch for MCP and OAuth refresh. */
export function createDefaultMcpRuntime(
  store: VaultStore,
  fetch: McpFetch = createGuardedMcpFetch(),
  opts: { onScheduled?: () => void } = {},
): { fetch: McpFetch; refreshCoordinator: RefreshCoordinator } {
  return {
    fetch,
    refreshCoordinator: new RefreshCoordinator({
      store,
      fetch,
      ...(opts.onScheduled === undefined ? {} : { onScheduled: opts.onScheduled }),
    }),
  };
}
