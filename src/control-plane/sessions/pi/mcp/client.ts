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

// Discovery bounds (review 0122-M1, Codex-adv HIGH): the tool list is
// attacker-influenced input parsed in the shared control plane, so a hostile
// or broken server must not be able to dictate unbounded work. Exceeding any
// bound fails the whole connection deterministically (surfaces as the
// structured mcp_connection_failed_error), never a silent partial register.
const MAX_DISCOVERED_TOOLS = 256;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_TOOL_DESCRIPTION_LENGTH = 4_096;
const MAX_TOOL_SCHEMA_BYTES = 64 * 1024;
const MAX_TOOL_LIST_PAGES = 16;

export interface McpServerDeclaration {
  name: string;
  url: string;
}

export interface McpConnectionOptions {
  fetch: McpFetch;
  authorization?: string;
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
    const requestInit =
      opts.authorization === undefined
        ? undefined
        : { headers: { Authorization: opts.authorization } };
    const transport = new StreamableHTTPClientTransport(
      new URL(declaration.url),
      {
        fetch: opts.fetch,
        ...(requestInit === undefined ? {} : { requestInit }),
      },
    );
    try {
      await client.connect(transport, { timeout: timeoutMs });
      const tools = await discoverTools(client, declaration.name, timeoutMs);
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

/** Paginated discovery (review: nextCursor was silently dropped) + bounds. */
async function discoverTools(
  client: Client,
  serverName: string,
  timeoutMs: number,
): Promise<McpDiscoveredTool[]> {
  const tools: McpDiscoveredTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
    const listed = await client.listTools(
      cursor === undefined ? undefined : { cursor },
      { timeout: timeoutMs },
    );
    for (const tool of listed.tools) {
      if (tools.length >= MAX_DISCOVERED_TOOLS) {
        throw discoveryBoundError(
          serverName,
          `more than ${MAX_DISCOVERED_TOOLS} tools`,
        );
      }
      if (tool.name.length > MAX_TOOL_NAME_LENGTH) {
        throw discoveryBoundError(
          serverName,
          `tool name over ${MAX_TOOL_NAME_LENGTH} chars`,
        );
      }
      const description = tool.description;
      if (
        description !== undefined &&
        description.length > MAX_TOOL_DESCRIPTION_LENGTH
      ) {
        throw discoveryBoundError(
          serverName,
          `tool ${tool.name} description over ${MAX_TOOL_DESCRIPTION_LENGTH} chars`,
        );
      }
      const inputSchema = isJsonObject(tool.inputSchema)
        ? tool.inputSchema
        : { type: "object" };
      if (JSON.stringify(inputSchema).length > MAX_TOOL_SCHEMA_BYTES) {
        throw discoveryBoundError(
          serverName,
          `tool ${tool.name} schema over ${MAX_TOOL_SCHEMA_BYTES} bytes`,
        );
      }
      tools.push({
        name: tool.name,
        ...(description === undefined ? {} : { description }),
        inputSchema,
      });
    }
    cursor = listed.nextCursor ?? undefined;
    if (cursor === undefined) return tools;
  }
  throw discoveryBoundError(
    serverName,
    `more than ${MAX_TOOL_LIST_PAGES} tools/list pages`,
  );
}

function discoveryBoundError(serverName: string, detail: string): Error {
  return new Error(
    `MCP server ${serverName} exceeded discovery bounds: ${detail}`,
  );
}
