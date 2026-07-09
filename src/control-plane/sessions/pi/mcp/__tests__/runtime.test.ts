import { describe, expect, it, vi } from "vitest";
import type { VaultStore } from "../../../../vaults/types.ts";
import type { McpFetch } from "../fetch.ts";
import { createDefaultMcpRuntime } from "../runtime.ts";

describe("default MCP runtime composition", () => {
  it("shares one guarded fetch between the runner seam and refresh coordinator", () => {
    const fetch = vi.fn() as unknown as McpFetch;
    const runtime = createDefaultMcpRuntime({} as VaultStore, fetch);

    expect(runtime.fetch).toBe(fetch);
    expect(
      (runtime.refreshCoordinator as unknown as { fetchImpl: McpFetch }).fetchImpl,
    ).toBe(fetch);
  });
});
