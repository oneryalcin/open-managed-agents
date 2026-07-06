// Control-plane MCP client (plan 0122 §4.2). One connection per
// (session, declared server), streamable HTTP only, dialed through the
// SSRF-guarded fetch. The sandbox never dials MCP servers and (from M2)
// never sees credentials — connections live control-plane-side by design
// (architecture.md placement decision).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isJsonObject, type JsonObject } from "../../../../types/json.ts";
import type { McpFetch } from "./fetch.ts";

const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;

export interface McpServerDeclaration {
  name: string;
  url: string;
}

export interface McpConnectionOptions {
  fetch: McpFetch;
  /** Per-operation timeout (connect, listTools, callTool). */
  operationTimeoutMs?: number;
}

export interface McpDiscoveredTool {
  name: string;
  description?: string;
  /** JSON Schema as reported by the server (probe 46: draft-07 objects). */
  inputSchema: JsonObject;
}

/**
 * Probe 46: in-band failures (unknown tool, invalid args, handler throw)
 * resolve with `isError: true`; only protocol/transport-level failures make
 * `callTool` reject. Callers must treat a rejection as a connection-class
 * failure, distinct from a tool-level error.
 */
export interface McpToolCallOutcome {
  content: unknown[];
  isError: boolean;
}

export class McpConnection {
  private constructor(
    readonly serverName: string,
    readonly tools: readonly McpDiscoveredTool[],
    private readonly client: Client,
    private readonly timeoutMs: number,
  ) {}

  /** Connect + discover in one step; both share the operation timeout. */
  static async connect(
    declaration: McpServerDeclaration,
    opts: McpConnectionOptions,
  ): Promise<McpConnection> {
    const timeoutMs = opts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    const client = new Client({ name: "open-managed-agents", version: "0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(declaration.url),
      { fetch: opts.fetch },
    );
    try {
      await client.connect(transport, { timeout: timeoutMs });
      const listed = await client.listTools(undefined, { timeout: timeoutMs });
      const tools: McpDiscoveredTool[] = listed.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined
          ? {}
          : { description: tool.description }),
        inputSchema: isJsonObject(tool.inputSchema)
          ? tool.inputSchema
          : { type: "object" },
      }));
      return new McpConnection(declaration.name, tools, client, timeoutMs);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async callTool(
    name: string,
    args: JsonObject,
    signal?: AbortSignal,
  ): Promise<McpToolCallOutcome> {
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      {
        timeout: this.timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return {
      content: Array.isArray(result.content) ? result.content : [],
      isError: result.isError === true,
    };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}
