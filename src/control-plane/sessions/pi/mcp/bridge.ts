// MCP tool bridge (plan 0122 §4.4) — modeled on the tool-permission path:
// the `sevt_*` id is bound BEFORE the tool executes (via
// PiToolPermissionBridge.publishMcpToolUse, which also owns confirmations),
// and every persisted `agent.mcp_tool_use` gets exactly one terminal
// `agent.mcp_tool_result` — success, in-band error, deny, confirmation
// timeout, abort, call timeout, or transport failure.
//
// The custom-tool bridge contributes only the `defineTool` registration
// shape and text-block content mapping; its resolve-on-user-round-trip event
// pattern is NOT the MCP model (review finding, plan §9 cluster A).
import { defineTool } from "@earendil-works/pi-coding-agent";
import type {
  ManagedAgentsMcpToolset,
  ManagedAgentsTool,
} from "../../../../types/agents.ts";
import type { ManagedAgentsContentBlock } from "../../../../types/events.ts";
import type { JsonObject } from "../../../../types/json.ts";
import type { AgentStore } from "../../../agents/types.ts";
import type {
  RuntimeMcpToolResultEvent,
  RuntimeMcpToolUseEvent,
} from "../../../events/types.ts";
import type { SessionStore } from "../../types.ts";
import type { WorkspaceId } from "../../../workspace.ts";
import type { VaultService } from "../../../vaults/types.ts";
import type {
  BuiltinToolPermission,
  PiToolPermissionBridge,
} from "../tool-permissions.ts";
import type { McpConnection } from "./client.ts";

export const DEFAULT_MCP_OUTPUT_CAP_BYTES = 400 * 1024;

export interface McpToolAccess {
  enabled: boolean;
  permission: BuiltinToolPermission;
}

export type McpToolAccessResolver = (
  workspaceId: WorkspaceId,
  sessionId: string,
  mcpServerName: string,
  toolName: string,
  context?: { agentId?: string },
) => McpToolAccess;

// Upstream default for MCP toolsets is always_ask (mcp-connector.md Tip) —
// unlike the builtin toolset's always_allow.
const DEFAULT_MCP_ACCESS: McpToolAccess = { enabled: true, permission: "ask" };

export type McpToolCallOutcomeLabel =
  | "ok"
  | "error"
  | "denied"
  | "timeout"
  | "aborted";

export type McpEmitter = (
  event: RuntimeMcpToolUseEvent | RuntimeMcpToolResultEvent,
) => void;

/**
 * The model-visible Pi name. A convention, not a guarantee — collisions
 * (with custom tools, or `a`+`b__c` vs `a__b`+`c`) are rejected at session
 * build (runner collision assert), never silently shadowed.
 */
export function mcpPiToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

export interface McpToolDefinitionOptions {
  workspaceId: WorkspaceId;
  sessionId: string;
  connection: McpConnection;
  permissionBridge: PiToolPermissionBridge;
  getEmitter: () => McpEmitter | undefined;
  access?: McpToolAccessResolver;
  agentContext?: { agentId?: string };
  outputCapBytes?: number;
  onToolCall?: (outcome: McpToolCallOutcomeLabel) => void;
  /** Transport-level callTool rejection: connection-class failure (§4.6). */
  onTransportFailure?: (mcpServerName: string, error: Error) => void;
}

/**
 * Build Pi ToolDefinitions for one connected server's discovered tools,
 * filtered by the mcp_toolset config. Registration-disabled tools are absent
 * from Pi's surface entirely.
 */
export function createMcpToolDefinitions(
  opts: McpToolDefinitionOptions,
): ReturnType<typeof defineTool>[] {
  const capBytes = opts.outputCapBytes ?? DEFAULT_MCP_OUTPUT_CAP_BYTES;
  const out: ReturnType<typeof defineTool>[] = [];
  for (const tool of opts.connection.tools) {
    const access =
      opts.access?.(
        opts.workspaceId,
        opts.sessionId,
        opts.connection.serverName,
        tool.name,
        opts.agentContext,
      ) ?? DEFAULT_MCP_ACCESS;
    if (!access.enabled) continue;
    const piName = mcpPiToolName(opts.connection.serverName, tool.name);
    out.push({
      ...defineTool({
        name: piName,
        label: piName,
        description: tool.description ?? tool.name,
        // Arbitrary third-party JSON Schema; Pi validates with TypeBox.
        // Servers re-validate in-band anyway (probe 46), so a permissive
        // fallback at execute time keeps a hostile schema from wedging the
        // call — see executeMcpTool.
        parameters: tool.inputSchema as never,
        execute: async (piToolCallId, params, signal) =>
          executeMcpTool({
            opts,
            bareName: tool.name,
            permission: access.permission,
            piToolCallId,
            params,
            signal,
            capBytes,
          }),
      }),
      executionMode: "parallel",
    });
  }
  return out;
}

