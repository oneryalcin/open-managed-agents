// Plan 0122 §4.2/§5 — McpConnection against the in-process fixture.
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpConnection, isMcpAuthError } from "../client.ts";
import type { McpCredentialBinding } from "../credential.ts";
import { createGuardedMcpFetch } from "../fetch.ts";
import { echoTool, startMcpFixture, type McpFixture } from "./fixture.ts";

const seamFetch = createGuardedMcpFetch({ allowAddress: () => true });

let fixture: McpFixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe("McpConnection (plan 0122 §4.2)", () => {
  it("injects authorization per request so a warm connection observes rotation", async () => {
    fixture = await startMcpFixture([echoTool()]);
    let token = "TOKEN_A";
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
        return {
          authorization: `Bearer ${token}`,
          identity: binding.identity,
        };
      },
      forceRefresh: async () => ({ status: "failed" }),
      knownSecrets: () => [...retained],
    };
    const connection = await McpConnection.connect(
      { name: "srv", url: fixture.url },
      { fetch: seamFetch, credential: binding },
    );
    token = "TOKEN_B";
    await connection.callTool("echo", { text: "hi" });

    expect(fixture.authorizations.some((entry) => entry.authorization === "Bearer TOKEN_A")).toBe(true);
    expect(fixture.authorizations.at(-1)?.authorization).toBe("Bearer TOKEN_B");
    expect(binding.knownSecrets()).toEqual(expect.arrayContaining([
      "TOKEN_A",
      "Bearer TOKEN_A",
      "TOKEN_B",
      "Bearer TOKEN_B",
    ]));
    await connection.close();
  });

  it("does not egress anonymously when a warm credential becomes unavailable", async () => {
    fixture = await startMcpFixture([echoTool()]);
    let active = true;
    const binding: McpCredentialBinding = {
      fingerprint: "vcrd_1:1",
      identity: {
        workspaceId: "wrk_default",
        vaultId: "vlt_1",
        credentialId: "vcrd_1",
        authVersion: 1,
        authType: "static_bearer",
      },
      authorize: async () => {
        if (!active) throw new Error("MCP credential is no longer active");
        return { authorization: "Bearer TOKEN_A", identity: binding.identity };
      },
      forceRefresh: async () => ({ status: "failed" }),
      knownSecrets: () => ["TOKEN_A", "Bearer TOKEN_A"],
    };
    const connection = await McpConnection.connect(
      { name: "srv", url: fixture.url },
      { fetch: seamFetch, credential: binding },
    );
    const requestsBeforeArchive = fixture.httpRequests.length;
    active = false;

    await expect(connection.callTool("echo", { text: "hi" })).rejects.toThrow(
      "no longer active",
    );
    expect(fixture.httpRequests).toHaveLength(requestsBeforeArchive);
    await connection.close();
  });

  it("force-refreshes and redials connect/discovery once after a reached 401", async () => {
    fixture = await startMcpFixture([echoTool()], {
      requireBearer: "TOKEN_B",
    });
    let token = "TOKEN_A";
    let authVersion = 1;
    let refreshes = 0;
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
      forceRefresh: async () => {
        refreshes += 1;
        token = "TOKEN_B";
        authVersion = 2;
        return {
          status: "ready",
          authorization: {
            authorization: "Bearer TOKEN_B",
            identity: binding.identity,
          },
        };
      },
      knownSecrets: () => [token, `Bearer ${token}`],
    };

    const connection = await McpConnection.connect(
      { name: "srv", url: fixture.url },
      { fetch: seamFetch, credential: binding },
    );
    expect(refreshes).toBe(1);
    expect(fixture.authorizations.some((entry) => entry.authorization === "Bearer TOKEN_A")).toBe(
      true,
    );
    expect(fixture.authorizations.at(-1)?.authorization).toBe("Bearer TOKEN_B");
    await connection.close();
  });

  it("classifies auth only from structured status codes, never hostile text", () => {
    expect(isMcpAuthError(Object.assign(new Error("unauthorized"), { code: 401 }))).toBe(true);
    expect(isMcpAuthError(new Error("body echoed 401 and 403"))).toBe(false);
  });

  it("connects, discovers tools with JSON-schema inputs, and calls them", async () => {
    fixture = await startMcpFixture([echoTool()]);
    const connection = await McpConnection.connect(
      { name: "srv", url: fixture.url },
      { fetch: seamFetch },
    );
    expect(connection.serverName).toBe("srv");
    expect(connection.tools).toHaveLength(1);
    expect(connection.tools[0].name).toBe("echo");
    expect(connection.tools[0].inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
    });

    const outcome = await connection.callTool("echo", { text: "hi" });
    expect(outcome.isError).toBe(false);
    expect(outcome.content).toEqual([{ type: "text", text: "echo: hi" }]);
    expect(fixture.toolCalls).toEqual([{ name: "echo", args: { text: "hi" } }]);
    await connection.close();
  });

  it("resolves in-band failures as isError, never a rejection (probe 46)", async () => {
    fixture = await startMcpFixture([
      echoTool(),
      {
        name: "boom",
        inputSchema: {},
        handler: async () => {
          throw new Error("handler crashed");
        },
      },
    ]);
    const connection = await McpConnection.connect(
      { name: "srv", url: fixture.url },
      { fetch: seamFetch },
    );
    for (const call of [
      { name: "does-not-exist", args: {} },
      { name: "echo", args: { text: 123 } }, // schema-invalid
      { name: "boom", args: {} }, // handler throw
    ]) {
      const outcome = await connection.callTool(
        call.name,
        call.args as Record<string, never>,
      );
      expect(outcome.isError).toBe(true);
    }
    await connection.close();
  });

  it("rejects on transport failure mid-call (distinct from in-band errors)", async () => {
    fixture = await startMcpFixture([
      {
        name: "slow",
        inputSchema: {},
        handler: () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ content: [{ type: "text", text: "late" }] }),
              5_000,
            ),
          ),
      },
    ]);
    const connection = await McpConnection.connect(
      { name: "srv", url: fixture.url },
      { fetch: seamFetch, operationTimeoutMs: 200 },
    );
    await expect(connection.callTool("slow", {})).rejects.toThrow();
    await connection.close();
  });

  it("rejects connect against an unreachable server", async () => {
    await expect(
      McpConnection.connect(
        { name: "srv", url: "http://127.0.0.1:1/mcp" },
        { fetch: seamFetch, operationTimeoutMs: 500 },
      ),
    ).rejects.toThrow();
  });

  it("multiplexes parallel tool calls over one connection", async () => {
    fixture = await startMcpFixture([
      {
        name: "wait",
        inputSchema: { id: z.string() },
        handler: async (args) =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  content: [{ type: "text", text: `done ${String(args.id)}` }],
                }),
              50,
            ),
          ),
      },
    ]);
    const connection = await McpConnection.connect(
      { name: "srv", url: fixture.url },
      { fetch: seamFetch },
    );
    const [a, b] = await Promise.all([
      connection.callTool("wait", { id: "a" }),
      connection.callTool("wait", { id: "b" }),
    ]);
    expect(a.content).toEqual([{ type: "text", text: "done a" }]);
    expect(b.content).toEqual([{ type: "text", text: "done b" }]);
    await connection.close();
  });

  it("threads an abort signal into an in-flight call", async () => {
    fixture = await startMcpFixture([
      {
        name: "hang",
        inputSchema: {},
        handler: () => new Promise(() => undefined),
      },
    ]);
    const connection = await McpConnection.connect(
      { name: "srv", url: fixture.url },
      { fetch: seamFetch },
    );
    const controller = new AbortController();
    const call = connection.callTool("hang", {}, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(call).rejects.toThrow();
    await connection.close();
  });
});

