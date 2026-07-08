// In-process streamable-HTTP MCP server fixture (plan 0122 §5). Real SDK
// server, real protocol — no mocks of the wire. Stateful transport: the
// stateless mode expects a transport per request (probe 46 note).
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z, type ZodRawShape } from "zod";

export interface McpFixtureTool {
  name: string;
  description?: string;
  /** Zod raw shape for the input schema; defaults to `{ text: z.string() }`. */
  inputSchema?: ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

export interface McpFixture {
  url: string;
  /** Tool-call hits observed by handlers, in order. */
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /** HTTP-level requests observed, in order (method + path). */
  httpRequests: string[];
  /** HTTP-level Authorization headers observed, in order. */
  authorizations: Array<{ method: string; path: string; authorization: string | null }>;
  close: () => Promise<void>;
}

export async function startMcpFixture(
  tools: readonly McpFixtureTool[],
  opts: { path?: string; port?: number; requireBearer?: string } = {},
): Promise<McpFixture> {
  const path = opts.path ?? "/mcp";
  const toolCalls: McpFixture["toolCalls"] = [];
  const httpRequests: string[] = [];
  const authorizations: McpFixture["authorizations"] = [];

  const mcp = new McpServer({ name: "oma-test-fixture", version: "0.0.1" });
  for (const tool of tools) {
    mcp.registerTool(
      tool.name,
      {
        description: tool.description ?? tool.name,
        inputSchema: tool.inputSchema ?? { text: z.string() },
      },
      async (args: Record<string, unknown>) => {
        toolCalls.push({ name: tool.name, args });
        return tool.handler(args);
      },
    );
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => `fixture-${Math.random().toString(36).slice(2)}`,
  });
  await mcp.connect(transport);

  const http: Server = createServer(async (req, res) => {
    httpRequests.push(`${req.method} ${req.url}`);
    authorizations.push({
      method: req.method ?? "",
      path: req.url ?? "",
      authorization: req.headers.authorization ?? null,
    });
    if (
      opts.requireBearer !== undefined &&
      req.headers.authorization !== `Bearer ${opts.requireBearer}`
    ) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString();
      body = text.length > 0 ? JSON.parse(text) : undefined;
    }
    await transport.handleRequest(req, res, body);
  });
  // Fixed-port binds (the recovery test) can race a lingering socket from
  // the fixture that reserved the port; retry briefly on EADDRINUSE.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(opts.port ?? 0, "127.0.0.1", () => {
          http.removeAllListeners("error");
          resolve();
        });
      });
      break;
    } catch (error) {
      if (attempt >= 20 || (error as { code?: string }).code !== "EADDRINUSE") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const address = http.address();
  if (address === null || typeof address !== "object") {
    throw new Error("fixture failed to bind");
  }

  return {
    url: `http://127.0.0.1:${address.port}${path}`,
    toolCalls,
    httpRequests,
    authorizations,
    close: async () => {
      // Keep-alive sockets from SDK clients (or fire-and-forget disposals)
      // must not wedge teardown.
      http.closeAllConnections?.();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** Convenience: a fixture echo tool. */
export function echoTool(): McpFixtureTool {
  return {
    name: "echo",
    description: "Echoes back the input",
    handler: async (args) => ({
      content: [{ type: "text", text: `echo: ${String(args.text)}` }],
    }),
  };
}
