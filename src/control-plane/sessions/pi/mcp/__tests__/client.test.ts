// Plan 0122 §4.2/§5 — McpConnection against the in-process fixture.
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpConnection } from "../client.ts";
import { createGuardedMcpFetch } from "../fetch.ts";
import { echoTool, startMcpFixture, type McpFixture } from "./fixture.ts";

const seamFetch = createGuardedMcpFetch({ allowAddress: () => true });

let fixture: McpFixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe("McpConnection (plan 0122 §4.2)", () => {
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
