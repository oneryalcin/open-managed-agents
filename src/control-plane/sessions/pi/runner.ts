import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  RuntimeEventRunner,
  RuntimeInternalEvent,
  RuntimeMcpConnectionFailedEvent,
  RuntimeMcpToolWithModelEndEvent,
  RuntimeSessionFileMount,
  RuntimeSessionOutputCollection,
  RuntimeSessionPrepareOptions,
  RuntimeToolPermissionWithModelEndEvent,
} from "../../events/types.ts";
import { RuntimeUnsupportedSessionFileResourcesError } from "../../events/types.ts";
import type {
  ManagedAgentsUserCustomToolResultEventInput,
  ManagedAgentsUserToolConfirmationEventInput,
} from "../../../types/events.ts";
import type { WorkspaceId } from "../../workspace.ts";
import {
  PiCustomToolBridge,
  type PiCustomToolsProvider,
} from "./custom-tools.ts";
import {
  PiToolPermissionBridge,
  type BuiltinToolAccessResolver,
} from "./tool-permissions.ts";
import { McpConnection } from "./mcp/client.ts";
import { createGuardedMcpFetch, type McpFetch } from "./mcp/fetch.ts";
import {
  createMcpToolDefinitions,
  type McpServersProvider,
  type McpToolAccessResolver,
  type McpToolCallOutcomeLabel,
} from "./mcp/bridge.ts";
import type {
  SandboxedBuiltinToolName,
  SandboxProvider,
  SandboxProviderFactory,
  SandboxProviderSessionContext,
} from "./sandbox/provider.ts";
import {
  resolveSandboxProviderFactory,
  type SandboxProviderSelection,
  type SandboxProviderSelectionResolverOptions,
} from "./sandbox/selection.ts";

const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000;
const ALREADY_PROCESSING_MESSAGE = "Agent is already processing";

export interface PiRuntimeSession {
  prompt(
    text: string,
    opts?: { streamingBehavior?: "steer" | "followUp" },
  ): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  clearQueue?(): { steering: string[]; followUp: string[] };
  dispose(): void;
  subscribe(listener: (event: unknown) => void): () => void;
  getActiveToolNames(): string[];
}

export type PiRuntimeSessionFactory = (
  workspaceId: WorkspaceId,
  sessionId: string,
) => Promise<PiRuntimeSession>;

export type PiSessionFileMount = RuntimeSessionFileMount;
export type PiSessionFileMountResolver = (
  workspaceId: WorkspaceId,
  sessionId: string,
) => Promise<readonly PiSessionFileMount[]> | readonly PiSessionFileMount[];

interface RuntimeHandle {
  session: PiRuntimeSession;
  sandbox: SandboxProvider | undefined;
  running: boolean;
  needsFreshPromptAfterInterrupt: boolean;
  closeWhenIdle: boolean;
  lastUsedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Custom tools ∪ MCP pi-names — drives translator suppression + asserts. */
  customToolNames: Set<string>;
  /** MCP pi-names only, for the MCP-aware message-end coalescing matcher. */
  mcpToolNames: Set<string>;
  mcpConnections: readonly McpConnection[];
  /** Connect failures queued at build time; flushed at turn start (§4.2). */
  pendingMcpFailures: RuntimeMcpConnectionFailedEvent[];
  /** Servers whose mid-call failure event already went out on this handle. */
  mcpFailureEmittedServers: Set<string>;
  emitInternal: ((event: RuntimeInternalEvent) => void) | undefined;
}

export interface PiMcpOptions {
  /** Deployment gate (plan 0122 §4.6): dialing is opt-in, default off. */
  enabled: boolean;
  servers?: McpServersProvider;
  access?: McpToolAccessResolver;
  /** Test seam (SSRF allowAddress) — production uses the guarded default. */
  fetch?: McpFetch;
  operationTimeoutMs?: number;
  outputCapBytes?: number;
  /** Consecutive connect failures before exhausted (OMA policy, default 5). */
  maxConsecutiveFailures?: number;
  onToolCall?: (outcome: McpToolCallOutcomeLabel) => void;
  onConnection?: (event: "connected" | "connect_failed") => void;
}

const DEFAULT_MCP_MAX_CONSECUTIVE_FAILURES = 5;

export class PiSessionRunner implements RuntimeEventRunner {
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private readonly sessions = new Map<string, RuntimeHandle>();
  private readonly pendingSessions = new Map<string, Promise<RuntimeHandle>>();
  private readonly pendingInterrupts = new Map<string, Promise<void>>();
  private readonly closedSessionIds = new Set<string>();
  private readonly customToolBridge: PiCustomToolBridge;
  private readonly toolPermissionBridge: PiToolPermissionBridge;
  private readonly preparingSessionAgents = new Map<
    string,
    { workspaceId: WorkspaceId; agentId: string }
  >();
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private readonly sessionFactory: PiRuntimeSessionFactory | undefined;
  private readonly mcpFetch: McpFetch;
  /**
   * Consecutive connect failures per (session, server). Runner-level so the
   * count SURVIVES handle recreation — fresh-handle retry is the mechanism
   * (plan 0122 §4.6). Cleared on closeSession.
   */
  private readonly mcpFailureCounts = new Map<string, Map<string, number>>();
  private closed = false;

