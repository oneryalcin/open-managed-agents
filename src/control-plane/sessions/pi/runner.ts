import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  RuntimeCustomToolUseEvent,
  RuntimeEventRunner,
  RuntimeSessionFileMount,
  RuntimeSessionPrepareOptions,
} from "../../events/types.ts";
import { RuntimeUnsupportedSessionFileResourcesError } from "../../events/types.ts";
import type { ManagedAgentsUserCustomToolResultEventInput } from "../../../types/events.ts";
import type { WorkspaceId } from "../../workspace.ts";
import {
  PiCustomToolBridge,
  type PiCustomToolsProvider,
} from "./custom-tools.ts";
import type {
  SandboxedBuiltinToolName,
  SandboxProvider,
  SandboxProviderFactory,
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
  closeWhenIdle: boolean;
  lastUsedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  customToolNames: Set<string>;
  emitInternal: ((event: RuntimeCustomToolUseEvent) => void) | undefined;
}

export class PiSessionRunner implements RuntimeEventRunner {
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private readonly sessions = new Map<string, RuntimeHandle>();
  private readonly pendingSessions = new Map<string, Promise<RuntimeHandle>>();
  private readonly closedSessionIds = new Set<string>();
  private readonly customToolBridge: PiCustomToolBridge;
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private readonly sessionFactory: PiRuntimeSessionFactory | undefined;
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
    } = {},
  ) {
    this.resolveSandboxProviderFactory();
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.sessionFactory = opts.sessionFactory;
    this.customToolBridge = new PiCustomToolBridge({
      customTools: opts.customTools,
      timeoutMs: opts.customToolTimeoutMs,
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
    const handle = await this.getOrCreateHandle(
      workspaceId,
      sessionId,
      opts.fileMounts,
    );
    this.touch(sessionId, handle);
  }

  claimCustomToolResult(
    workspaceId: WorkspaceId,
    sessionId: string,
    event: ManagedAgentsUserCustomToolResultEventInput,
  ): (() => void) | undefined {
    return this.customToolBridge.claimResult(workspaceId, sessionId, event);
  }

  async interruptSession(
    _workspaceId: WorkspaceId,
    sessionId: string,
  ): Promise<void> {
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
    return this.customToolBridge.customToolNames(workspaceId, sessionId);
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
    const handle = await this.getOrCreateHandle(workspaceId, sessionId);
    if (this.closed) {
      this.evict(sessionId, handle);
      throw new Error("PiSessionRunner is closed");
    }
    this.touch(sessionId, handle);

    if (handle.running) {
      try {
        await handle.session.followUp(text);
        this.touch(sessionId, handle);
      } catch (error) {
        this.evict(sessionId, handle);
        throw error;
      }
      return;
    }

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
        queue.push(event);
        wake?.();
      };
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
              toolName: sandboxedEnd.toolName,
              toolCallId: sandboxedEnd.toolCallId,
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
            toolName: sandboxedEnd.toolName,
            toolCallId: sandboxedEnd.toolCallId,
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
        const customToolNames = new Set(
          (this.opts.customTools?.(workspaceId, sessionId) ?? []).map(
            (tool) => tool.name,
          ),
        );
        const sandboxProviderFactory = this.resolveSandboxProviderFactory();
        let sandbox: SandboxProvider | undefined;
        let session: PiRuntimeSession | undefined;
        try {
          sandbox = await sandboxProviderFactory?.(
            workspaceId,
            sessionId,
          );
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
          assertNoSandboxCustomToolNameCollision(sandbox, customToolNames);
          session =
            this.sessionFactory === undefined
              ? await this.createPiSession(workspaceId, sessionId, sandbox)
              : await this.sessionFactory(workspaceId, sessionId);
          assertActiveToolSurface(session, sandbox, customToolNames);
        } catch (error) {
          sandbox?.dispose();
          session?.dispose();
          throw error;
        }
        if (!session) throw new Error("Pi session was not created");
        const handle: RuntimeHandle = {
          session,
          sandbox,
          running: false,
          closeWhenIdle: false,
          lastUsedAt: this.now(),
          timer: undefined,
          customToolNames,
          emitInternal: undefined,
        };
        if (this.closed || this.closedSessionIds.has(sessionId)) {
          sandbox?.dispose();
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

  private async createPiSession(
    workspaceId: WorkspaceId,
    sessionId: string,
    sandbox: SandboxProvider | undefined,
  ): Promise<PiRuntimeSession> {
    const provider = this.opts.provider ?? "anthropic";
    const modelId = this.opts.model ?? "claude-haiku-4-5";
    const model = this.modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(`Pi model not available: ${provider}/${modelId}`);
    }
    const customToolNames = (
      this.opts.customTools?.(workspaceId, sessionId) ?? []
    ).map((tool) => tool.name);
    const customTools: ToolDefinition<any, any, any>[] = [
      ...(sandbox?.tools ?? []),
      ...this.customToolBridge.createTools(
        workspaceId,
        sessionId,
        () => this.sessions.get(sessionId)?.emitInternal,
      ),
    ];
    const { session } = await createAgentSession({
      model,
      thinkingLevel: this.opts.thinkingLevel ?? "off",
      noTools: "builtin",
      tools: sandbox
        ? [
            ...sandbox.toolNames,
            ...customToolNames,
          ]
        : customToolNames,
      customTools,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.inMemory(),
    });
    return session;
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
    this.touch(sessionId, handle);
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
    handle.sandbox?.dispose();
    handle.session.dispose();
  }
}

function assertActiveToolSurface(
  session: PiRuntimeSession,
  sandbox: SandboxProvider | undefined,
  customToolNames: ReadonlySet<string>,
): void {
  if (typeof session.getActiveToolNames !== "function") {
    throw new Error("Pi runtime session does not expose active tool names");
  }
  const activeToolNames = session.getActiveToolNames();
  const expectedToolNames = new Set<string>(customToolNames);
  for (const name of sandbox?.toolNames ?? []) expectedToolNames.add(name);
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

function sandboxedToolEvent(
  sandbox: SandboxProvider | undefined,
  event: unknown,
  eventType: "tool_execution_start" | "tool_execution_end",
): { toolName: SandboxedBuiltinToolName; toolCallId: string } | undefined {
  if (!sandbox || typeof event !== "object" || event === null) return undefined;
  const typed = event as {
    type?: unknown;
    toolName?: unknown;
    toolCallId?: unknown;
  };
  if (typed.type !== eventType) return undefined;
  if (typeof typed.toolName !== "string") return undefined;
  if (typeof typed.toolCallId !== "string") return undefined;
  if (!sandbox.toolNames.has(typed.toolName as never)) return undefined;
  return {
    toolName: typed.toolName as SandboxedBuiltinToolName,
    toolCallId: typed.toolCallId,
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

function assertSandboxProviderHandledToolCall(opts: {
  sandbox: SandboxProvider | undefined;
  toolName: SandboxedBuiltinToolName;
  toolCallId: string;
}): void {
  if (!opts.sandbox) return;
  if (opts.sandbox.invocations.toolCallIds[opts.toolName].has(opts.toolCallId)) {
    return;
  }
  throw new Error(
    `Sandboxed builtin tool ${opts.toolName} executed without invoking the sandbox provider`,
  );
}
