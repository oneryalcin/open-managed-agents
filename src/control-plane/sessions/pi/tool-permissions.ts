import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  ManagedAgentsUserToolConfirmationEventInput,
} from "../../../types/events.ts";
import type { JsonObject } from "../../../types/json.ts";
import type { AgentStore } from "../../agents/types.ts";
import type { RuntimeToolPermissionUseEvent } from "../../events/types.ts";
import type { SessionStore } from "../types.ts";
import type { WorkspaceId } from "../../workspace.ts";
import type { SandboxedBuiltinToolName } from "./sandbox/provider.ts";

export type BuiltinToolPermission = "allow" | "ask" | "deny";

export interface BuiltinToolAccess {
  enabled: boolean;
  permission: BuiltinToolPermission;
}

export type BuiltinToolAccessResolver = (
  workspaceId: WorkspaceId,
  sessionId: string,
  toolName: SandboxedBuiltinToolName,
  opts?: { agentId?: string },
) => BuiltinToolAccess;

interface PendingToolConfirmation {
  workspaceId: WorkspaceId;
  sessionId: string;
  piToolCallId: string;
  resolve: (result: ToolConfirmationResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

interface ToolConfirmationResult {
  result: "allow" | "deny";
  denyMessage?: string | null;
}

interface RegisteredConfirmation {
  promise: Promise<ToolConfirmationResult>;
  reject: (error: Error) => void;
}

const DEFAULT_ACCESS: BuiltinToolAccess = {
  enabled: true,
  permission: "allow",
};
const DEFAULT_TOOL_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

export class PiToolPermissionBridge {
  private readonly pending = new Map<string, PendingToolConfirmation>();
  private readonly publicToolUseIdsBySession = new Map<string, Map<string, string>>();
  private readonly suppressedPiToolUseIdsBySession = new Map<string, Set<string>>();
  private readonly permissionDeniedPiToolCallIdsBySession = new Map<
    string,
    Set<string>
  >();

  constructor(
    private readonly opts: {
      access?: BuiltinToolAccessResolver;
      timeoutMs?: number;
    } = {},
  ) {}

  access(
    workspaceId: WorkspaceId,
    sessionId: string,
    toolName: SandboxedBuiltinToolName,
  ): BuiltinToolAccess {
    return this.opts.access?.(workspaceId, sessionId, toolName) ?? DEFAULT_ACCESS;
  }

  wrapTool(
    workspaceId: WorkspaceId,
    sessionId: string,
    toolName: SandboxedBuiltinToolName,
    tool: ToolDefinition<any, any, any>,
    getEmitter: () => ((event: RuntimeToolPermissionUseEvent) => void) | undefined,
  ): ToolDefinition<any, any, any> {
    return {
      ...tool,
      execute: async (piToolCallId, params, signal, onUpdate, ctx) => {
        const access = this.access(workspaceId, sessionId, toolName);
        if (!access.enabled) {
          this.markPermissionDenied(sessionId, piToolCallId);
          throw new Error(`Builtin tool ${toolName} is disabled`);
        }
        const input = isRecord(params) ? params : {};
        const materialized = await this.publishToolUse({
          workspaceId,
          sessionId,
          toolName,
          piToolCallId,
          input,
          permission: access.permission,
          signal,
          getEmitter,
        });
        if (access.permission === "deny") {
          this.markPermissionDenied(sessionId, piToolCallId);
          throw new Error(`Builtin tool ${toolName} is denied by policy`);
        }
        if (access.permission === "ask") {
          if (!materialized.confirmation) {
            throw new Error(`Builtin tool ${toolName} confirmation was not registered`);
          }
          const confirmation = await materialized.confirmation;
          if (confirmation.result === "deny") {
            this.markPermissionDenied(sessionId, piToolCallId);
            throw new Error(
              confirmation.denyMessage ?? `Builtin tool ${toolName} was denied`,
            );
          }
        }
        return tool.execute(piToolCallId, params, signal, onUpdate, ctx);
      },
    };
  }

  claimConfirmation(
    workspaceId: WorkspaceId,
    sessionId: string,
    event: ManagedAgentsUserToolConfirmationEventInput,
  ): (() => void) | undefined {
    const pending = this.pending.get(event.tool_use_id);
    if (!pending) return undefined;
    if (pending.workspaceId !== workspaceId || pending.sessionId !== sessionId) {
      return undefined;
    }
    return () => {
      this.pending.delete(event.tool_use_id);
      pending.cleanup();
      pending.resolve({
        result: event.result,
        denyMessage: event.deny_message,
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
    this.publicToolUseIdsBySession.delete(sessionId);
    this.suppressedPiToolUseIdsBySession.delete(sessionId);
    this.permissionDeniedPiToolCallIdsBySession.delete(sessionId);
  }

  publicToolUseIdForPiToolCallId(
    sessionId: string,
    piToolCallId: string,
  ): string | undefined {
    return this.publicToolUseIdsBySession.get(sessionId)?.get(piToolCallId);
  }

  suppressPiToolUse(sessionId: string, piToolCallId: string): boolean {
    return (
      this.suppressedPiToolUseIdsBySession.get(sessionId)?.has(piToolCallId) ===
      true
    );
  }

  permissionDenied(sessionId: string, piToolCallId: string): boolean {
    return (
      this.permissionDeniedPiToolCallIdsBySession
        .get(sessionId)
        ?.has(piToolCallId) === true
    );
  }

  private async publishToolUse(opts: {
    workspaceId: WorkspaceId;
    sessionId: string;
    toolName: SandboxedBuiltinToolName;
    piToolCallId: string;
    input: JsonObject;
    permission: BuiltinToolPermission;
    signal: AbortSignal | undefined;
    getEmitter: () => ((event: RuntimeToolPermissionUseEvent) => void) | undefined;
  }): Promise<{ toolUseId: string; confirmation?: Promise<ToolConfirmationResult> }> {
    const emit = opts.getEmitter();
    if (!emit) {
      throw new Error(`No active runtime consumer for builtin tool ${opts.toolName}`);
    }

    return new Promise<{
      toolUseId: string;
      confirmation?: Promise<ToolConfirmationResult>;
    }>((resolve, reject) => {
      let released = false;
      let toolUseId: string | undefined;
      let releaseToolUseId: (() => void) | undefined;
      let confirmation: RegisteredConfirmation | undefined;
      const cleanup = () => {
        if (released) return;
        released = true;
        opts.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error(`Builtin tool ${opts.toolName} aborted`));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        emit({
          type: "oma.tool_permission_use",
          piToolCallId: opts.piToolCallId,
          name: opts.toolName,
          input: opts.input,
          evaluatedPermission: opts.permission,
          bindToolUseId: (boundToolUseId, release) => {
            toolUseId = boundToolUseId;
            releaseToolUseId = release;
            this.bindPublicToolUseId(
              opts.sessionId,
              opts.piToolCallId,
              boundToolUseId,
            );
            cleanup();
            confirmation =
              opts.permission === "ask"
                ? this.registerPendingConfirmation({
                    ...opts,
                    toolUseId: boundToolUseId,
                    releaseToolUseId: release,
                  })
                : undefined;
            resolve({
              toolUseId: boundToolUseId,
              confirmation: confirmation?.promise,
            });
          },
          rejectToolUse: (error) => {
            if (toolUseId) {
              this.forgetPublicToolUseId(opts.sessionId, opts.piToolCallId);
              this.pending.delete(toolUseId);
            }
            if (confirmation) {
              confirmation.reject(error);
            } else {
              releaseToolUseId?.();
            }
            cleanup();
            reject(error);
          },
        });
      } catch (error) {
        cleanup();
        reject(toError(error));
      }
    },
    );
  }

  private registerPendingConfirmation(opts: {
    workspaceId: WorkspaceId;
    sessionId: string;
    toolName: SandboxedBuiltinToolName;
    piToolCallId: string;
    toolUseId: string;
    signal: AbortSignal | undefined;
    releaseToolUseId: () => void;
  }): RegisteredConfirmation {
    let rejectPending!: (error: Error) => void;
    const promise = new Promise<ToolConfirmationResult>((resolve, reject) => {
      let released = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (released) return;
        released = true;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        opts.releaseToolUseId();
      };
      const onAbort = () => {
        this.pending.delete(opts.toolUseId);
        cleanup();
        reject(new Error(`Builtin tool ${opts.toolName} aborted`));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const timeoutMs =
        this.opts.timeoutMs ?? DEFAULT_TOOL_CONFIRMATION_TIMEOUT_MS;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(opts.toolUseId);
          this.markPermissionDenied(opts.sessionId, opts.piToolCallId);
          cleanup();
          reject(new Error(`Builtin tool ${opts.toolName} confirmation timed out`));
        }, timeoutMs);
      }
      rejectPending = (error) => {
        this.pending.delete(opts.toolUseId);
        cleanup();
        reject(error);
      };
      this.pending.set(opts.toolUseId, {
        workspaceId: opts.workspaceId,
        sessionId: opts.sessionId,
        piToolCallId: opts.piToolCallId,
        resolve,
        reject,
        cleanup,
      });
    });
    return {
      promise,
      reject: rejectPending,
    };
  }

  private bindPublicToolUseId(
    sessionId: string,
    piToolCallId: string,
    publicToolUseId: string,
  ): void {
    let ids = this.publicToolUseIdsBySession.get(sessionId);
    if (!ids) {
      ids = new Map<string, string>();
      this.publicToolUseIdsBySession.set(sessionId, ids);
    }
    ids.set(piToolCallId, publicToolUseId);

    let suppressed = this.suppressedPiToolUseIdsBySession.get(sessionId);
    if (!suppressed) {
      suppressed = new Set<string>();
      this.suppressedPiToolUseIdsBySession.set(sessionId, suppressed);
    }
    suppressed.add(piToolCallId);
  }

  private forgetPublicToolUseId(sessionId: string, piToolCallId: string): void {
    const ids = this.publicToolUseIdsBySession.get(sessionId);
    ids?.delete(piToolCallId);
    if (ids?.size === 0) this.publicToolUseIdsBySession.delete(sessionId);

    const suppressed = this.suppressedPiToolUseIdsBySession.get(sessionId);
    suppressed?.delete(piToolCallId);
    if (suppressed?.size === 0) {
      this.suppressedPiToolUseIdsBySession.delete(sessionId);
    }
  }

  private markPermissionDenied(sessionId: string, piToolCallId: string): void {
    let denied = this.permissionDeniedPiToolCallIdsBySession.get(sessionId);
    if (!denied) {
      denied = new Set<string>();
      this.permissionDeniedPiToolCallIdsBySession.set(sessionId, denied);
    }
    denied.add(piToolCallId);
  }
}

export function createStoreBackedBuiltinToolAccessResolver(opts: {
  sessions: Pick<SessionStore, "retrieveAny">;
  agents: Pick<AgentStore, "retrieveAny">;
}): BuiltinToolAccessResolver {
  return (workspaceId, sessionId, toolName, context) => {
    const session = opts.sessions.retrieveAny(workspaceId, sessionId);
    const agentId = session?.agent.id ?? context?.agentId;
    if (!agentId) return { enabled: false, permission: "deny" };
    const agent = opts.agents.retrieveAny(workspaceId, agentId);
    if (!agent) return { enabled: false, permission: "deny" };
    const toolsets = agent.tools.filter(
      (tool) => tool.type === "agent_toolset_20260401",
    );
    if (toolsets.length !== 1) {
      return { enabled: false, permission: "deny" };
    }
    const [toolset] = toolsets;
    const defaultConfig = toolset.default_config;
    const config = toolset.configs?.find((item) => item.name === toolName);
    return {
      enabled: config?.enabled ?? defaultConfig?.enabled ?? true,
      permission: policyToPermission(
        config?.permission_policy?.type ??
          defaultConfig?.permission_policy?.type ??
          "always_allow",
      ),
    };
  };
}

function policyToPermission(policy: string): BuiltinToolPermission {
  if (policy === "always_allow") return "allow";
  if (policy === "always_ask") return "ask";
  if (policy === "never_allow") return "deny";
  return "deny";
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
