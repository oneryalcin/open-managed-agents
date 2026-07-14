import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ManagedAgentsCustomTool } from "../../../types/agents.ts";
import type {
  ManagedAgentsContentBlock,
  ManagedAgentsUserCustomToolResultEventInput,
} from "../../../types/events.ts";
import type { JsonObject } from "../../../types/json.ts";
import type {
  RuntimeActionCloseReason,
  RuntimeCustomToolResult,
  RuntimeCustomToolUseEvent,
} from "../../events/types.ts";
import type { WorkspaceId } from "../../workspace.ts";

const DEFAULT_CUSTOM_TOOL_TIMEOUT_MS = 5 * 60 * 1000;

export type PiCustomToolsProvider = (
  workspaceId: WorkspaceId,
  sessionId: string,
  context?: { agentId?: string; agentVersion?: number },
) => readonly ManagedAgentsCustomTool[];

interface PendingCustomToolCall {
  workspaceId: WorkspaceId;
  sessionId: string;
  resolve: (result: RuntimeCustomToolResult) => void;
  reject: (error: Error) => void;
  cleanup: (reason?: RuntimeActionCloseReason) => void;
}

export class PiCustomToolBridge {
  private readonly pending = new Map<string, PendingCustomToolCall>();
  private readonly timeoutMs: number;

  constructor(
    private readonly opts: {
      customTools?: PiCustomToolsProvider;
      timeoutMs?: number;
    } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CUSTOM_TOOL_TIMEOUT_MS;
  }

  customToolNames(
    workspaceId: WorkspaceId,
    sessionId: string,
    context?: { agentId?: string; agentVersion?: number },
  ): Set<string> {
    return new Set(
      (this.opts.customTools?.(workspaceId, sessionId, context) ?? []).map(
        (tool) => tool.name,
      ),
    );
  }

  createTools(
    workspaceId: WorkspaceId,
    sessionId: string,
    getEmitter: () => ((event: RuntimeCustomToolUseEvent) => void) | undefined,
    context?: { agentId?: string; agentVersion?: number },
  ): ReturnType<typeof defineTool>[] {
    return (this.opts.customTools?.(workspaceId, sessionId, context) ?? []).map(
      (tool) =>
        defineTool({
          name: tool.name,
          label: tool.name,
          description: tool.description ?? tool.name,
          parameters: tool.input_schema as never,
          execute: async (piToolCallId, params, signal) =>
            this.awaitResult(
              workspaceId,
              sessionId,
              tool.name,
              piToolCallId,
              params,
              signal,
              getEmitter,
            ),
        }),
    );
  }

  claimResult(
    workspaceId: WorkspaceId,
    sessionId: string,
    event: ManagedAgentsUserCustomToolResultEventInput,
  ): (() => void) | undefined {
    const pending = this.pending.get(event.custom_tool_use_id);
    if (!pending) return undefined;
    if (pending.workspaceId !== workspaceId || pending.sessionId !== sessionId) {
      return undefined;
    }
    return () => {
      this.pending.delete(event.custom_tool_use_id);
      pending.cleanup();
      pending.resolve({
        content: event.content,
        is_error: event.is_error,
      });
    };
  }

  rejectSession(sessionId: string, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(error);
    }
  }

  private async awaitResult(
    workspaceId: WorkspaceId,
    sessionId: string,
    name: string,
    piToolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    getEmitter: () => ((event: RuntimeCustomToolUseEvent) => void) | undefined,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, never>;
    isError?: boolean;
  }> {
    const emit = getEmitter();
    if (!emit) {
      throw new Error(`No active runtime consumer for custom tool ${name}`);
    }

    let customToolUseId: string | undefined;
    const result = await new Promise<RuntimeCustomToolResult>((resolve, reject) => {
      let released = false;
      let releaseCustomToolUseId:
        | ((reason?: RuntimeActionCloseReason) => void)
        | undefined;
      const cleanup = (reason?: RuntimeActionCloseReason) => {
        if (released) return;
        released = true;
        signal?.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
        releaseCustomToolUseId?.(reason);
      };
      const onAbort = () => {
        if (customToolUseId) this.pending.delete(customToolUseId);
        cleanup("interrupted");
        reject(new Error(`Custom tool ${name} aborted`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer =
        this.timeoutMs > 0
          ? setTimeout(() => {
              if (customToolUseId) this.pending.delete(customToolUseId);
              cleanup("timeout");
              reject(new Error(`Custom tool ${name} timed out`));
            }, this.timeoutMs)
          : undefined;

      try {
        emit({
          type: "oma.custom_tool_use",
          piToolCallId,
          name,
          input: isRecord(params) ? params : {},
          bindCustomToolUseId: (id, release) => {
            customToolUseId = id;
            releaseCustomToolUseId = release;
            this.pending.set(id, {
              workspaceId,
              sessionId,
              resolve,
              reject,
              cleanup,
            });
          },
          rejectCustomToolUse: (error) => {
            if (customToolUseId) this.pending.delete(customToolUseId);
            cleanup();
            reject(error);
          },
        });
      } catch (error) {
        if (customToolUseId) this.pending.delete(customToolUseId);
        cleanup();
        reject(toError(error));
      }
    });

    if (result.is_error === true) {
      throw new Error(toolErrorMessage(name, result.content));
    }

    return {
      content: toPiToolContent(result.content),
      details: {},
    };
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPiToolContent(
  content: ManagedAgentsContentBlock[] | undefined,
): Array<{ type: "text"; text: string }> {
  if (!content || content.length === 0) return [];
  return content.map((block) => {
    if (
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      return { type: "text", text: block.text };
    }
    return { type: "text", text: JSON.stringify(block) };
  });
}

function toolErrorMessage(
  name: string,
  content: ManagedAgentsContentBlock[] | undefined,
): string {
  const text = toPiToolContent(content)
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : `Custom tool ${name} returned an error`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