  constructor(
    private readonly opts: {
      provider?: string;
      model?: string;
      thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
      idleTtlMs?: number;
      now?: () => number;
      sessionFactory?: PiRuntimeSessionFactory;
      sandboxProviderFactory?: SandboxProviderFactory;
      sandboxProviderSelection?: SandboxProviderSelection;
      sandboxProviderSelectionOptions?: SandboxProviderSelectionResolverOptions;
      fileMountResolver?: PiSessionFileMountResolver;
      customTools?: PiCustomToolsProvider;
      customToolTimeoutMs?: number;
      toolConfirmationTimeoutMs?: number;
      builtinToolAccess?: BuiltinToolAccessResolver;
      /** 0121 C2 telemetry: sandbox lifecycle events. Must not throw. */
      onSandboxEvent?: (event: "created" | "disposed" | "error") => void;
      /** MCP connector (plan 0122 M1). Absent = fully inert. */
      mcp?: PiMcpOptions;
    } = {},
  ) {
    this.resolveSandboxProviderFactory();
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.sessionFactory = opts.sessionFactory;
    this.mcpFetch = opts.mcp?.fetch ?? createGuardedMcpFetch();
    this.customToolBridge = new PiCustomToolBridge({
      customTools: opts.customTools,
      timeoutMs: opts.customToolTimeoutMs,
    });
    this.toolPermissionBridge = new PiToolPermissionBridge({
      access: (workspaceId, sessionId, toolName) =>
        opts.builtinToolAccess?.(workspaceId, sessionId, toolName, {
          agentId:
            this.preparingSessionAgents.get(sessionId)?.workspaceId === workspaceId
              ? this.preparingSessionAgents.get(sessionId)?.agentId
              : undefined,
        }) ?? { enabled: true, permission: "allow" },
      timeoutMs: opts.toolConfirmationTimeoutMs,
    });
  }

  runUserMessage(
    workspaceId: WorkspaceId,
    sessionId: string,
    text: string,
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<unknown> {
    return this.runOnSession(workspaceId, sessionId, text, opts.signal);
  }

  async prepareSession(
    workspaceId: WorkspaceId,
    sessionId: string,
    opts: RuntimeSessionPrepareOptions = {},
  ): Promise<void> {
    if (opts.agent) {
      this.preparingSessionAgents.set(sessionId, {
        workspaceId,
        agentId: opts.agent.id,
      });
    }
    try {
      const sandboxContext =
        opts.environmentId === undefined
          ? undefined
          : { environmentId: opts.environmentId };
      const handle = await this.getOrCreateHandle(
        workspaceId,
        sessionId,
        opts.fileMounts,
        sandboxContext,
      );
      this.touch(sessionId, handle);
    } finally {
      if (opts.agent) this.preparingSessionAgents.delete(sessionId);
    }
  }

  claimCustomToolResult(
    workspaceId: WorkspaceId,
    sessionId: string,
    event: ManagedAgentsUserCustomToolResultEventInput,
  ): (() => void) | undefined {
    return this.customToolBridge.claimResult(workspaceId, sessionId, event);
  }

  claimToolConfirmation(
    workspaceId: WorkspaceId,
    sessionId: string,
    event: ManagedAgentsUserToolConfirmationEventInput,
  ): (() => void) | undefined {
    return this.toolPermissionBridge.claimConfirmation(
      workspaceId,
      sessionId,
      event,
    );
  }

  async interruptSession(
    _workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void> {
    const pending = this.pendingInterrupts.get(sessionId);
    if (pending) return pending;
    const interrupt = this.interruptSessionInternal(sessionId);
    this.pendingInterrupts.set(sessionId, interrupt);
    try {
      await interrupt;
    } finally {
      if (this.pendingInterrupts.get(sessionId) === interrupt) {
        this.pendingInterrupts.delete(sessionId);
      }
    }
  }

  private async interruptSessionInternal(sessionId: string): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      await this.interruptHandle(sessionId, existing);
      return;
    }
    const pending = this.pendingSessions.get(sessionId);
    if (!pending) return;
    try {
      const handle = await pending;
      await this.interruptHandle(sessionId, handle);
    } catch {
      // Interrupting a failed/closed pending session is a no-op for callers.
    }
  }

  customToolNames(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): ReadonlySet<string> {
    const handle = this.sessions.get(sessionId);
    if (handle) return handle.customToolNames;
    return this.customToolBridge.customToolNames(
      workspaceId,
      sessionId,
      this.preparingSessionAgentContext(workspaceId, sessionId),
    );
  }

  publicToolUseIdForPiToolCallId(
    _workspaceId: WorkspaceId,
    sessionId: string,
    piToolCallId: string,
  ): string | undefined {
    return this.toolPermissionBridge.publicToolUseIdForPiToolCallId(
      sessionId,
      piToolCallId,
    );
  }

  suppressPiToolUse(
    _workspaceId: WorkspaceId,
    sessionId: string,
    piToolCallId: string,
  ): boolean {
    return this.toolPermissionBridge.suppressPiToolUse(sessionId, piToolCallId);
  }

