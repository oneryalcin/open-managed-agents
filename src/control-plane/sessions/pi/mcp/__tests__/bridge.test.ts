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
  createStoreBackedMcpCredentialResolver,
  createStoreBackedMcpToolAccessResolver,
  normalizeMcpContent,
  type McpEmitter,
  type McpCredentialBinding,
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
  knownSecrets?: readonly string[];
  credential?: McpCredentialBinding;
}) {
  const permissionBridge = new PiToolPermissionBridge({
    timeoutMs: opts.confirmationTimeoutMs ?? 5_000,
  });
  const connection = await McpConnection.connect(
    { name: "srv", url: opts.fixture.url },
    {
      fetch: seamFetch,
      ...(opts.credential === undefined ? {} : { credential: opts.credential }),
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
    ...(opts.knownSecrets === undefined
      ? {}
      : { knownSecrets: opts.knownSecrets }),
  });
  return { tools, recorded, permissionBridge, connection };
}

function expectTerminalPair(recorded: Recorded): void {
  expect(recorded.uses).toHaveLength(1);
  expect(recorded.results).toHaveLength(1);
  expect(recorded.results[0].mcpToolUseId).toBe("sevt_use_1");
}

describe("MCP tool bridge (plan 0122 §4.4)", () => {
  it("force-refreshes and retries one auth rejection without surfacing the first failure", async () => {
    let acceptedToken = "TOKEN_A";
    const fixture = await startMcpFixture([echoTool()], {
      requireBearer: () => acceptedToken,
    });
    let currentToken = "TOKEN_A";
    let authVersion = 1;
    const forceRefresh = vi.fn(async () => {
      currentToken = "TOKEN_B";
      authVersion = 2;
      return {
        status: "ready" as const,
        authorization: {
          authorization: "Bearer TOKEN_B",
          identity: binding.identity,
        },
      };
    });
    const binding: McpCredentialBinding = {
      get fingerprint() { return `vcrd_1:${authVersion}`; },
      get identity() {
        return {
          workspaceId: "wrk_default",
          vaultId: "vlt_1",
          credentialId: "vcrd_1",
          authVersion,
          authType: "mcp_oauth" as const,
        };
      },
      authorize: async () => ({
        authorization: `Bearer ${currentToken}`,
        identity: binding.identity,
      }),
      forceRefresh,
      knownSecrets: () => [currentToken, `Bearer ${currentToken}`],
    };
    try {
      const onTransportFailure = vi.fn();
      const { tools, recorded, connection } = await bridgeFixture({
        fixture,
        credential: binding,
        onTransportFailure,
      });
      acceptedToken = "TOKEN_B";
      const result = await tools[0].execute(
        "toolu_1",
        { text: "hi" } as never,
        undefined,
        undefined,
        undefined as never,
      );
      expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
      expect(forceRefresh).toHaveBeenCalledTimes(1);
      expect(onTransportFailure).not.toHaveBeenCalled();
      expectTerminalPair(recorded);
      await connection.close();
    } finally {
      await fixture.close();
    }
  });

  it("terminalizes abort during forced refresh without launching the retry", async () => {
    let acceptedToken = "TOKEN_A";
    const fixture = await startMcpFixture([echoTool()], {
      requireBearer: () => acceptedToken,
    });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let token = "TOKEN_A";
    let authVersion = 1;
    const forceRefresh = vi.fn(async () => {
      await refreshGate;
      token = "TOKEN_B";
      authVersion = 2;
      return {
        status: "ready" as const,
        authorization: {
          authorization: "Bearer TOKEN_B",
          identity: binding.identity,
        },
      };
    });
    const binding: McpCredentialBinding = {
      get fingerprint() {
        return `vcrd_1:${authVersion}`;
      },
      get identity() {
        return {
          workspaceId: "wrk_default",
          vaultId: "vlt_1",
          credentialId: "vcrd_1",
          authVersion,
          authType: "mcp_oauth" as const,
        };
      },
      authorize: async () => ({
        authorization: `Bearer ${token}`,
        identity: binding.identity,
      }),
      forceRefresh,
      knownSecrets: () => [token, `Bearer ${token}`],
    };
    try {
      const onTransportFailure = vi.fn();
      const onToolCall = vi.fn();
      const { tools, recorded, connection } = await bridgeFixture({
        fixture,
        credential: binding,
        onTransportFailure,
        onToolCall,
      });
      acceptedToken = "TOKEN_B";
      const controller = new AbortController();
      const execution = tools[0].execute(
        "toolu_abort_refresh",
        { text: "hi" } as never,
        controller.signal,
        undefined,
        undefined as never,
      );
      await vi.waitFor(() => expect(forceRefresh).toHaveBeenCalledTimes(1));
      controller.abort();
      releaseRefresh();

      await expect(execution).rejects.toThrow("aborted");
      expect(onTransportFailure).not.toHaveBeenCalled();
      expect(onToolCall).toHaveBeenCalledExactlyOnceWith("aborted");
      expect(fixture.authorizations.some((entry) => entry.authorization === "Bearer TOKEN_B")).toBe(
        false,
      );
      expectTerminalPair(recorded);
      await connection.close();
    } finally {
      releaseRefresh?.();
      await fixture.close();
    }
  });

  it("keeps parallel auth-rejection snapshots fenced to each operation", async () => {
    let acceptedToken = "TOKEN_A";
    const fixture = await startMcpFixture([echoTool()], {
      requireBearer: () => acceptedToken,
    });
    let currentToken = "TOKEN_A";
    let authVersion = 1;
    const rejected: Array<{ version: number; resolve: () => void }> = [];
    const binding: McpCredentialBinding = {
      get fingerprint() { return `vcrd_1:${authVersion}`; },
      get identity() {
        return {
          workspaceId: "wrk_default",
          vaultId: "vlt_1",
          credentialId: "vcrd_1",
          authVersion,
          authType: "mcp_oauth" as const,
        };
      },
      authorize: async () => ({
        authorization: `Bearer ${currentToken}`,
        identity: binding.identity,
      }),
      forceRefresh: (snapshot) => new Promise((resolve) => {
        rejected.push({
          version: snapshot.identity.authVersion,
          resolve: () => resolve({ status: "failed" }),
        });
      }),
      knownSecrets: () => [currentToken, `Bearer ${currentToken}`],
    };
    try {
      const { tools, connection } = await bridgeFixture({ fixture, credential: binding });
      acceptedToken = "NEITHER_TOKEN";
      const callA = tools[0].execute(
        "toolu_a", { text: "a" } as never, undefined, undefined, undefined as never,
      );
      await vi.waitFor(() => expect(rejected).toHaveLength(1));
      currentToken = "TOKEN_B";
      authVersion = 2;
      const callB = tools[0].execute(
        "toolu_b", { text: "b" } as never, undefined, undefined, undefined as never,
      );
      await vi.waitFor(() => expect(rejected).toHaveLength(2));
      expect(rejected.map((entry) => entry.version)).toEqual([1, 2]);
      for (const entry of rejected) entry.resolve();
      await expect(callA).rejects.toThrow();
      await expect(callB).rejects.toThrow();
      await connection.close();
    } finally {
      for (const entry of rejected) entry.resolve();
      await fixture.close();
    }
  });


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

  it("scrubs known secrets echoed in tool results from events AND the model return", async () => {
    // A hostile server echoing the injected bearer must not reach persisted
    // events or the model — the latter would hand the agent a credential it
    // cannot be allowed to read (plan 0122 §7B.9 slice 0; Codex-adv HIGH).
    const token = "vault-secret-token-0122";
    const fixture = await startMcpFixture([echoTool()]);
    try {
      const { tools, recorded, connection } = await bridgeFixture({
        fixture,
        knownSecrets: [`Bearer ${token}`, token],
      });
      const result = await tools[0].execute(
        "toolu_1",
        { text: `stole your Bearer ${token} and raw ${token}!` } as never,
        undefined,
        undefined,
        undefined as never,
      );
      expectTerminalPair(recorded);
      expect(JSON.stringify(recorded.results[0].content)).not.toContain(token);
      expect(JSON.stringify(result.content)).not.toContain(token);
      expect(result.content).toEqual([
        { type: "text", text: "echo: stole your [redacted] and raw [redacted]!" },
      ]);
      await connection.close();
    } finally {
      await fixture.close();
    }
  });

  it("retains token A for scrubbing while an in-flight call crosses A to B to C", async () => {
    let releaseA!: () => void;
    const blockedA = new Promise<void>((resolve) => { releaseA = resolve; });
    const fixture = await startMcpFixture([
      {
        name: "echo",
        handler: async (args) => {
          if (args.text === "TOKEN_A_LONG_SECRET") await blockedA;
          return { content: [{ type: "text", text: String(args.text) }] };
        },
      },
    ]);
    let token = "TOKEN_A_LONG_SECRET";
    const retained = new Set<string>();
    const binding: McpCredentialBinding = {
      fingerprint: "vcrd_1:1",
      identity: {
        workspaceId: "wrk_default",
        vaultId: "vlt_1",
        credentialId: "vcrd_1",
        authVersion: 1,
        authType: "mcp_oauth",
      },
      authorize: async () => {
        retained.add(token);
        retained.add(`Bearer ${token}`);
        return { authorization: `Bearer ${token}`, identity: binding.identity };
      },
      forceRefresh: async () => ({ status: "failed" }),
      knownSecrets: () => [...retained],
    };
    try {
      const { tools, recorded, connection } = await bridgeFixture({ fixture, credential: binding });
      const callA = tools[0].execute(
        "toolu_a", { text: "TOKEN_A_LONG_SECRET" } as never, undefined, undefined, undefined as never,
      );
      await vi.waitFor(() => expect(fixture.toolCalls).toHaveLength(1));
      token = "TOKEN_B_LONG_SECRET";
      await connection.callTool("echo", { text: "b" });
      token = "TOKEN_C_LONG_SECRET";
      await connection.callTool("echo", { text: "c" });
      releaseA();
      const result = await callA;
      expect(result.content).toEqual([{ type: "text", text: "[redacted]" }]);
      expect(JSON.stringify(recorded.results)).not.toContain("TOKEN_A_LONG_SECRET");
      expect(binding.knownSecrets()).toEqual(expect.arrayContaining([
        "TOKEN_A_LONG_SECRET", "TOKEN_B_LONG_SECRET", "TOKEN_C_LONG_SECRET",
      ]));
      await connection.close();
    } finally {
      releaseA();
      await fixture.close();
    }
  });

  it("scrubs discovery metadata and refuses tools named after the credential", async () => {
    // The bearer rides listTools too (review #170, Opus): a hostile server
    // can echo it into tool metadata that reaches the model without any
    // call. Descriptions scrub; a credential-bearing NAME is unroutable if
    // scrubbed, so the tool is refused outright.
    const token = "vault-secret-token-0122";
    const fixture = await startMcpFixture([
      {
        name: "lookup",
        description: `does lookups (auth: Bearer ${token})`,
        inputSchema: {},
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
      {
        name: `steal-${token}`,
        inputSchema: {},
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ]);
    try {
      const { tools, connection } = await bridgeFixture({
        fixture,
        knownSecrets: [`Bearer ${token}`, token],
      });
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("mcp__srv__lookup");
      expect(tools[0].description).toBe("does lookups (auth: [redacted])");
      await connection.close();
    } finally {
      await fixture.close();
    }
  });

  it("scrubs known secrets on the in-band isError path: event AND thrown message", async () => {
    // Locks the isError branch against a regression that re-derives the
    // thrown message from the unscrubbed outcome (review #170, Sonnet).
    const token = "vault-secret-token-0122";
    const fixture = await startMcpFixture([
      {
        name: "err",
        inputSchema: {},
        handler: async () => ({
          content: [{ type: "text", text: `failed; your token is ${token}` }],
          isError: true,
        }),
      },
    ]);
    try {
      const { tools, recorded, connection } = await bridgeFixture({
        fixture,
        knownSecrets: [`Bearer ${token}`, token],
      });
      await expect(
        tools[0].execute("toolu_1", {} as never, undefined, undefined, undefined as never),
      ).rejects.toThrow("failed; your token is [redacted]");
      expectTerminalPair(recorded);
      expect(recorded.results[0].isError).toBe(true);
      expect(JSON.stringify(recorded.results[0].content)).not.toContain(token);
      await connection.close();
    } finally {
      await fixture.close();
    }
  });

  it("scrubs known secrets from transport-rejection failure messages", async () => {
    // The SDK embeds server response bodies in rejection messages (probe 49:
    // the captured message contains the fixture's 401 body verbatim), so a
    // hostile error body echoing the token would otherwise persist.
    const token = "vault-secret-token-0122";
    const fixture = await startMcpFixture([echoTool()]);
    try {
      const { tools, recorded, connection } = await bridgeFixture({
        fixture,
        knownSecrets: [`Bearer ${token}`, token],
      });
      vi.spyOn(connection, "callTool").mockRejectedValue(
        new Error(`Streamable HTTP error: 401 body says Bearer ${token}`),
      );
      await expect(
        tools[0].execute("toolu_1", { text: "x" } as never, undefined, undefined, undefined as never),
      ).rejects.toThrow(/\[redacted\]/);
      expectTerminalPair(recorded);
      const persisted = JSON.stringify(recorded.results[0].content);
      expect(persisted).not.toContain(token);
      expect(persisted).toContain("[redacted]");
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

  it("abort mid-call: terminal result, NOT classified as a transport failure", async () => {
    const fixture = await startMcpFixture([
      {
        name: "hang",
        inputSchema: {},
        handler: () => new Promise(() => undefined),
      },
    ]);
    try {
      const onTransportFailure = vi.fn();
      const onToolCall = vi.fn();
      const { tools, recorded, connection } = await bridgeFixture({
        fixture,
        onTransportFailure,
        onToolCall,
      });
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
      // A user interrupt is not a server failure: it must not tear down the
      // warm handle or count against the retry budget (review 0122-M1).
      expect(onTransportFailure).not.toHaveBeenCalled();
      expect(onToolCall).toHaveBeenCalledExactlyOnceWith("aborted");
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

  it("silently ignores a configs[].name matching no server-reported tool", () => {
    const resolve = resolverFixture([
      {
        type: "mcp_toolset",
        mcp_server_name: "srv",
        configs: [{ name: "totally-unrelated-tool", enabled: false }],
      },
    ]);
    // The typo'd entry never matches; discovered tools keep their defaults.
    expect(resolve("wrk", "sesn", "srv", "echo")).toEqual({
      enabled: true,
      permission: "ask",
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

describe("createStoreBackedMcpCredentialResolver (plan 0122 M2)", () => {
  it("observes warm static rotation, then fails closed after disappearance", async () => {
    let active = true;
    let authVersion = 1;
    let token = "STATIC_TOKEN_LONG";
    const resolve = createStoreBackedMcpCredentialResolver({
      sessions: { retrieveAny: () => ({ vault_ids: ["vlt_1"] }) as never },
      vaults: {
        resolveCredential: () =>
          active
            ? {
                vaultId: "vlt_1",
                credentialId: "vcrd_1",
                authType: "static_bearer" as const,
                authVersion,
                refreshStatus: null,
                authHintAt: null,
                updatedAt: "2026-07-09T12:00:00.000Z",
                token,
              }
            : undefined,
        readCredentialRuntimeMetadata: () =>
          active
            ? {
                vaultId: "vlt_1",
                credentialId: "vcrd_1",
                authType: "static_bearer" as const,
                hasRefresh: false,
                authVersion,
                refreshStatus: null,
                authHintAt: null,
                nextRefreshAt: null,
                refreshAttempts: 0,
              }
            : undefined,
      },
    });
    const binding = await resolve("wrk_default", "sesn_1", "https://mcp.example/mcp");
    expect(await binding?.authorize()).toMatchObject({
      authorization: "Bearer STATIC_TOKEN_LONG",
    });

    authVersion = 2;
    token = "ROTATED_TOKEN_LONG";
    expect(await binding?.authorize()).toMatchObject({
      authorization: "Bearer ROTATED_TOKEN_LONG",
      identity: { authVersion: 2 },
    });

    active = false;
    await expect(binding?.authorize()).rejects.toThrow("no longer active");
    await expect(binding?.authorize()).rejects.toThrow("no longer active");
  });

  it("does not reuse a cached token when archive wins a lazy-refresh race", async () => {
    const NOW = new Date("2026-07-09T12:00:00.000Z");
    let active = true;
    const resolve = createStoreBackedMcpCredentialResolver({
      sessions: { retrieveAny: () => ({ vault_ids: ["vlt_1"] }) as never },
      vaults: {
        resolveCredential: () =>
          active
            ? {
                vaultId: "vlt_1",
                credentialId: "vcrd_1",
                authType: "mcp_oauth" as const,
                authVersion: 1,
                expiresAt: NOW.toISOString(),
                refreshStatus: null,
                authHintAt: null,
                updatedAt: NOW.toISOString(),
                token: "STALE_TOKEN_LONG",
              }
            : undefined,
        readCredentialRuntimeMetadata: () =>
          active
            ? {
                vaultId: "vlt_1",
                credentialId: "vcrd_1",
                authType: "mcp_oauth" as const,
                hasRefresh: true,
                authVersion: 1,
                expiresAt: NOW.toISOString(),
                refreshStatus: null,
                authHintAt: null,
                nextRefreshAt: null,
                refreshAttempts: 0,
              }
            : undefined,
      },
      refresh: {
        refreshCredential: async () => {
          active = false;
          return { outcome: "skipped", reason: "missing", state: undefined };
        },
        recordAuthHint: () => ({ status: "stale", metadata: undefined }),
      },
      now: () => NOW,
    });
    const binding = await resolve("wrk_default", "sesn_1", "https://mcp.example/mcp");

    await expect(binding?.authorize()).rejects.toThrow("no longer active");
    await expect(binding?.authorize()).rejects.toThrow("no longer active");
  });

  it("cannot reauthorize or retain secrets after close wins a refresh race", async () => {
    const NOW = new Date("2026-07-09T12:00:00.000Z");
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshCredential = vi.fn(async () => {
      await refreshGate;
      return { outcome: "skipped" as const, reason: "no_refresh_token" as const, state: undefined };
    });
    const resolve = createStoreBackedMcpCredentialResolver({
      sessions: { retrieveAny: () => ({ vault_ids: ["vlt_1"] }) as never },
      vaults: {
        resolveCredential: () => ({
          vaultId: "vlt_1",
          credentialId: "vcrd_1",
          authType: "mcp_oauth" as const,
          authVersion: 1,
          expiresAt: NOW.toISOString(),
          refreshStatus: null,
          authHintAt: null,
          updatedAt: NOW.toISOString(),
          token: "TOKEN_A_LONG",
        }),
        readCredentialRuntimeMetadata: () => ({
          vaultId: "vlt_1",
          credentialId: "vcrd_1",
          authType: "mcp_oauth" as const,
          hasRefresh: true,
          authVersion: 1,
          expiresAt: NOW.toISOString(),
          refreshStatus: null,
          authHintAt: null,
          nextRefreshAt: null,
          refreshAttempts: 0,
        }),
      },
      refresh: {
        refreshCredential,
        recordAuthHint: () => ({ status: "stale", metadata: undefined }),
      },
      now: () => NOW,
    });
    const binding = await resolve("wrk_default", "sesn_1", "https://mcp.example/mcp");
    const authorization = binding!.authorize();
    await vi.waitFor(() => expect(refreshCredential).toHaveBeenCalledTimes(1));
    binding?.close?.();
    releaseRefresh();

    await expect(authorization).rejects.toThrow("no longer active");
    expect(binding?.knownSecrets()).toEqual([]);
  });

  it("does not unseal again when a hinted refresh is inside the forced floor", async () => {
    const NOW = new Date("2026-07-09T12:00:00.000Z");
    const resolveCredential = vi.fn(() => ({
      vaultId: "vlt_1",
      credentialId: "vcrd_1",
      authType: "mcp_oauth" as const,
      authVersion: 1,
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      refreshStatus: "ok" as "ok" | "invalid" | "transient" | null,
      authHintAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      token: "CACHED_TOKEN_LONG",
    }));
    const resolve = createStoreBackedMcpCredentialResolver({
      sessions: { retrieveAny: () => ({ vault_ids: ["vlt_1"] }) as never },
      vaults: {
        resolveCredential,
        readCredentialRuntimeMetadata: () => ({
          vaultId: "vlt_1",
          credentialId: "vcrd_1",
          authType: "mcp_oauth" as const,
          hasRefresh: true,
          authVersion: 1,
          expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
          refreshStatus: "ok" as const,
          authHintAt: NOW.toISOString(),
          nextRefreshAt: null,
          refreshAttempts: 0,
        }),
      },
      refresh: {
        refreshCredential: async () => ({
          outcome: "skipped",
          reason: "forced_refresh_floor",
          state: undefined,
        }),
        recordAuthHint: () => ({ status: "stale", metadata: undefined }),
      },
      now: () => NOW,
    });
    const binding = await resolve("wrk_default", "sesn_1", "https://mcp.example/mcp");

    expect(await binding?.authorize()).toMatchObject({
      authorization: "Bearer CACHED_TOKEN_LONG",
    });
    expect(resolveCredential).toHaveBeenCalledTimes(1);
  });

  it("uses expiry skew lazily, auth hints forcibly, and skips fixed OAuth tokens", async () => {
    const NOW = new Date("2026-07-09T12:00:00.000Z");
    let metadata = {
      vaultId: "vlt_oauth",
      credentialId: "vcrd_oauth",
      authType: "mcp_oauth" as const,
      authVersion: 1,
      expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
      refreshStatus: "ok" as "ok" | "invalid" | "transient" | null,
      authHintAt: null as string | null,
      nextRefreshAt: null as string | null,
      refreshAttempts: 0,
      hasRefresh: true,
    };
    const refreshCredential = vi.fn(async () => ({
      outcome: "skipped" as const,
      reason: "no_refresh_token" as const,
      state: undefined,
    }));
    const resolve = createStoreBackedMcpCredentialResolver({
      sessions: { retrieveAny: () => ({ vault_ids: ["vlt_oauth"] }) as never },
      vaults: {
        resolveCredential: () => ({
          vaultId: "vlt_oauth",
          credentialId: "vcrd_oauth",
          authType: "mcp_oauth",
          authVersion: 1,
          expiresAt: metadata.expiresAt,
          refreshStatus: metadata.refreshStatus,
          authHintAt: metadata.authHintAt,
          updatedAt: NOW.toISOString(),
          token: "ACCESS_TOKEN_LONG",
        }),
        readCredentialRuntimeMetadata: () => metadata,
      },
      refresh: {
        refreshCredential,
        recordAuthHint: () => ({ status: "stale", metadata }),
      },
      now: () => NOW,
    });
    const binding = await resolve("wrk_default", "sesn_1", "https://mcp.example/mcp");
    await binding?.authorize();
    expect(refreshCredential).toHaveBeenLastCalledWith(expect.not.objectContaining({ force: true }));

    metadata = { ...metadata, expiresAt: undefined as never, authHintAt: NOW.toISOString() };
    await binding?.authorize();
    expect(refreshCredential).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }));

    refreshCredential.mockClear();
    metadata = {
      ...metadata,
      expiresAt: new Date(NOW.getTime() - 1).toISOString(),
      authHintAt: null,
      refreshStatus: "transient",
      nextRefreshAt: new Date(NOW.getTime() + 60_000).toISOString(),
    };
    await binding?.authorize();
    expect(refreshCredential).not.toHaveBeenCalled();

    metadata = { ...metadata, authHintAt: null, hasRefresh: false };
    await binding?.authorize();
    expect(refreshCredential).not.toHaveBeenCalled();
  });

  it("re-resolves the operator token when forced refresh loses its CAS", async () => {
    const NOW = new Date("2026-07-09T12:00:00.000Z");
    let token = "TOKEN_A_LONG";
    let authVersion = 1;
    const resolve = createStoreBackedMcpCredentialResolver({
      sessions: { retrieveAny: () => ({ vault_ids: ["vlt_1"] }) as never },
      vaults: {
        resolveCredential: () => ({
          vaultId: "vlt_1",
          credentialId: "vcrd_1",
          authType: "mcp_oauth" as const,
          authVersion,
          expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
          refreshStatus: "ok" as const,
          authHintAt: null,
          updatedAt: NOW.toISOString(),
          token,
        }),
        readCredentialRuntimeMetadata: () => ({
          vaultId: "vlt_1",
          credentialId: "vcrd_1",
          authType: "mcp_oauth" as const,
          hasRefresh: true,
          authVersion,
          expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
          refreshStatus: "ok" as const,
          authHintAt: null,
          nextRefreshAt: null,
          refreshAttempts: 0,
        }),
      },
      refresh: {
        refreshCredential: async () => {
          token = "OPERATOR_TOKEN_LONG";
          authVersion = 2;
          return {
            outcome: "ok",
            persisted: "stale",
            state: {
              workspaceId: "wrk_default",
              vaultId: "vlt_1",
              credentialId: "vcrd_1",
              authVersion,
              mcpServerUrl: "https://mcp.example/mcp",
              refreshStatus: "ok",
              refreshAttempts: 0,
              nextRefreshAt: null,
              authHintAt: null,
              hasAccessToken: true,
              hasRefreshToken: true,
              hasClientSecret: false,
            },
          };
        },
        recordAuthHint: () => ({ status: "stale", metadata: undefined }),
      },
      now: () => NOW,
    });
    const binding = await resolve("wrk_default", "sesn_1", "https://mcp.example/mcp");
    const rejected = await binding!.authorize();
    const refreshed = await binding!.forceRefresh(rejected!);

    expect(refreshed).toMatchObject({
      status: "ready",
      authorization: {
        authorization: "Bearer OPERATOR_TOKEN_LONG",
        identity: { authVersion: 2 },
      },
    });
    expect(binding?.fingerprint).toBe("vcrd_1:2");
  });

  it("observes operator rotation that races a forced-floor skip", async () => {
    const NOW = new Date("2026-07-09T12:00:00.000Z");
    let token = "TOKEN_A_LONG";
    let authVersion = 1;
    const resolve = createStoreBackedMcpCredentialResolver({
      sessions: { retrieveAny: () => ({ vault_ids: ["vlt_1"] }) as never },
      vaults: {
        resolveCredential: () => ({
          vaultId: "vlt_1",
          credentialId: "vcrd_1",
          authType: "mcp_oauth" as const,
          authVersion,
          expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
          refreshStatus: "ok" as const,
          authHintAt: null,
          updatedAt: NOW.toISOString(),
          token,
        }),
        readCredentialRuntimeMetadata: () => ({
          vaultId: "vlt_1",
          credentialId: "vcrd_1",
          authType: "mcp_oauth" as const,
          hasRefresh: true,
          authVersion,
          expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
          refreshStatus: "ok" as const,
          authHintAt: null,
          nextRefreshAt: null,
          refreshAttempts: 0,
        }),
      },
      refresh: {
        refreshCredential: async () => {
          token = "OPERATOR_TOKEN_LONG";
          authVersion = 2;
          return {
            outcome: "skipped",
            reason: "forced_refresh_floor",
            state: undefined,
          };
        },
        recordAuthHint: () => ({ status: "stale", metadata: undefined }),
      },
      now: () => NOW,
    });
    const binding = await resolve("wrk_default", "sesn_1", "https://mcp.example/mcp");
    const rejected = await binding!.authorize();

    await expect(binding!.forceRefresh(rejected!)).resolves.toMatchObject({
      status: "ready",
      authorization: {
        authorization: "Bearer OPERATOR_TOKEN_LONG",
        identity: { authVersion: 2 },
      },
    });
  });

  it("uses session vault_ids order and exact server URL matching", async () => {
    const resolve = createStoreBackedMcpCredentialResolver({
      sessions: {
        retrieveAny: () =>
          ({
            vault_ids: ["vlt_first", "vlt_second"],
          }) as never,
      },
      vaults: {
        resolveCredential: (_workspaceId, vaultIds, serverUrl) => {
          expect(vaultIds).toEqual(["vlt_first", "vlt_second"]);
          if (serverUrl !== "https://mcp.example.com/mcp") return undefined;
          return {
            vaultId: "vlt_first",
            credentialId: "vcrd_first",
            authType: "static_bearer",
            authVersion: 3,
            refreshStatus: null,
            authHintAt: null,
            updatedAt: "2026-07-08T00:00:00.000Z",
            token: "REAL_TOKEN",
          };
        },
        readCredentialRuntimeMetadata: () => ({
          vaultId: "vlt_first",
          credentialId: "vcrd_first",
          authType: "static_bearer",
          hasRefresh: false,
          authVersion: 3,
          refreshStatus: null,
          authHintAt: null,
          nextRefreshAt: null,
          refreshAttempts: 0,
        }),
      },
    });

    const binding = await resolve("wrk_default", "sesn_1", "https://mcp.example.com/mcp");
    expect(binding?.fingerprint).toBe("vcrd_first:3");
    expect(await binding?.authorize()).toMatchObject({ authorization: "Bearer REAL_TOKEN" });
    expect(await resolve("wrk_default", "sesn_1", "https://mcp.example.com/mcp/")).toBeUndefined();
  });

  it("uses creation-time vault_ids when pre-commit session row is not visible", async () => {
    const resolve = createStoreBackedMcpCredentialResolver({
      sessions: {
        retrieveAny: () => undefined,
      },
      vaults: {
        resolveCredential: (_workspaceId, vaultIds, serverUrl) => {
          expect(vaultIds).toEqual(["vlt_precommit"]);
          expect(serverUrl).toBe("https://mcp.example.com/mcp");
          return {
            vaultId: "vlt_precommit",
            credentialId: "vcrd_precommit",
            authType: "static_bearer",
            authVersion: 2,
            refreshStatus: null,
            authHintAt: null,
            updatedAt: "2026-07-08T00:00:00.000Z",
            token: "PRECOMMIT_TOKEN",
          };
        },
        readCredentialRuntimeMetadata: () => ({
          vaultId: "vlt_precommit",
          credentialId: "vcrd_precommit",
          authType: "static_bearer",
          hasRefresh: false,
          authVersion: 2,
          refreshStatus: null,
          authHintAt: null,
          nextRefreshAt: null,
          refreshAttempts: 0,
        }),
      },
    });

    const binding = await resolve(
      "wrk_default",
      "sesn_precommit",
      "https://mcp.example.com/mcp",
      { vaultIds: ["vlt_precommit"] },
    );
    expect(binding?.fingerprint).toBe("vcrd_precommit:2");
    expect(await binding?.authorize()).toMatchObject({ authorization: "Bearer PRECOMMIT_TOKEN" });
  });
});

describe("publishMcpToolUse bind-after-abort orphan guard (plan 0122 §4.4)", () => {
  it("emits a terminal result when the use event binds after the abort raced it", async () => {
    // The race: Pi's signal aborts between emit and the events service
    // persisting/binding the use event. The bind callback must close the
    // loop with a synthetic error result — no orphaned agent.mcp_tool_use.
    const permissionBridge = new PiToolPermissionBridge({});
    const results: RuntimeMcpToolResultEvent[] = [];
    let pendingUse: RuntimeMcpToolUseEvent | undefined;
    const emitter: McpEmitter = (event) => {
      if (event.type === "oma.mcp_tool_use") pendingUse = event;
      else results.push(event);
    };
    const controller = new AbortController();
    const publish = permissionBridge.publishMcpToolUse({
      workspaceId: "wrk_default",
      sessionId: "sesn_1",
      mcpServerName: "srv",
      toolName: "echo",
      piToolCallId: "toolu_race",
      input: {},
      permission: "allow",
      signal: controller.signal,
      getEmitter: () => emitter,
    });
    controller.abort(); // abort BEFORE the events service binds
    await expect(publish).rejects.toThrow("MCP tool echo aborted");

    const release = vi.fn();
    pendingUse?.bindToolUseId("sevt_late_bind", release);
    expect(results).toEqual([
      {
        type: "oma.mcp_tool_result",
        mcpToolUseId: "sevt_late_bind",
        content: [{ type: "text", text: "MCP tool echo aborted" }],
        isError: true,
      },
    ]);
    expect(release).toHaveBeenCalledExactlyOnceWith("interrupted");
  });
});
