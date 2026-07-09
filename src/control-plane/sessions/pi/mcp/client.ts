// Control-plane MCP client (plan 0122 §4.2). One connection per
// (session, declared server), streamable HTTP only, dialed through the
// SSRF-guarded fetch. The sandbox never dials MCP servers and (from M2)
// never sees credentials — connections live control-plane-side by design
// (architecture.md placement decision).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isJsonObject, type JsonObject } from "../../../../types/json.ts";
import type { McpFetch } from "./fetch.ts";
import {
  attachMcpAuthSnapshot,
  getMcpAuthSnapshot,
  recordRejectedMcpAuthorization,
  runMcpAuthOperation,
  type McpCredentialBinding,
} from "./credential.ts";

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
  credential?: McpCredentialBinding;
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
    readonly credential?: McpCredentialBinding,
  ) {}

  /** Connect + discover in one step; both share the operation timeout. */
  static async connect(
    declaration: McpServerDeclaration,
    opts: McpConnectionOptions,
  ): Promise<McpConnection> {
    const timeoutMs = opts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = new Client({ name: "open-managed-agents", version: "0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(declaration.url),
        { fetch: credentialFetch(opts.fetch, opts.credential) },
      );
      try {
        const tools = await runMcpAuthOperation(async () => {
          try {
            await client.connect(transport, { timeout: timeoutMs });
            return await discoverTools(client, declaration.name, timeoutMs);
          } catch (error) {
            throw attachMcpAuthSnapshot(error);
          }
        });
        return new McpConnection(
          declaration.name,
          tools,
          client,
          timeoutMs,
          opts.credential,
        );
      } catch (error) {
        const annotated = attachMcpAuthSnapshot(error);
        await client.close().catch(() => undefined);
        const rejectedSnapshot = getMcpAuthSnapshot(annotated);
        if (
          attempt === 0 &&
          opts.credential !== undefined &&
          rejectedSnapshot !== undefined &&
          isMcpAuthError(annotated)
        ) {
          try {
            const refreshed = await opts.credential.forceRefresh(rejectedSnapshot);
            if (refreshed.status === "ready") continue;
          } catch {
            // Adapter failure does not replace the reached server's structured
            // auth rejection; the caller classifies the original final error.
          }
        }
        opts.credential?.close?.();
        throw annotated;
      }
    }
    throw new Error("MCP connection retry exhausted");
  }

  async callTool(
    name: string,
    args: JsonObject,
    signal?: AbortSignal,
  ): Promise<McpToolCallOutcome> {
    const result = await runMcpAuthOperation(async () => {
      try {
        return await this.client.callTool(
          { name, arguments: args },
          undefined,
          {
            timeout: this.timeoutMs,
            ...(signal === undefined ? {} : { signal }),
          },
        );
      } catch (error) {
        throw attachMcpAuthSnapshot(error);
      }
    });
    return {
      content: Array.isArray(result.content) ? result.content : [],
      isError: result.isError === true,
    };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
    this.credential?.close?.();
  }
}

function credentialFetch(
  fetch: McpFetch,
  credential: McpCredentialBinding | undefined,
): McpFetch {
  if (credential === undefined) return fetch;
  return async (url, init) => {
    const snapshot = await credential.authorize();
    const headers = new Headers(init?.headers);
    if (snapshot === undefined) headers.delete("authorization");
    else headers.set("authorization", snapshot.authorization);
    const response = await fetch(url, { ...init, headers });
    if (snapshot !== undefined && (response.status === 401 || response.status === 403)) {
      recordRejectedMcpAuthorization(snapshot);
    }
    return response;
  };
}

export function isMcpAuthError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 401 || code === 403;
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