  async collectSessionOutputs(
    _workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<RuntimeSessionOutputCollection> {
    const handle = this.sessions.get(sessionId);
    if (!handle?.sandbox) {
      return { kind: "unsupported", reason: "no_live_sandbox" };
    }
    if (typeof handle.sandbox.collectOutputFiles !== "function") {
      return { kind: "unsupported", reason: "provider_unsupported" };
    }
    return {
      kind: "collected",
      files: await handle.sandbox.collectOutputFiles(),
    };
  }

  close(): void {
    this.closed = true;
    for (const [sessionId, handle] of this.sessions) {
      if (handle.running) {
        handle.closeWhenIdle = true;
        this.scheduleEviction(sessionId, handle);
      } else {
        this.evict(sessionId, handle);
      }
    }
  }

  async closeSession(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void> {
    this.closedSessionIds.add(sessionId);
    this.mcpFailureCounts.delete(sessionId);
    try {
      const existing = this.sessions.get(sessionId);
      if (existing) {
        await this.closeHandle(sessionId, existing);
        return;
      }

      const pending = this.pendingSessions.get(sessionId);
      if (!pending) return;
      try {
        const handle = await pending;
        await this.closeHandle(sessionId, handle);
      } catch {
        // A close-requested pending session disposes itself during materialization.
      }
    } finally {
      this.closedSessionIds.delete(sessionId);
    }
  }

  private async *runOnSession(
    workspaceId: WorkspaceId,
    sessionId: string,
    text: string,
    signal: AbortSignal | undefined,
  ): AsyncIterable<unknown> {
    // Cross-request interrupt/message ordering: a message that arrives while
    // abort is settling waits and then starts a fresh post-interrupt turn.
    await this.waitForPendingInterrupt(sessionId);
    const handle = await this.getOrCreateHandle(workspaceId, sessionId);
    if (this.closed) {
      this.evict(sessionId, handle);
      throw new Error("PiSessionRunner is closed");
    }
    this.touch(sessionId, handle);

    if (handle.running && !handle.needsFreshPromptAfterInterrupt) {
      try {
        await handle.session.followUp(text);
        this.touch(sessionId, handle);
      } catch (error) {
        this.evict(sessionId, handle);
        throw error;
      }
      return;
    }
    handle.needsFreshPromptAfterInterrupt = false;

    const queue: unknown[] = [];
    const gatedEvents: unknown[] = [];
    const activeSandboxedToolCalls = new Map<
      string,
      SandboxedBuiltinToolName
    >();
    let done = false;
    let failure: unknown;
    let becameFollowUp = false;
    let wake: (() => void) | undefined;

    const stop = handle.session.subscribe((event) => {
      updateRunning(handle, event);
      queue.push(event);
      wake?.();
    });
    const previousInternal = handle.emitInternal;
    const installedInternalEmitter = previousInternal === undefined;
    if (installedInternalEmitter) {
      handle.emitInternal = (event) => {
        if (event.type === "oma.tool_permission_use") {
          const match = takeMessageEndForToolCall(
            handle.sandbox,
            [gatedEvents, queue],
            event.piToolCallId,
          );
          if (match !== undefined) {
            queue.push({
              type: "oma.tool_permission_with_model_end",
              messageEnd: match.event,
              permissionUse: event,
              suppressedPiToolCallIds: match.suppressedPiToolCallIds,
            } satisfies RuntimeToolPermissionWithModelEndEvent);
            wake?.();
            return;
          }
        }
        if (event.type === "oma.mcp_tool_use") {
          // Opportunistic coalescing, mirroring the permission path: when
          // the message_end carrying this toolCall is still queued, persist
          // it atomically with the use event; otherwise the use event stands
          // alone (both orders produce correct wire output — plan 0122 §4.4).
          const match = takeMessageEndForMcpToolCall(
            handle.mcpToolNames,
            [gatedEvents, queue],
            event.piToolCallId,
          );
          if (match !== undefined) {
            queue.push({
              type: "oma.mcp_tool_with_model_end",
              messageEnd: match.event,
              mcpToolUse: event,
              suppressedPiToolCallIds: match.suppressedPiToolCallIds,
            } satisfies RuntimeMcpToolWithModelEndEvent);
            wake?.();
            return;
          }
        }
        queue.push(event);
        wake?.();
      };
      // Connect failures queued at session build flush now — the first
      // moment an event consumer exists (plan 0122 §4.2).
      for (const failure of handle.pendingMcpFailures.splice(0)) {
        queue.push(failure);
      }
    }

    const onAbort = () => {
      void handle.session.abort();
      wake?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const run = handle.session
      .prompt(text)
      .catch(async (error) => {
        if (isAlreadyProcessing(error)) {
          await handle.session.followUp(text);
          // Best effort for the losing prompt race: once Pi confirms this turn
          // is a follow-up, discard overlap events captured by this temporary
          // subscriber. A pre-rejection event can still escape; in practice that
          // should be limited to early status frames, while the winning prompt
          // subscriber owns the full turn and follow-up output.
          becameFollowUp = true;
          queue.length = 0;
          return;
        }
        failure = error;
      })
      .finally(() => {
        done = true;
        wake?.();
      });

    try {
      while (!done || queue.length > 0) {
        if (becameFollowUp) break;
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (done || becameFollowUp || queue.length > 0) {
              wake = undefined;
              resolve();
            }
          });
          wake = undefined;
          continue;
        }
        const event = queue.shift();
        if (isInternalRuntimeEvent(event)) {
          yield event;
          continue;
        }
        const sandboxedToolCalls = sandboxedToolCallsInMessage(
          handle.sandbox,
          event,
        );
        if (sandboxedToolCalls.length > 0) {
          for (const call of sandboxedToolCalls) {
            activeSandboxedToolCalls.set(call.toolCallId, call.toolName);
          }
          gatedEvents.push(event);
          continue;
        }

        const sandboxedStart = sandboxedToolEvent(
          handle.sandbox,
          event,
          "tool_execution_start",
        );
        if (sandboxedStart) {
          activeSandboxedToolCalls.set(
            sandboxedStart.toolCallId,
            sandboxedStart.toolName,
          );
          gatedEvents.push(event);
          continue;
        }

        const sandboxedEnd = sandboxedToolEvent(
          handle.sandbox,
          event,
          "tool_execution_end",
        );
        if (activeSandboxedToolCalls.size > 0) {
          gatedEvents.push(event);
          if (sandboxedEnd) {
            assertSandboxProviderHandledToolCall({
              sandbox: handle.sandbox,
              toolPermissionBridge: this.toolPermissionBridge,
              sessionId,
              toolName: sandboxedEnd.toolName,
              toolCallId: sandboxedEnd.toolCallId,
              isError: sandboxedEnd.isError,
            });
            activeSandboxedToolCalls.delete(sandboxedEnd.toolCallId);
            if (activeSandboxedToolCalls.size === 0) {
              const releasableEvents = gatedEvents.splice(0);
              for (const releasableEvent of releasableEvents) {
                yield releasableEvent;
              }
            }
          }
          continue;
        }

        if (sandboxedEnd) {
          assertSandboxProviderHandledToolCall({
            sandbox: handle.sandbox,
            toolPermissionBridge: this.toolPermissionBridge,
            sessionId,
            toolName: sandboxedEnd.toolName,
            toolCallId: sandboxedEnd.toolCallId,
            isError: sandboxedEnd.isError,
          });
          yield event;
          continue;
        }

        yield event;
      }

      await run;
      if (failure) throw failure;
      if (activeSandboxedToolCalls.size > 0 || gatedEvents.length > 0) {
        throw new Error(
          "Sandboxed builtin tool execution ended without validation",
        );
      }
      if (handle.closeWhenIdle) {
        this.evict(sessionId, handle);
      } else {
        this.touch(sessionId, handle);
      }
    } catch (error) {
      this.evict(sessionId, handle);
      throw error;
    } finally {
      if (installedInternalEmitter) {
        handle.emitInternal = previousInternal;
      }
      stop();
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async getOrCreateHandle(
    workspaceId: WorkspaceId,
    sessionId: string,
    fileMounts?: readonly PiSessionFileMount[],
    context?: SandboxProviderSessionContext,
  ): Promise<RuntimeHandle> {
    if (this.closed) throw new Error("PiSessionRunner is closed");
    if (this.closedSessionIds.has(sessionId)) {
      throw new Error(`Runtime session ${sessionId} is closed`);
    }
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const pending = this.pendingSessions.get(sessionId);
    if (pending) return pending;

    const created = (async () => {
        const customToolContext = this.preparingSessionAgentContext(workspaceId, sessionId);
        const customToolNames = new Set(
          (this.opts.customTools?.(workspaceId, sessionId, customToolContext) ?? []).map(
            (tool) => tool.name,
          ),
        );
        const sandboxProviderFactory = this.resolveSandboxProviderFactory();
        let sandbox: SandboxProvider | undefined;
        let session: PiRuntimeSession | undefined;
        let mcp: PreparedMcp = EMPTY_MCP;
        try {
          try {
            sandbox = await sandboxProviderFactory?.(
              workspaceId,
              sessionId,
              context,
            );
          } catch (providerError) {
            this.opts.onSandboxEvent?.("error");
            throw providerError;
          }
          if (sandbox !== undefined) this.opts.onSandboxEvent?.("created");
          const mounts =
            fileMounts ??
            (await this.opts.fileMountResolver?.(workspaceId, sessionId)) ??
            [];
          if (mounts.length > 0) {
            if (typeof sandbox?.materializeFileResources !== "function") {
              throw new RuntimeUnsupportedSessionFileResourcesError();
            }
            await sandbox.materializeFileResources(mounts);
          }
          // MCP wiring is skipped entirely under a sessionFactory — the
          // factory bypasses createPiSession, so tools could never reach Pi
          // and a green test on this path would test nothing (plan 0122 §5).
          if (this.sessionFactory === undefined) {
            mcp = await this.prepareMcp(workspaceId, sessionId, customToolContext);
            for (const name of mcp.toolNames) {
              if (customToolNames.has(name)) {
                throw new Error(
                  `MCP tool name collides with a custom tool: ${name}`,
                );
              }
              customToolNames.add(name);
            }
          }
          assertNoSandboxCustomToolNameCollision(sandbox, customToolNames);
          session =
            this.sessionFactory === undefined
              ? await this.createPiSession(
                  workspaceId,
                  sessionId,
                  sandbox,
                  customToolContext,
                  mcp.toolDefinitions,
                )
              : await this.sessionFactory(workspaceId, sessionId);
          assertActiveToolSurface(
            session,
            this.enabledSandboxToolNames(workspaceId, sessionId, sandbox),
            customToolNames,
          );
        } catch (error) {
          this.disposeSandbox(sandbox);
          this.disposeMcpConnections(mcp.connections);
          session?.dispose();
          throw error;
        }
        if (!session) throw new Error("Pi session was not created");
        const handle: RuntimeHandle = {
          session,
          sandbox,
          running: false,
          needsFreshPromptAfterInterrupt: false,
          // Retrying MCP failures use fresh-handle mechanics: dispose at
          // idle so the NEXT turn re-runs connect/discovery (plan 0122 §4.6).
          closeWhenIdle: mcp.pendingFailures.some(
            (failure) => failure.retryStatus === "retrying",
          ),
          lastUsedAt: this.now(),
          timer: undefined,
          customToolNames,
          mcpToolNames: mcp.toolNames,
          mcpConnections: mcp.connections,
          pendingMcpFailures: [...mcp.pendingFailures],
          mcpFailureEmittedServers: new Set(),
          emitInternal: undefined,
        };
        if (this.closed || this.closedSessionIds.has(sessionId)) {
          this.disposeSandbox(sandbox);
          this.disposeMcpConnections(mcp.connections);
          session.dispose();
          this.pendingSessions.delete(sessionId);
          throw new Error(
            this.closed
              ? "PiSessionRunner is closed"
              : `Runtime session ${sessionId} is closed`,
          );
        }
        this.sessions.set(sessionId, handle);
        this.pendingSessions.delete(sessionId);
        this.scheduleEviction(sessionId, handle);
        return handle;
      })()
      .catch((error) => {
        this.pendingSessions.delete(sessionId);
        throw error;
      });
    this.pendingSessions.set(sessionId, created);
    return created;
  }

  /**
   * Connect + discover the agent's declared MCP servers (plan 0122 §4.2).
   * Failures are captured, never propagated: they queue on the handle and
   * flush as session.error events at turn start (emitInternal does not exist
   * yet at build time). Exhausted servers (count >= max, or MCP disabled by
   * deployment) are skipped without dialing and without re-emitting.
   */
  private async prepareMcp(
    workspaceId: WorkspaceId,
    sessionId: string,
    context: { agentId?: string } | undefined,
  ): Promise<PreparedMcp> {
    const mcpOpts = this.opts.mcp;
    if (!mcpOpts) return EMPTY_MCP;
    const servers = mcpOpts.servers?.(workspaceId, sessionId, context) ?? [];
    if (servers.length === 0) return EMPTY_MCP;

    const maxFailures =
      mcpOpts.maxConsecutiveFailures ?? DEFAULT_MCP_MAX_CONSECUTIVE_FAILURES;
    let counts = this.mcpFailureCounts.get(sessionId);
    if (!counts) {
      counts = new Map<string, number>();
      this.mcpFailureCounts.set(sessionId, counts);
    }

    const connections: McpConnection[] = [];
    const toolDefinitions: ToolDefinition<any, any, any>[] = [];
    const toolNames = new Set<string>();
    const pendingFailures: RuntimeMcpConnectionFailedEvent[] = [];

    // Dial concurrently (review 0122-M1: a serial loop let N slow servers
    // stall the turn for N×timeout while pinning the sandbox); outcomes are
    // processed in declaration order so failure events stay deterministic.
    const dialable: Array<{ server: { name: string; url: string }; count: number }> = [];
    for (const server of servers) {
      const count = counts.get(server.name) ?? 0;
      if (count >= maxFailures) continue; // exhausted: no dial, no re-emit
      if (!mcpOpts.enabled) {
        counts.set(server.name, maxFailures); // emit the exhausted event once
        pendingFailures.push({
          type: "oma.mcp_connection_failed",
          mcpServerName: server.name,
          message: "MCP is disabled by deployment configuration",
          retryStatus: "exhausted",
        });
        continue;
      }
      dialable.push({ server, count });
    }
    const dialed = await Promise.all(
      dialable.map(async ({ server, count }) => {
        try {
          const connection = await McpConnection.connect(server, {
            fetch: this.mcpFetch,
            ...(mcpOpts.operationTimeoutMs === undefined
              ? {}
              : { operationTimeoutMs: mcpOpts.operationTimeoutMs }),
          });
          return { server, count, connection };
        } catch (error) {
          return {
            server,
            count,
            failure: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    for (const outcome of dialed) {
      const { server, count } = outcome;
      if (!("connection" in outcome) || outcome.connection === undefined) {
        const failures = count + 1;
        counts.set(server.name, failures);
        mcpOpts.onConnection?.("connect_failed");
        pendingFailures.push({
          type: "oma.mcp_connection_failed",
          mcpServerName: server.name,
          message: "failure" in outcome ? outcome.failure ?? "connect failed" : "connect failed",
          retryStatus: failures >= maxFailures ? "exhausted" : "retrying",
        });
        continue;
      }
      const connection = outcome.connection;
      counts.set(server.name, 0);
      mcpOpts.onConnection?.("connected");
      connections.push(connection);
      const definitions = createMcpToolDefinitions({
        workspaceId,
        sessionId,
        connection,
        permissionBridge: this.toolPermissionBridge,
        getEmitter: () => this.sessions.get(sessionId)?.emitInternal,
        ...(mcpOpts.access === undefined ? {} : { access: mcpOpts.access }),
        ...(context === undefined ? {} : { agentContext: context }),
        ...(mcpOpts.outputCapBytes === undefined
          ? {}
          : { outputCapBytes: mcpOpts.outputCapBytes }),
        ...(mcpOpts.onToolCall === undefined
          ? {}
          : { onToolCall: mcpOpts.onToolCall }),
        // Mid-call transport failure is connection-class (review 0122-M1,
        // Codex-adv): count it against the retry budget, surface the
        // structured mcp_connection_failed_error (once per server per
        // handle), and reconnect next turn via fresh-handle mechanics.
        onTransportFailure: (failedServerName, error) => {
          const failures = (counts.get(failedServerName) ?? 0) + 1;
          counts.set(failedServerName, failures);
          const handle = this.sessions.get(sessionId);
          if (!handle) return;
          handle.closeWhenIdle = true;
          if (handle.mcpFailureEmittedServers.has(failedServerName)) return;
          handle.mcpFailureEmittedServers.add(failedServerName);
          handle.emitInternal?.({
            type: "oma.mcp_connection_failed",
            mcpServerName: failedServerName,
            message: `MCP call failed mid-turn: ${error.message}`,
            retryStatus: failures >= maxFailures ? "exhausted" : "retrying",
          });
        },
      });
      for (const definition of definitions) {
        if (toolNames.has(definition.name)) {
          throw new Error(
            `MCP tool name collision across servers: ${definition.name}`,
          );
        }
        toolNames.add(definition.name);
        toolDefinitions.push(definition);
      }
    }
    return { connections, toolDefinitions, toolNames, pendingFailures };
  }

  private disposeMcpConnections(connections: readonly McpConnection[]): void {
    for (const connection of connections) {
      void connection.close();
    }
  }

  private async createPiSession(
    workspaceId: WorkspaceId,
    sessionId: string,
    sandbox: SandboxProvider | undefined,
    context: { agentId?: string } | undefined,
    mcpTools: readonly ToolDefinition<any, any, any>[] = [],
  ): Promise<PiRuntimeSession> {
    const provider = this.opts.provider ?? "anthropic";
    const modelId = this.opts.model ?? "claude-haiku-4-5";
    const model = this.modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(`Pi model not available: ${provider}/${modelId}`);
    }
    const customToolNames = (
      this.opts.customTools?.(workspaceId, sessionId, context) ?? []
    ).map((tool) => tool.name);
    const sandboxTools = this.enabledSandboxTools(workspaceId, sessionId, sandbox);
    const customTools: ToolDefinition<any, any, any>[] = [
      ...sandboxTools,
      ...this.customToolBridge.createTools(
        workspaceId,
        sessionId,
        () => this.sessions.get(sessionId)?.emitInternal,
        context,
      ),
      ...mcpTools,
    ];
    const mcpToolNames = mcpTools.map((tool) => tool.name);
    const { session } = await createAgentSession({
      model,
      thinkingLevel: this.opts.thinkingLevel ?? "off",
      noTools: "builtin",
      tools: sandbox
        ? [
            ...sandboxTools.map((tool) => tool.name),
            ...customToolNames,
            ...mcpToolNames,
          ]
        : [...customToolNames, ...mcpToolNames],
      customTools,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.inMemory(),
    });
    return session;
  }

  private preparingSessionAgentContext(
    workspaceId: WorkspaceId,
    sessionId: string,
  ): { agentId?: string } | undefined {
    const preparing = this.preparingSessionAgents.get(sessionId);
    if (preparing?.workspaceId !== workspaceId) return undefined;
    return { agentId: preparing.agentId };
  }

  private resolveSandboxProviderFactory(): SandboxProviderFactory | undefined {
    // Direct factories are trusted internal wiring for tests and already-built
    // providers. Never derive this option from public request, agent, or prompt
    // input; untrusted provider choice must go through sandboxProviderSelection.
    if (this.opts.sandboxProviderFactory) return this.opts.sandboxProviderFactory;
    return resolveSandboxProviderFactory(
      this.opts.sandboxProviderSelection,
      this.opts.sandboxProviderSelectionOptions,
    );
  }

  private touch(sessionId: string, handle: RuntimeHandle): void {
    handle.lastUsedAt = this.now();
    this.scheduleEviction(sessionId, handle);
  }

  private enabledSandboxTools(
    workspaceId: WorkspaceId,
    sessionId: string,
    sandbox: SandboxProvider | undefined,
  ): ToolDefinition<any, any, any>[] {
    if (!sandbox) return [];
    const toolsByName = new Map(
      sandbox.tools.map((tool) => [tool.name, tool] as const),
    );
    const out: ToolDefinition<any, any, any>[] = [];
    for (const toolName of sandbox.toolNames) {
      const access = this.toolPermissionBridge.access(
        workspaceId,
        sessionId,
        toolName,
      );
      if (!access.enabled) continue;
      const tool = toolsByName.get(toolName);
      if (!tool) continue;
      out.push(
        this.toolPermissionBridge.wrapTool(
          workspaceId,
          sessionId,
          toolName,
          tool,
          () => this.sessions.get(sessionId)?.emitInternal,
        ),
      );
    }
    return out;
  }

  private enabledSandboxToolNames(
    workspaceId: WorkspaceId,
    sessionId: string,
    sandbox: SandboxProvider | undefined,
  ): ReadonlySet<SandboxedBuiltinToolName> {
    if (!sandbox) return new Set();
    const out = new Set<SandboxedBuiltinToolName>();
    for (const toolName of sandbox.toolNames) {
      const access = this.toolPermissionBridge.access(
        workspaceId,
        sessionId,
        toolName,
      );
      if (access.enabled) out.add(toolName);
    }
    return out;
  }

  private scheduleEviction(sessionId: string, handle: RuntimeHandle): void {
    if (handle.timer) clearTimeout(handle.timer);
    if (this.idleTtlMs <= 0) return;
    handle.timer = setTimeout(() => {
      if (handle.running) {
        this.scheduleEviction(sessionId, handle);
        return;
      }
      if (handle.closeWhenIdle) {
        this.evict(sessionId, handle);
        return;
      }
      if (this.now() - handle.lastUsedAt < this.idleTtlMs) {
        this.scheduleEviction(sessionId, handle);
        return;
      }
      this.evict(sessionId, handle);
    }, this.idleTtlMs);
  }

  private async closeHandle(
    sessionId: string,
    handle: RuntimeHandle,
  ): Promise<void> {
    if (handle.running) {
      handle.closeWhenIdle = true;
    }
    try {
      await handle.session.abort();
    } catch {
      // Disposal below is the authoritative cleanup path.
    }
    this.evict(sessionId, handle);
  }

  private async interruptHandle(
    sessionId: string,
    handle: RuntimeHandle,
  ): Promise<void> {
    handle.session.clearQueue?.();
    await handle.session.abort();
    handle.session.clearQueue?.();
    handle.running = false;
    handle.needsFreshPromptAfterInterrupt = true;
    this.touch(sessionId, handle);
  }

  private async waitForPendingInterrupt(sessionId: string): Promise<void> {
    const interrupt = this.pendingInterrupts.get(sessionId);
    if (!interrupt) return;
    try {
      await interrupt;
    } catch {
      // interruptSession callers observe abort errors; message delivery waits only
      // for the abort window to close before deciding prompt vs follow-up.
    }
  }

  private evict(sessionId: string, handle: RuntimeHandle): void {
    if (handle.timer) clearTimeout(handle.timer);
    if (this.sessions.get(sessionId) === handle) {
      this.sessions.delete(sessionId);
    }
    this.customToolBridge.rejectSession(
      sessionId,
      new Error("Runtime session evicted"),
    );
    this.toolPermissionBridge.rejectSession(
      sessionId,
      new Error("Runtime session evicted"),
    );
    this.disposeSandbox(handle.sandbox);
    this.disposeMcpConnections(handle.mcpConnections);
    handle.session.dispose();
  }

  private disposeSandbox(sandbox: SandboxProvider | undefined): void {
    if (sandbox === undefined) return;
    sandbox.dispose();
    this.opts.onSandboxEvent?.("disposed");
  }
}

function assertActiveToolSurface(
  session: PiRuntimeSession,
  sandboxToolNames: ReadonlySet<SandboxedBuiltinToolName>,
  customToolNames: ReadonlySet<string>,
): void {
  if (typeof session.getActiveToolNames !== "function") {
    throw new Error("Pi runtime session does not expose active tool names");
  }
  const activeToolNames = session.getActiveToolNames();
  const expectedToolNames = new Set<string>(customToolNames);
  for (const name of sandboxToolNames) expectedToolNames.add(name);
  for (const name of activeToolNames) {
    if (expectedToolNames.has(name)) continue;
    throw new Error(`Unexpected active Pi tool after sandbox setup: ${name}`);
  }
}

function assertNoSandboxCustomToolNameCollision(
  sandbox: SandboxProvider | undefined,
  customToolNames: ReadonlySet<string>,
): void {
  if (!sandbox) return;
  for (const name of customToolNames) {
    if (!sandbox.toolNames.has(name as SandboxedBuiltinToolName)) continue;
    throw new Error(`Custom tool name conflicts with sandbox builtin: ${name}`);
  }
}

function updateRunning(handle: RuntimeHandle, event: unknown): void {
  if (typeof event !== "object" || event === null) return;
  const type = (event as { type?: unknown }).type;
  if (type === "agent_start") handle.running = true;
  if (type === "agent_end") handle.running = false;
}

function isAlreadyProcessing(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(ALREADY_PROCESSING_MESSAGE)
  );
}

function isInternalRuntimeEvent(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const type = (event as { type?: unknown }).type;
  return (
    type === "oma.custom_tool_use" ||
    type === "oma.tool_permission_use" ||
    type === "oma.tool_permission_with_model_end" ||
    type === "oma.mcp_tool_use" ||
    type === "oma.mcp_tool_with_model_end" ||
    type === "oma.mcp_tool_result" ||
    type === "oma.mcp_connection_failed"
  );
}

interface PreparedMcp {
  connections: readonly McpConnection[];
  toolDefinitions: readonly ToolDefinition<any, any, any>[];
  toolNames: Set<string>;
  pendingFailures: readonly RuntimeMcpConnectionFailedEvent[];
}

const EMPTY_MCP: PreparedMcp = {
  connections: [],
  toolDefinitions: [],
  toolNames: new Set(),
  pendingFailures: [],
};

/** message_end toolCall blocks whose pi-name is an MCP tool of this handle. Exported for direct contract tests (review 0122-M1, Sonnet 1). */
export function mcpToolCallsInMessage(
  mcpToolNames: ReadonlySet<string>,
  event: unknown,
): Array<{ toolCallId: string }> {
  if (mcpToolNames.size === 0) return [];
  if (typeof event !== "object" || event === null) return [];
  const typed = event as { type?: unknown; message?: unknown };
  if (typed.type !== "message_end") return [];
  if (typeof typed.message !== "object" || typed.message === null) return [];
  const message = typed.message as { role?: unknown; content?: unknown };
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const out: Array<{ toolCallId: string }> = [];
  for (const block of message.content) {
    if (typeof block !== "object" || block === null) continue;
    const toolCall = block as { type?: unknown; id?: unknown; name?: unknown };
    if (toolCall.type !== "toolCall") continue;
    if (typeof toolCall.id !== "string" || typeof toolCall.name !== "string") {
      continue;
    }
    if (!mcpToolNames.has(toolCall.name)) continue;
    out.push({ toolCallId: toolCall.id });
  }
  return out;
}

/** MCP-aware variant of takeMessageEndForToolCall (plan 0122 §4.4 step 2). Exported for direct contract tests. */
export function takeMessageEndForMcpToolCall(
  mcpToolNames: ReadonlySet<string>,
  eventQueues: unknown[][],
  piToolCallId: string,
): { event: unknown; suppressedPiToolCallIds: string[] } | undefined {
  for (const events of eventQueues) {
    let suppressedPiToolCallIds: string[] = [];
    const index = events.findIndex((event) => {
      const calls = mcpToolCallsInMessage(mcpToolNames, event);
      if (!calls.some((call) => call.toolCallId === piToolCallId)) return false;
      suppressedPiToolCallIds = calls.map((call) => call.toolCallId);
      return true;
    });
    if (index === -1) continue;
    const [event] = events.splice(index, 1);
    return { event, suppressedPiToolCallIds };
  }
  return undefined;
}

function sandboxedToolEvent(
  sandbox: SandboxProvider | undefined,
  event: unknown,
  eventType: "tool_execution_start" | "tool_execution_end",
):
  | {
      toolName: SandboxedBuiltinToolName;
      toolCallId: string;
      isError: boolean;
    }
  | undefined {
  if (!sandbox || typeof event !== "object" || event === null) return undefined;
  const typed = event as {
    type?: unknown;
    toolName?: unknown;
    toolCallId?: unknown;
    isError?: unknown;
  };
  if (typed.type !== eventType) return undefined;
  if (typeof typed.toolName !== "string") return undefined;
  if (typeof typed.toolCallId !== "string") return undefined;
  if (!sandbox.toolNames.has(typed.toolName as never)) return undefined;
  return {
    toolName: typed.toolName as SandboxedBuiltinToolName,
    toolCallId: typed.toolCallId,
    isError: typed.isError === true,
  };
}

function sandboxedToolCallsInMessage(
  sandbox: SandboxProvider | undefined,
  event: unknown,
): Array<{ toolName: SandboxedBuiltinToolName; toolCallId: string }> {
  if (!sandbox || typeof event !== "object" || event === null) return [];
  const typed = event as { type?: unknown; message?: unknown };
  if (typed.type !== "message_end") return [];
  if (typeof typed.message !== "object" || typed.message === null) return [];
  const message = typed.message as { role?: unknown; content?: unknown };
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const out: Array<{ toolName: SandboxedBuiltinToolName; toolCallId: string }> = [];
  for (const block of message.content) {
    if (typeof block !== "object" || block === null) continue;
    const toolCall = block as { type?: unknown; id?: unknown; name?: unknown };
    if (toolCall.type !== "toolCall") continue;
    if (typeof toolCall.id !== "string" || typeof toolCall.name !== "string") {
      continue;
    }
    if (!sandbox.toolNames.has(toolCall.name as never)) continue;
    out.push({
      toolName: toolCall.name as SandboxedBuiltinToolName,
      toolCallId: toolCall.id,
    });
  }
  return out;
}

function takeMessageEndForToolCall(
  sandbox: SandboxProvider | undefined,
  eventQueues: unknown[][],
  piToolCallId: string,
): { event: unknown; suppressedPiToolCallIds: string[] } | undefined {
  for (const events of eventQueues) {
    let suppressedPiToolCallIds: string[] = [];
    const index = events.findIndex((event) => {
      const calls = sandboxedToolCallsInMessage(sandbox, event);
      if (!calls.some((call) => call.toolCallId === piToolCallId)) return false;
      suppressedPiToolCallIds = calls.map((call) => call.toolCallId);
      return true;
    });
    if (index === -1) continue;
    const [event] = events.splice(index, 1);
    return { event, suppressedPiToolCallIds };
  }
  return undefined;
}

function assertSandboxProviderHandledToolCall(opts: {
  sandbox: SandboxProvider | undefined;
  toolPermissionBridge: PiToolPermissionBridge;
  sessionId: string;
  toolName: SandboxedBuiltinToolName;
  toolCallId: string;
  isError: boolean;
}): void {
  if (!opts.sandbox) return;
  if (opts.sandbox.invocations.toolCallIds[opts.toolName].has(opts.toolCallId)) {
    return;
  }
  if (
    opts.isError &&
    opts.toolPermissionBridge.permissionDenied(opts.sessionId, opts.toolCallId)
  ) {
    return;
  }
  throw new Error(
    `Sandboxed builtin tool ${opts.toolName} executed without invoking the sandbox provider`,
  );
}