async function executeMcpTool(args: {
  opts: McpToolDefinitionOptions;
  bareName: string;
  permission: BuiltinToolPermission;
  piToolCallId: string;
  params: unknown;
  signal: AbortSignal | undefined;
  capBytes: number;
}): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, never> }> {
  const { opts, bareName, permission, piToolCallId, signal, capBytes } = args;
  const input = isRecord(args.params) ? args.params : {};

  // 1+2: emit oma.mcp_tool_use; the sevt_* id binds before execution and the
  // ask-path registers in the shared pending-confirmation store.
  const materialized = await opts.permissionBridge.publishMcpToolUse({
    workspaceId: opts.workspaceId,
    sessionId: opts.sessionId,
    mcpServerName: opts.connection.serverName,
    toolName: bareName,
    piToolCallId,
    input,
    permission,
    signal,
    getEmitter: opts.getEmitter,
  });

  // Terminal-result rule caveat: if the handle was already evicted (runtime
  // loss mid-flight), getEmitter() is undefined and the result cannot be
  // persisted — same recovery contract as builtin tools (the lost-runtime
  // terminalization path synthesizes agent.mcp_tool_result later).
  const emitResult = (content: ManagedAgentsContentBlock[], isError: boolean) => {
    opts.getEmitter()?.({
      type: "oma.mcp_tool_result",
      mcpToolUseId: materialized.toolUseId,
      content,
      isError,
    });
  };
  const failWith = (
    message: string,
    outcome: McpToolCallOutcomeLabel,
  ): never => {
    emitResult([{ type: "text", text: message }], true);
    opts.onToolCall?.(outcome);
    throw new Error(message);
  };

  // 3: permission gate.
  if (permission === "deny") {
    failWith(`MCP tool ${bareName} is denied by policy`, "denied");
  }
  if (permission === "ask") {
    if (!materialized.confirmation) {
      failWith(`MCP tool ${bareName} confirmation was not registered`, "error");
    }
    let confirmation;
    try {
      confirmation = await materialized.confirmation;
    } catch (error) {
      const timedOut =
        (error as { omaConfirmationTimeout?: boolean }).omaConfirmationTimeout ===
        true;
      failWith(toError(error).message, timedOut ? "timeout" : "error");
      throw error; // unreachable; failWith throws
    }
    if (confirmation!.result === "deny") {
      failWith(
        confirmation!.denyMessage ?? `MCP tool ${bareName} was denied`,
        "denied",
      );
    }
  }

  // 4: the call. In-band failures resolve with isError (probe 46); a
  // rejection here is transport-class and also marks the connection failed —
  // UNLESS the Pi signal aborted (user interrupt): that is not a server
  // failure and must not tear down the warm handle or hit the retry budget
  // (review 0122-M1, Opus finding 2).
  let outcome;
  try {
    outcome = await opts.connection.callTool(bareName, input, signal);
  } catch (error) {
    const err = toError(error);
    const aborted = signal?.aborted === true || err.name === "AbortError";
    if (!aborted) {
      opts.onTransportFailure?.(opts.connection.serverName, err);
    }
    const timedOut = (error as { code?: unknown }).code === -32001; // McpError RequestTimeout
    failWith(
      `MCP tool ${bareName} failed: ${err.message}`,
      aborted ? "aborted" : timedOut ? "timeout" : "error",
    );
    throw err; // unreachable
  }

  // 5: terminal result — capped over ALL normalized blocks (review C).
  const blocks = capContent(normalizeMcpContent(outcome.content), capBytes);
  emitResult(blocks, outcome.isError);
  if (outcome.isError) {
    opts.onToolCall?.("error");
    throw new Error(
      textOf(blocks) || `MCP tool ${bareName} returned an error`,
    );
  }
  opts.onToolCall?.("ok");
  // 6: model-facing return — same text-block contract as custom tools.
  return {
    content: blocks.map((block) =>
      block.type === "text" && typeof block.text === "string"
        ? { type: "text" as const, text: block.text }
        : { type: "text" as const, text: JSON.stringify(block) },
    ),
    details: {},
  };
}

/** text blocks pass through; anything else is JSON-stringified text. */
export function normalizeMcpContent(
  content: readonly unknown[],
): ManagedAgentsContentBlock[] {
  return content.map((block) => {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      return { type: "text", text: block.text };
    }
    return { type: "text", text: JSON.stringify(block) };
  });
}

/**
 * Byte cap applied after normalization, over every block (text and
 * stringified non-text alike), before persistence AND the model-visible
 * return. Truncation is explicit, never silent.
 */
