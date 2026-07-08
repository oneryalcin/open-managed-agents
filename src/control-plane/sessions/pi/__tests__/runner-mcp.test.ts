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
  credentials?: () => { authorization: string; fingerprint: string } | undefined;
  onConnection?: (event: "connected" | "connect_failed" | "auth_failed") => void;
  customTools?: () => readonly { type: "custom"; name: string; input_schema: Record<string, never> }[];
}): PiSessionRunner {
  return new PiSessionRunner({
    ...(opts.idleTtlMs === undefined ? {} : { idleTtlMs: opts.idleTtlMs }),
    ...(opts.customTools === undefined ? {} : { customTools: opts.customTools }),
    mcp: {
      enabled: opts.enabled ?? true,
      servers: () => [{ name: "srv", url: opts.url }],
      ...(opts.credentials === undefined
        ? {}
        : { credentials: () => opts.credentials?.() }),
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

  it("sends bearer credentials to the MCP server on the wire", async () => {
    fixture = await startMcpFixture([echoTool()], {
      requireBearer: "REAL_TOKEN",
    });
    runner = mcpRunner({
      url: fixture.url,
      credentials: () => ({
        authorization: "Bearer REAL_TOKEN",
        fingerprint: "vcrd_real:1",
      }),
    });

    await runner.prepareSession("wrk_default", "sesn_bearer");

    expect(runner.customToolNames?.("wrk_default", "sesn_bearer")?.has(
      "mcp__srv__echo",
    )).toBe(true);
    expect(fixture.authorizations.length).toBeGreaterThan(0);
    expect(fixture.authorizations.every(
      (entry) => entry.authorization === "Bearer REAL_TOKEN",
    )).toBe(true);
    expect(fixture.authorizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          authorization: "Bearer REAL_TOKEN",
        }),
      ]),
    );
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

  it("classifies reached 401/403 MCP dials as authentication failures", async () => {
    const leakedToken = "TOKEN_THAT_MUST_NOT_PERSIST";
    const connectionEvents: Array<"connected" | "connect_failed" | "auth_failed"> = [];
    const connect = vi
      .spyOn(McpConnection, "connect")
      .mockRejectedValue(
        Object.assign(new Error(`probe 401 echoed Bearer ${leakedToken}`), {
          code: 401,
        }),
      );
    runner = mcpRunner({
      url: "https://mcp.example.com/mcp",
      credentials: () => ({
        authorization: `Bearer ${leakedToken}`,
        fingerprint: "vcrd_bad:1",
      }),
      onConnection: (event) => connectionEvents.push(event),
    });

    const controller = new AbortController();
    let failure: unknown;
    try {
      for await (const event of runner.runUserMessage(
        "wrk_default",
        "sesn_auth_class",
        "hello",
        { signal: controller.signal },
      )) {
        if ((event as { type?: unknown }).type === "oma.mcp_connection_failed") {
          failure = event;
          controller.abort();
          break;
        }
      }
    } catch {
      // Abort/model failure after the flush is irrelevant.
    }
    expect(connect).toHaveBeenCalledWith(
      { name: "srv", url: "https://mcp.example.com/mcp" },
      expect.objectContaining({ authorization: `Bearer ${leakedToken}` }),
    );
    expect(JSON.stringify(failure)).not.toContain(leakedToken);
    expect(failure).toMatchObject({
      message: "MCP authentication failed",
      errorType: "mcp_authentication_failed_error",
      retryStatus: "retrying",
    });
    expect(connectionEvents).toEqual(["auth_failed"]);
  });

  it("keeps exhausted handles refreshable when the credential fingerprint changes", async () => {
    const connect = vi
      .spyOn(McpConnection, "connect")
      .mockRejectedValue(Object.assign(new Error("Forbidden"), { code: 403 }));
    let fingerprint = "vcrd_bad:1";
    runner = mcpRunner({
      url: "https://mcp.example.com/mcp",
      maxConsecutiveFailures: 1,
      credentials: () => ({
        authorization: `Bearer ${fingerprint}`,
        fingerprint,
      }),
    });

    await runner.prepareSession("wrk_default", "sesn_rotate");
    expect(connect).toHaveBeenCalledTimes(1);

    // Same exhausted fingerprint: no re-dial, but the skipped handle must
    // remain closeWhenIdle so a later rotation is observed on the next build.
    await runner.prepareSession("wrk_default", "sesn_rotate");
    expect(connect).toHaveBeenCalledTimes(1);

    fingerprint = "vcrd_bad:2";
    await runner.prepareSession("wrk_default", "sesn_rotate");
    expect(connect).toHaveBeenCalledTimes(2);
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

describe("real-runner integration gaps (review 0122-M1, Sonnet)", () => {
  it("flushes queued connection failures through the REAL runOnSession at turn start", async () => {
    // Drives runUserMessage on the real runner: the queued failure must be
    // yielded (production flush path) before the turn fails at the model
    // call (no credentials in tests — the flush must not depend on a
    // successful prompt).
    runner = mcpRunner({
      url: "http://127.0.0.1:1/mcp",
      onConnection: () => undefined,
    });
    // Abort the turn as soon as the flushed failure is observed: the flush
    // happens before the model prompt, so the test never depends on (or
    // performs) a real model call regardless of ambient credentials.
    const controller = new AbortController();
    let failure: unknown;
    try {
      for await (const event of runner!.runUserMessage(
        "wrk_default",
        "sesn_flush",
        "hello",
        { signal: controller.signal },
      )) {
        if ((event as { type?: unknown }).type === "oma.mcp_connection_failed") {
          failure = event;
          controller.abort();
          break;
        }
      }
    } catch {
      // aborted/failed prompt — irrelevant to the flush contract
    }
    expect(failure).toMatchObject({
      mcpServerName: "srv",
      retryStatus: "retrying",
    });
  });

  it("rejects the ambiguous cross-server pi-name pair (a+b__c vs a__b+c)", async () => {
    const toolNamed = (name: string) => ({
      name,
      inputSchema: {},
      handler: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }),
    });
    fixture = await startMcpFixture([toolNamed("b__c")]);
    const second = await startMcpFixture([toolNamed("c")]);
    try {
      runner = new PiSessionRunner({
        mcp: {
          enabled: true,
          servers: () => [
            { name: "a", url: fixture!.url },
            { name: "a__b", url: second.url },
          ],
          access: () => ({ enabled: true, permission: "allow" }),
          fetch: seamFetch,
        },
      });
      await expect(
        runner.prepareSession("wrk_default", "sesn_ambiguous"),
      ).rejects.toThrow("MCP tool name collision across servers: mcp__a__b__c");
    } finally {
      await second.close();
    }
  });
});

describe("MCP message-end coalescing matcher (review 0122-M1, Sonnet)", () => {
  const names = new Set(["mcp__srv__echo"]);
  const messageEnd = (calls: Array<{ id: string; name: string }>) => ({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        ...calls.map((call) => ({
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments: {},
        })),
      ],
    },
  });

  it("splices the matching message_end out of the queue and lists MCP call ids", async () => {
    const { takeMessageEndForMcpToolCall } = await import("../runner.ts");
    const queue: unknown[] = [
      { type: "agent_start" },
      messageEnd([
        { id: "toolu_1", name: "mcp__srv__echo" },
        { id: "toolu_2", name: "bash" }, // non-MCP call in the same message
      ]),
    ];
    const match = takeMessageEndForMcpToolCall(names, [queue], "toolu_1");
    expect(match).toBeDefined();
    expect(match?.suppressedPiToolCallIds).toEqual(["toolu_1"]);
    expect(queue).toEqual([{ type: "agent_start" }]); // spliced out
  });

  it("returns undefined when the message_end was already consumed (standalone fallback)", async () => {
    const { takeMessageEndForMcpToolCall } = await import("../runner.ts");
    expect(
      takeMessageEndForMcpToolCall(names, [[{ type: "agent_start" }]], "toolu_1"),
    ).toBeUndefined();
  });

  it("does not match toolCalls whose name is not an MCP pi-name (set membership)", async () => {
    const { takeMessageEndForMcpToolCall } = await import("../runner.ts");
    const queue: unknown[] = [messageEnd([{ id: "toolu_1", name: "mcp__like__this" }])];
    expect(takeMessageEndForMcpToolCall(names, [queue], "toolu_1")).toBeUndefined();
    expect(queue).toHaveLength(1); // untouched
  });
});
