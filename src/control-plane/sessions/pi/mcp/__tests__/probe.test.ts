import { describe, expect, it, vi } from "vitest";
import { probeMcpInitialize } from "../probe.ts";
import type { McpFetch } from "../fetch.ts";

const RESULT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: {} },
});

describe("probeMcpInitialize", () => {
  it("sends one frozen-token initialize request and accepts JSON", async () => {
    const fetch = vi.fn(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer frozen-token");
      expect(headers.get("accept")).toBe("application/json, text/event-stream");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      });
      return new Response(RESULT, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as McpFetch;

    await expect(
      probeMcpInitialize("https://mcp.example/mcp", "Bearer frozen-token", fetch, {
        capBytes: 4096,
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ reached: true, initializeSucceeded: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns promptly after the matching SSE response and cancels the stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${RESULT}\n\n`));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetch = vi.fn(async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as McpFetch;

    const result = await probeMcpInitialize(
      "https://mcp.example/mcp",
      undefined,
      fetch,
      { capBytes: 4096, timeoutMs: 1000 },
    );
    expect(result).toMatchObject({
      reached: true,
      body: RESULT,
      bodyTruncated: false,
      initializeSucceeded: true,
    });
    expect(cancelled).toBe(true);
  });

  it("treats a JSON-RPC error as reached but not initialized", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as McpFetch;
    await expect(
      probeMcpInitialize("https://mcp.example/mcp", undefined, fetch, {
        capBytes: 4096,
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ reached: true, initializeSucceeded: false });
  });

  it("caps and scrubs hostile bodies", async () => {
    const secret = "rotated-token-value";
    const body = `${secret}:${"x".repeat(5000)}`;
    const fetch = vi.fn(async () =>
      new Response(body, {
        status: 401,
        headers: { "content-type": "text/plain" },
      })) as McpFetch;
    const result = await probeMcpInitialize(
      "https://mcp.example/mcp",
      `Bearer ${secret}`,
      fetch,
      { capBytes: 4096, timeoutMs: 1000, knownSecrets: [secret] },
    );
    expect(result).toMatchObject({ reached: true, bodyTruncated: true });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not wait past the cap for a held-open non-SSE body", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4096).fill(120));
      },
      cancel() { cancelled = true; },
    });
    const fetch = vi.fn(async () =>
      new Response(stream, { status: 500, headers: { "content-type": "text/plain" } })) as McpFetch;
    const result = await probeMcpInitialize(
      "https://mcp.example/mcp",
      undefined,
      fetch,
      { capBytes: 4096, timeoutMs: 1000 },
    );
    expect(result).toMatchObject({
      reached: true,
      statusCode: 500,
      bodyTruncated: true,
    });
    expect(cancelled).toBe(true);
  });

  it("scrubs reflected secrets from content type and a cap-boundary prefix", async () => {
    const secret = "boundary-secret-value";
    const body = `${"x".repeat(4090)}${secret}`;
    const fetch = vi.fn(async () =>
      new Response(body, {
        status: 401,
        headers: {
          "content-type": `text/plain; reflected=${secret}`,
          "content-length": String(Buffer.byteLength(body)),
        },
      })) as McpFetch;
    const result = await probeMcpInitialize(
      "https://mcp.example/mcp",
      `Bearer ${secret}`,
      fetch,
      { capBytes: 4096, timeoutMs: 1000, knownSecrets: [secret] },
    );
    expect(result).toMatchObject({ reached: true, bodyTruncated: true });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret.slice(0, 6));
  });

  it("scrubs an encoded secret prefix split by the cap", async () => {
    const secret = "access+/0=&?%_CANARY";
    const encoded = encodeURIComponent(secret);
    const body = `${"x".repeat(4088)}${encoded}`;
    const fetch = vi.fn(async () =>
      new Response(body, {
        status: 401,
        headers: {
          "content-type": "text/plain",
          "content-length": String(Buffer.byteLength(body)),
        },
      })) as McpFetch;
    const result = await probeMcpInitialize(
      "https://mcp.example/mcp",
      `Bearer ${secret}`,
      fetch,
      { capBytes: 4096, timeoutMs: 1000, knownSecrets: [secret] },
    );
    expect(result).toMatchObject({ reached: true, bodyTruncated: true });
    expect(JSON.stringify(result)).not.toContain("access%2");
  });
});
