// Plan 0122 §4.4/§5 — bridge unit tests: the terminal-result rule (every
// emitted oma.mcp_tool_use gets exactly one oma.mcp_tool_result on every
// path) plus content capping and the store-backed access resolver. The
// persisted-event side (real events service, sevt ids, coalescing) is
// covered by the e2e suite.
import { describe, expect, it, vi } from "vitest";
import type {
  RuntimeMcpToolResultEvent,
  RuntimeMcpToolUseEvent,
} from "../../../../events/types.ts";
import { PiToolPermissionBridge } from "../../tool-permissions.ts";
import { McpConnection } from "../client.ts";
import { createGuardedMcpFetch } from "../fetch.ts";
import {
  capContent,
  createMcpToolDefinitions,
  createStoreBackedMcpToolAccessResolver,
  normalizeMcpContent,
  type McpEmitter,
} from "../bridge.ts";
import { echoTool, startMcpFixture, type McpFixture } from "./fixture.ts";

const seamFetch = createGuardedMcpFetch({ allowAddress: () => true });

interface Recorded {
  uses: RuntimeMcpToolUseEvent[];
  results: RuntimeMcpToolResultEvent[];
}

/**
 * Emitter fake standing in for the runner->events-service loop: binds a
 * deterministic sevt id for each use event immediately (the real service
 * does this on persist).
 */
function recordingEmitter(): { emitter: McpEmitter; recorded: Recorded } {
  const recorded: Recorded = { uses: [], results: [] };
  const emitter: McpEmitter = (event) => {
    if (event.type === "oma.mcp_tool_use") {
      recorded.uses.push(event);
      event.bindToolUseId(`sevt_use_${recorded.uses.length}`, () => undefined);
      return;
    }
    recorded.results.push(event);
  };
  return { emitter, recorded };
}

async function bridgeFixture(opts: {
  fixture: McpFixture;
  permission?: "allow" | "ask" | "deny";
  confirmationTimeoutMs?: number;
  operationTimeoutMs?: number;
  outputCapBytes?: number;
  onToolCall?: (outcome: string) => void;
  onTransportFailure?: (server: string, error: Error) => void;
}) {
  const permissionBridge = new PiToolPermissionBridge({
    timeoutMs: opts.confirmationTimeoutMs ?? 5_000,
  });
  const connection = await McpConnection.connect(
    { name: "srv", url: opts.fixture.url },
    {
      fetch: seamFetch,
      ...(opts.operationTimeoutMs === undefined
        ? {}
        : { operationTimeoutMs: opts.operationTimeoutMs }),
    },
  );
  const { emitter, recorded } = recordingEmitter();
  const tools = createMcpToolDefinitions({
    workspaceId: "wrk_default",
    sessionId: "sesn_1",
    connection,
    permissionBridge,
    getEmitter: () => emitter,
    access: () => ({
      enabled: true,
      permission: opts.permission ?? "allow",
    }),
    ...(opts.outputCapBytes === undefined
      ? {}
      : { outputCapBytes: opts.outputCapBytes }),
    ...(opts.onToolCall === undefined ? {} : { onToolCall: opts.onToolCall }),
    ...(opts.onTransportFailure === undefined
      ? {}
      : { onTransportFailure: opts.onTransportFailure }),
  });
  return { tools, recorded, permissionBridge, connection };
}

function expectTerminalPair(recorded: Recorded): void {
  expect(recorded.uses).toHaveLength(1);
  expect(recorded.results).toHaveLength(1);
  expect(recorded.results[0].mcpToolUseId).toBe("sevt_use_1");
}