export function capContent(
  blocks: ManagedAgentsContentBlock[],
  capBytes: number,
): ManagedAgentsContentBlock[] {
  let total = 0;
  for (const block of blocks) {
    total += Buffer.byteLength(
      block.type === "text" && typeof block.text === "string"
        ? block.text
        : JSON.stringify(block),
      "utf8",
    );
  }
  if (total <= capBytes) return blocks;

  const out: ManagedAgentsContentBlock[] = [];
  let budget = capBytes;
  for (const block of blocks) {
    if (budget <= 0) break;
    const text =
      block.type === "text" && typeof block.text === "string"
        ? block.text
        : JSON.stringify(block);
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength <= budget) {
      out.push({ type: "text", text });
      budget -= bytes.byteLength;
      continue;
    }
    out.push({ type: "text", text: bytes.subarray(0, budget).toString("utf8") });
    budget = 0;
  }
  out.push({ type: "text", text: `[truncated by oma: ${total} bytes total]` });
  return out;
}

function textOf(blocks: ManagedAgentsContentBlock[]): string {
  return blocks
    .map((block) =>
      block.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .join("\n")
    .trim();
}

/**
 * Store-backed access resolver from the agent's mcp_toolset config
 * (mirrors createStoreBackedBuiltinToolAccessResolver). `configs[].name`
 * matching is by bare tool name, case-sensitive; a config entry naming a
 * tool the server doesn't expose is silently ignored by construction (it
 * simply never matches a discovered tool).
 */
export function createStoreBackedMcpToolAccessResolver(opts: {
  sessions: Pick<SessionStore, "retrieveAny">;
  agents: Pick<AgentStore, "retrieveAny">;
}): McpToolAccessResolver {
  return (workspaceId, sessionId, mcpServerName, toolName, context) => {
    const session = opts.sessions.retrieveAny(workspaceId, sessionId);
    const agentId = session?.agent.id ?? context?.agentId;
    if (!agentId) return { enabled: false, permission: "deny" };
    const agent = opts.agents.retrieveAny(workspaceId, agentId);
    if (!agent) return { enabled: false, permission: "deny" };
    const toolset = agent.tools.find(
      (tool): tool is ManagedAgentsMcpToolset =>
        tool.type === "mcp_toolset" && tool.mcp_server_name === mcpServerName,
    );
    if (!toolset) return { enabled: false, permission: "deny" };
    const config = toolset.configs?.find((item) => item.name === toolName);
    return {
      enabled: config?.enabled ?? toolset.default_config?.enabled ?? true,
      permission: mcpPolicyToPermission(
        config?.permission_policy?.type ??
          toolset.default_config?.permission_policy?.type ??
          "always_ask",
      ),
    };
  };
}

function mcpPolicyToPermission(policy: string): BuiltinToolPermission {
  if (policy === "always_allow") return "allow";
  if (policy === "always_ask") return "ask";
  if (policy === "never_allow") return "deny";
  return "deny";
}

/** Resolve the agent's declared MCP servers for a session. */
export type McpServersProvider = (
  workspaceId: WorkspaceId,
  sessionId: string,
  context?: { agentId?: string },
) => readonly { name: string; url: string }[];

export interface McpResolvedCredential {
  authorization: string;
  fingerprint: string;
}

export type McpCredentialResolver = (
  workspaceId: WorkspaceId,
  sessionId: string,
  serverUrl: string,
) => McpResolvedCredential | undefined;

export function createStoreBackedMcpServersProvider(opts: {
  sessions: Pick<SessionStore, "retrieveAny">;
  agents: Pick<AgentStore, "retrieveAny">;
}): McpServersProvider {
  return (workspaceId, sessionId, context) => {
    const session = opts.sessions.retrieveAny(workspaceId, sessionId);
    const agentId = session?.agent.id ?? context?.agentId;
    if (!agentId) return [];
    const agent = opts.agents.retrieveAny(workspaceId, agentId);
    if (!agent) return [];
    // Only servers referenced by an mcp_toolset are connectable; validation
    // guarantees the cross-reference for new agents, and pre-0122 rows with
    // dangling entries degrade to "declared but toolset-less" = skipped.
    const referenced = new Set(
      agent.tools
        .filter((tool): tool is ManagedAgentsTool & { type: "mcp_toolset" } =>
          tool.type === "mcp_toolset",
        )
        .map((tool) => tool.mcp_server_name),
    );
    return agent.mcp_servers
      .filter((server) => referenced.has(server.name))
      .map((server) => ({ name: server.name, url: server.url }));
  };
}

export function createStoreBackedMcpCredentialResolver(opts: {
  sessions: Pick<SessionStore, "retrieveAny">;
  vaults: Pick<VaultService, "resolveCredential">;
}): McpCredentialResolver {
  return (workspaceId, sessionId, serverUrl) => {
    const session = opts.sessions.retrieveAny(workspaceId, sessionId);
    const vaultIds = session?.vault_ids ?? [];
    if (vaultIds.length === 0) return undefined;
    const resolved = opts.vaults.resolveCredential(
      workspaceId,
      vaultIds,
      serverUrl,
    );
    if (!resolved) return undefined;
    return {
      authorization: `Bearer ${resolved.token}`,
      fingerprint: `${resolved.credentialId}:${resolved.updatedAt}`,
    };
  };
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
