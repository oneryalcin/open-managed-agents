// Plan 0122 §5 — real PiSessionRunner + real createPiSession (NO
// sessionFactory: that branch bypasses MCP wiring by design). Verified by
// probe: session construction needs no model credentials; only prompting
// does, so these tests exercise registration, gating, collision, disposal,
// and the fresh-handle retry budget without a live model.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiSessionRunner } from "../runner.ts";
import { McpConnection } from "../mcp/client.ts";
import { createGuardedMcpFetch } from "../mcp/fetch.ts";
import {
  echoTool,
  startMcpFixture,
  type McpFixture,
} from "../mcp/__tests__/fixture.ts";

const seamFetch = createGuardedMcpFetch({ allowAddress: () => true });

let fixture: McpFixture | undefined;
let runner: PiSessionRunner | undefined;
afterEach(async () => {
  runner?.close();
  runner = undefined;
  await fixture?.close();
  fixture = undefined;
  vi.restoreAllMocks();
});

function mcpRunner(opts: {
  url: string;
  enabled?: boolean;
  access?: (toolName: string) => { enabled: boolean; permission: "allow" | "ask" | "deny" };
  maxConsecutiveFailures?: number;
  idleTtlMs?: number;
  onConnection?: (event: "connected" | "connect_failed") => void;
  customTools?: () => readonly { type: "custom"; name: string; input_schema: Record<string, never> }[];
}): PiSessionRunner {
  return new PiSessionRunner({
    ...(opts.idleTtlMs === undefined ? {} : { idleTtlMs: opts.idleTtlMs }),
    ...(opts.customTools === undefined ? {} : { customTools: opts.customTools }),
    mcp: {
      enabled: opts.enabled ?? true,
      servers: () => [{ name: "srv", url: opts.url }],
      access: (_w, _s, _server, toolName) =>
        opts.access?.(toolName) ?? { enabled: true, permission: "allow" },
      fetch: seamFetch,
      operationTimeoutMs: 1_000,
      ...(opts.maxConsecutiveFailures === undefined
        ? {}
        : { maxConsecutiveFailures: opts.maxConsecutiveFailures }),
      ...(opts.onConnection === undefined
        ? {}
        : { onConnection: opts.onConnection }),
    },
  });
}

describe("PiSessionRunner MCP wiring (plan 0122 §5)", () => {
  it("registers discovered tools on the live Pi session, filtered by access", async () => {
    fixture = await startMcpFixture([
      echoTool(),
      {
        name: "hidden",
        inputSchema: {},
        handler: async () => ({ content: [{ type: "text", text: "no" }] }),
      },
    ]);
    runner = mcpRunner({
      url: fixture.url,
      access: (toolName) => ({
        enabled: toolName === "echo",
        permission: "allow",
      }),
    });
    await runner.prepareSession("wrk_default", "sesn_mcp");
    const names = runner.customToolNames?.("wrk_default", "sesn_mcp");
    expect(names?.has("mcp__srv__echo")).toBe(true);
    expect(names?.has("mcp__srv__hidden")).toBe(false);
  });

  it("deployment gate off: session builds, zero dials", async () => {
    fixture = await startMcpFixture([echoTool()]);
    runner = mcpRunner({ url: fixture.url, enabled: false });
    await runner.prepareSession("wrk_default", "sesn_gated");
    expect(fixture.httpRequests).toEqual([]);
    const names = runner.customToolNames?.("wrk_default", "sesn_gated");
    expect(names?.has("mcp__srv__echo")).toBe(false);
  });

  it("rejects session build on an MCP/custom tool name collision", async () => {
    fixture = await startMcpFixture([echoTool()]);
    runner = mcpRunner({
      url: fixture.url,
      customTools: () => [
        { type: "custom", name: "mcp__srv__echo", input_schema: {} },
      ],
    });
    await expect(
      runner.prepareSession("wrk_default", "sesn_collide"),
    ).rejects.toThrow("MCP tool name collides with a custom tool: mcp__srv__echo");
  });

  it("closes MCP connections when the session closes", async () => {
    fixture = await startMcpFixture([echoTool()]);
    const closeSpy = vi.spyOn(McpConnection.prototype, "close");
    runner = mcpRunner({ url: fixture.url });
    await runner.prepareSession("wrk_default", "sesn_dispose");
    expect(closeSpy).not.toHaveBeenCalled();
    await runner.closeSession("wrk_default", "sesn_dispose");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes MCP connections when the runner closes", async () => {
    fixture = await startMcpFixture([echoTool()]);
    const closeSpy = vi.spyOn(McpConnection.prototype, "close");
    runner = mcpRunner({ url: fixture.url });
    await runner.prepareSession("wrk_default", "sesn_rclose");
    runner.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    runner = undefined;
  });

  it("exhausts the retry budget across fresh-handle rebuilds, then stops dialing", async () => {
    const attempts: string[] = [];
    runner = mcpRunner({
      url: "http://127.0.0.1:1/mcp", // nothing listens on port 1
      maxConsecutiveFailures: 2,
      idleTtlMs: 20,
      onConnection: (event) => attempts.push(event),
    });

    await runner.prepareSession("wrk_default", "sesn_budget");
    expect(attempts).toEqual(["connect_failed"]); // count 1, retrying

    // The failed handle is marked closeWhenIdle; the eviction timer disposes
    // it, and the next prepare builds a fresh handle that re-dials (count 2
    // = budget → exhausted).
    await vi.waitFor(
      async () => {
        await runner!.prepareSession("wrk_default", "sesn_budget");
        expect(attempts).toEqual(["connect_failed", "connect_failed"]);
      },
      { timeout: 5_000, interval: 25 },
    );

    // Exhausted: even after another eviction window, no further dials.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await runner.prepareSession("wrk_default", "sesn_budget");
    expect(attempts).toEqual(["connect_failed", "connect_failed"]);
  });

  it("recovers on the next rebuild when the server comes back", async () => {
    // Reserve a port by binding-then-closing a fixture, fail once against
    // it, restart on the same port, and watch the fresh handle connect.
    const probe = await startMcpFixture([echoTool()]);
    const port = Number(new URL(probe.url).port);
    await probe.close();

    const attempts: string[] = [];
    const url = `http://127.0.0.1:${port}/mcp`;
    runner = mcpRunner({
      url,
      maxConsecutiveFailures: 5,
      idleTtlMs: 20,
      onConnection: (event) => attempts.push(event),
    });

    await runner.prepareSession("wrk_default", "sesn_recover");
    expect(attempts).toEqual(["connect_failed"]);

    fixture = await startMcpFixture([echoTool()], { port });
    await vi.waitFor(
      async () => {
        await runner!.prepareSession("wrk_default", "sesn_recover");
        expect(attempts.at(-1)).toBe("connected");
      },
      { timeout: 5_000, interval: 25 },
    );
    const names = runner.customToolNames?.("wrk_default", "sesn_recover");
    expect(names?.has("mcp__srv__echo")).toBe(true);
  });
});