describe("MCP tool bridge (plan 0122 §4.4)", () => {
  it("success: use event binds before the call, result references it", async () => {
    const fixture = await startMcpFixture([echoTool()]);
    try {
      const { tools, recorded, connection } = await bridgeFixture({ fixture });
      const result = await tools[0].execute(
        "toolu_1",
        { text: "hi" } as never,
        undefined,
        undefined,
        undefined as never,
      );
      expectTerminalPair(recorded);
      expect(recorded.uses[0]).toMatchObject({
        mcpServerName: "srv",
        name: "echo", // bare name in events, not the mcp__ pi name
        evaluatedPermission: "allow",
      });
      expect(recorded.results[0].isError).toBe(false);
      expect(recorded.results[0].content).toEqual([
        { type: "text", text: "echo: hi" },
      ]);
      expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
      await connection.close();
    } finally {
      await fixture.close();
    }
  });

  it("policy deny: terminal error result, zero server hits", async () => {
    const fixture = await startMcpFixture([echoTool()]);
    try {
      const onToolCall = vi.fn();
      const { tools, recorded, connection } = await bridgeFixture({
        fixture,
        permission: "deny",
        onToolCall,
      });
      await expect(
        tools[0].execute("toolu_1", { text: "x" } as never, undefined, undefined, undefined as never),
      ).rejects.toThrow("denied by policy");
      expectTerminalPair(recorded);
      expect(recorded.results[0].isError).toBe(true);
      expect(fixture.toolCalls).toEqual([]);
      expect(onToolCall).toHaveBeenCalledExactlyOnceWith("denied");
      await connection.close();
    } finally {
      await fixture.close();
    }
  });

  it("ask + user deny: deny message becomes the terminal result and the model error", async () => {
    const fixture = await startMcpFixture([echoTool()]);
    try {
      const { tools, recorded, permissionBridge, connection } =
        await bridgeFixture({ fixture, permission: "ask" });
      const execution = tools[0].execute(
        "toolu_1",
        { text: "x" } as never,
        undefined,
        undefined,
        undefined as never,
      );
      await vi.waitFor(() => {
        if (recorded.uses.length === 0) throw new Error("use not emitted yet");
      });
      const commit = permissionBridge.claimConfirmation("wrk_default", "sesn_1", {
        type: "user.tool_confirmation",
        tool_use_id: "sevt_use_1",
        result: "deny",
        deny_message: "use the other repo",
      });
      expect(commit).toBeDefined();
      commit?.();
      await expect(execution).rejects.toThrow("use the other repo");
      expectTerminalPair(recorded);
      expect(recorded.results[0].isError).toBe(true);
      expect(recorded.results[0].content).toEqual([
        { type: "text", text: "use the other repo" },
      ]);
      expect(fixture.toolCalls).toEqual([]);
      await connection.close();
    } finally {
      await fixture.close();
    }
  });

  it("ask + confirmation timeout: terminal result, outcome=timeout", async () => {
    const fixture = await startMcpFixture([echoTool()]);
    try {
      const onToolCall = vi.fn();
      const { tools, recorded, connection } = await bridgeFixture({
        fixture,
        permission: "ask",
        confirmationTimeoutMs: 20,
        onToolCall,
      });
      await expect(
        tools[0].execute("toolu_1", { text: "x" } as never, undefined, undefined, undefined as never),
      ).rejects.toThrow("confirmation timed out");
      expectTerminalPair(recorded);
      expect(recorded.results[0].isError).toBe(true);
      expect(onToolCall).toHaveBeenCalledExactlyOnceWith("timeout");
      expect(fixture.toolCalls).toEqual([]);
      await connection.close();
    } finally {
      await fixture.close();
    }
  });

  it("in-band isError: terminal result carries the error content", async () => {
    const fixture = await startMcpFixture([
      {
        name: "err",
        inputSchema: {},
        handler: async () => ({
          content: [{ type: "text", text: "explicit tool error" }],
          isError: true,
        }),
      },
    ]);
    try {
      const onToolCall = vi.fn();
      const { tools, recorded, connection } = await bridgeFixture({
        fixture,
        onToolCall,
      });
      await expect(
        tools[0].execute("toolu_1", {} as never, undefined, undefined, undefined as never),
      ).rejects.toThrow("explicit tool error");
      expectTerminalPair(recorded);
      expect(recorded.results[0].isError).toBe(true);
      expect(onToolCall).toHaveBeenCalledExactlyOnceWith("error");
      await connection.close();
    } finally {
      await fixture.close();
    }
  });

  it("transport failure mid-call: terminal result + onTransportFailure", async () => {
    const fixture = await startMcpFixture([
      {
        name: "hang",
        inputSchema: {},
        handler: () => new Promise(() => undefined),
      },
    ]);
    try {
      const onTransportFailure = vi.fn();
      const { tools, recorded, connection } = await bridgeFixture({
        fixture,
        operationTimeoutMs: 100,
        onTransportFailure,
      });
      await expect(
        tools[0].execute("toolu_1", {} as never, undefined, undefined, undefined as never),
      ).rejects.toThrow("MCP tool hang failed");
      expectTerminalPair(recorded);
      expect(recorded.results[0].isError).toBe(true);
      expect(onTransportFailure).toHaveBeenCalledExactlyOnceWith(
        "srv",
        expect.any(Error),
      );
      await connection.close();
    } finally {
      await fixture.close();
    }
  });

  it("abort mid-call: terminal result on the abort path", async () => {
    const fixture = await startMcpFixture([
      {
        name: "hang",
        inputSchema: {},
        handler: () => new Promise(() => undefined),
      },
    ]);
    try {
      const { tools, recorded, connection } = await bridgeFixture({ fixture });
      const controller = new AbortController();
      const execution = tools[0].execute(
        "toolu_1",
        {} as never,
        controller.signal,
        undefined,
        undefined as never,
      );
      await vi.waitFor(() => {
        if (fixture.toolCalls.length === 0) throw new Error("not called yet");
      });
      controller.abort();
      await expect(execution).rejects.toThrow();
      expectTerminalPair(recorded);
      expect(recorded.results[0].isError).toBe(true);
      await connection.close();
    } finally {
      await fixture.close();
    }
  });

  it("registration filtering: disabled tools are absent from the Pi surface", async () => {
    const fixture = await startMcpFixture([
      echoTool(),
      {
        name: "hidden",
        inputSchema: {},
        handler: async () => ({ content: [{ type: "text", text: "no" }] }),
      },
    ]);
    try {
      const permissionBridge = new PiToolPermissionBridge({});
      const connection = await McpConnection.connect(
        { name: "srv", url: fixture.url },
        { fetch: seamFetch },
      );
      const tools = createMcpToolDefinitions({
        workspaceId: "wrk_default",
        sessionId: "sesn_1",
        connection,
        permissionBridge,
        getEmitter: () => undefined,
        access: (_w, _s, _server, toolName) => ({
          enabled: toolName === "echo",
          permission: "allow",
        }),
      });
      expect(tools.map((tool) => tool.name)).toEqual(["mcp__srv__echo"]);
      await connection.close();
    } finally {
      await fixture.close();
    }
  });
});