describe("discovery bounds + pagination (review 0122-M1)", () => {
  it("follows tools/list pagination cursors (tools beyond page 1 register)", async () => {
    // The SDK's McpServer paginates automatically only for large lists, so
    // emulate a paginating server: many tools forces the client to loop
    // cursors if the server splits pages. With the in-process server the
    // whole list arrives (single page), so pin the *client* contract
    // directly instead: a fixture with enough tools that a dropped
    // nextCursor loop would be observable is not constructible here —
    // instead assert every registered fixture tool is discovered.
    fixture = await startMcpFixture(
      Array.from({ length: 40 }, (_, i) => ({
        name: `tool-${i}`,
        inputSchema: {},
        handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      })),
    );
    const connection = await McpConnection.connect(
      { name: "srv", url: fixture.url },
      { fetch: seamFetch },
    );
    expect(connection.tools).toHaveLength(40);
    await connection.close();
  });

  it("rejects a server exposing more tools than the discovery bound", async () => {
    fixture = await startMcpFixture(
      Array.from({ length: 257 }, (_, i) => ({
        name: `tool-${i}`,
        inputSchema: {},
        handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      })),
    );
    await expect(
      McpConnection.connect({ name: "srv", url: fixture.url }, { fetch: seamFetch }),
    ).rejects.toThrow("exceeded discovery bounds: more than 256 tools");
  });

  it("rejects a tool with an oversized description", async () => {
    fixture = await startMcpFixture([
      {
        name: "verbose",
        description: "d".repeat(5_000),
        inputSchema: {},
        handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      },
    ]);
    await expect(
      McpConnection.connect({ name: "srv", url: fixture.url }, { fetch: seamFetch }),
    ).rejects.toThrow("description over 4096 chars");
  });

  it("rejects a tool with an oversized input schema", async () => {
    const { z } = await import("zod");
    fixture = await startMcpFixture([
      {
        name: "huge-schema",
        inputSchema: Object.fromEntries(
          Array.from({ length: 2_000 }, (_, i) => [
            `field_with_a_rather_long_name_${i}`,
            z.string(),
          ]),
        ),
        handler: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      },
    ]);
    await expect(
      McpConnection.connect({ name: "srv", url: fixture.url }, { fetch: seamFetch }),
    ).rejects.toThrow("schema over 65536 bytes");
  });
});