describe("content normalization + cap (plan 0122 §4.4)", () => {
  it("passes text through and stringifies non-text blocks", () => {
    expect(
      normalizeMcpContent([
        { type: "text", text: "plain" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ]),
    ).toEqual([
      { type: "text", text: "plain" },
      { type: "text", text: '{"type":"image","data":"AAAA","mimeType":"image/png"}' },
    ]);
  });

  it("caps oversized text with an explicit marker", () => {
    const blocks = capContent([{ type: "text", text: "x".repeat(100) }], 10);
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as { text: string }).text).toHaveLength(10);
    expect((blocks[1] as { text: string }).text).toBe(
      "[truncated by oma: 100 bytes total]",
    );
  });

  it("caps oversized stringified non-text blocks too (review cluster C)", () => {
    const huge = normalizeMcpContent([
      { type: "image", data: "A".repeat(1000), mimeType: "image/png" },
    ]);
    const blocks = capContent(huge, 50);
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as { text: string }).text.length).toBe(50);
    expect((blocks[1] as { text: string }).text).toMatch(/^\[truncated by oma: \d+ bytes total\]$/);
  });

  it("leaves under-cap content untouched", () => {
    const blocks = [{ type: "text" as const, text: "small" }];
    expect(capContent(blocks, 1000)).toBe(blocks);
  });
});

describe("createStoreBackedMcpToolAccessResolver (plan 0122 §4.4)", () => {
  function resolverFixture(tools: unknown[]) {
    return createStoreBackedMcpToolAccessResolver({
      sessions: {
        retrieveAny: () =>
          ({ agent: { type: "agent", id: "agent_1", version: 1 } }) as never,
      },
      agents: {
        retrieveAny: () => ({ tools }) as never,
      },
    });
  }

  it("defaults to enabled + ask (upstream MCP default, NOT always_allow)", () => {
    const resolve = resolverFixture([
      { type: "mcp_toolset", mcp_server_name: "srv" },
    ]);
    expect(resolve("wrk", "sesn", "srv", "anything")).toEqual({
      enabled: true,
      permission: "ask",
    });
  });

  it("applies default_config false + explicit per-tool allowlist", () => {
    const resolve = resolverFixture([
      {
        type: "mcp_toolset",
        mcp_server_name: "srv",
        default_config: { enabled: false },
        configs: [
          {
            name: "get_issue",
            enabled: true,
            permission_policy: { type: "always_allow" },
          },
        ],
      },
    ]);
    expect(resolve("wrk", "sesn", "srv", "get_issue")).toEqual({
      enabled: true,
      permission: "allow",
    });
    expect(resolve("wrk", "sesn", "srv", "delete_repo").enabled).toBe(false);
  });

  it("denies for a server with no matching toolset", () => {
    const resolve = resolverFixture([
      { type: "mcp_toolset", mcp_server_name: "other" },
    ]);
    expect(resolve("wrk", "sesn", "srv", "echo")).toEqual({
      enabled: false,
      permission: "deny",
    });
  });

  it("matches config names case-sensitively", () => {
    const resolve = resolverFixture([
      {
        type: "mcp_toolset",
        mcp_server_name: "srv",
        configs: [{ name: "Echo", enabled: false }],
      },
    ]);
    // "echo" ≠ "Echo": the disable does not apply.
    expect(resolve("wrk", "sesn", "srv", "echo").enabled).toBe(true);
  });
});
