import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  RuntimeCustomToolUseEvent,
  RuntimeEventRunner,
} from "../../events/types.ts";
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

const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000;
const ALREADY_PROCESSING_MESSAGE = "Agent is already processing";

export interface PiRuntimeSession {
  prompt(
    text: string,
    opts?: { streamingBehavior?: "steer" | "followUp" },
  ): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: unknown) => void): () => void;
}

export type PiRuntimeSessionFactory = (
  workspaceId: WorkspaceId,
  sessionId: string,
) => Promise<PiRuntimeSession>;
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
  private readonly customToolBridge: PiCustomToolBridge;
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private readonly sessionFactory: PiRuntimeSessionFactory;
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
      customTools?: PiCustomToolsProvider;
      customToolTimeoutMs?: number;
    } = {},
  ) {
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.sessionFactory =
      opts.sessionFactory ??
      ((workspaceId, sessionId) => this.createPiSession(workspaceId, sessionId));
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

  claimCustomToolResult(
    workspaceId: WorkspaceId,
    sessionId: string,
    event: ManagedAgentsUserCustomToolResultEventInput,
  ): (() => void) | undefined {
    return this.customToolBridge.claimResult(workspaceId, sessionId, event);
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
    const sandboxStartCounts = snapshotSandboxInvocations(handle.sandbox);
    const observedSandboxedToolStarts = new Map<SandboxedBuiltinToolName, number>();
    let done = false;
    let failure: unknown;
    let becameFollowUp = false;
    let wake: (() => void) | undefined;

    const stop = handle.session.subscribe((event) => {
      updateRunning(handle, event);
      const sandboxedTool = sandboxedToolStart(handle.sandbox, event);
      if (sandboxedTool) {
        observedSandboxedToolStarts.set(
          sandboxedTool,
          (observedSandboxedToolStarts.get(sandboxedTool) ?? 0) + 1,
        );
      }
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
        yield queue.shift();
      }

      await run;
      if (failure) throw failure;
      assertSandboxProviderWasInvoked({
        sandbox: handle.sandbox,
        observedSandboxedToolStarts,
        startCounts: sandboxStartCounts,
      });
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
  ): Promise<RuntimeHandle> {
    if (this.closed) throw new Error("PiSessionRunner is closed");
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const pending = this.pendingSessions.get(sessionId);
    if (pending) return pending;

    const created = this.sessionFactory(workspaceId, sessionId)
      .then(async (session) => {
        let sandbox: SandboxProvider | undefined;
        try {
          sandbox = await this.opts.sandboxProviderFactory?.(
            workspaceId,
            sessionId,
          );
        } catch (error) {
          session.dispose();
          throw error;
        }
        if (sandbox) {
          const installed = installSandboxToolsIfSupported(session, sandbox);
          if (!installed && !this.opts.sessionFactory) {
            sandbox.dispose();
            session.dispose();
            throw new Error("Pi session does not expose an active tool list");
          }
        }
        const customToolNames = new Set(
          (this.opts.customTools?.(workspaceId, sessionId) ?? []).map(
            (tool) => tool.name,
          ),
        );
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
        if (this.closed) {
          sandbox?.dispose();
          session.dispose();
          this.pendingSessions.delete(sessionId);
          throw new Error("PiSessionRunner is closed");
        }
        this.sessions.set(sessionId, handle);
        this.pendingSessions.delete(sessionId);
        this.scheduleEviction(sessionId, handle);
        return handle;
      })
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
  ): Promise<PiRuntimeSession> {
    const provider = this.opts.provider ?? "anthropic";
    const modelId = this.opts.model ?? "claude-haiku-4-5";
    const model = this.modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(`Pi model not available: ${provider}/${modelId}`);
    }
    const { session } = await createAgentSession({
      model,
      thinkingLevel: this.opts.thinkingLevel ?? "off",
      noTools: this.opts.sandboxProviderFactory ? undefined : "builtin",
      tools: this.opts.sandboxProviderFactory
        ? [
            "bash",
            "read",
            "write",
            "edit",
            "find",
            "ls",
            ...(
              this.opts.customTools?.(workspaceId, sessionId) ?? []
            ).map((tool) => tool.name),
          ]
        : undefined,
      customTools: this.customToolBridge.createTools(
        workspaceId,
        sessionId,
        () => this.sessions.get(sessionId)?.emitInternal,
      ),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.inMemory(),
    });
    return session;
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

function installSandboxToolsIfSupported(
  session: PiRuntimeSession,
  sandbox: SandboxProvider,
): boolean {
  const actual = session as PiRuntimeSession & {
    agent?: { state?: { tools?: unknown[] } };
  };
  const tools = actual.agent?.state?.tools;
  if (!Array.isArray(tools)) {
    return false;
  }
  const sandboxToolNames = sandbox.toolNames;
  const retainedTools = tools.filter((tool) => {
    if (typeof tool !== "object" || tool === null) return true;
    const name = (tool as { name?: unknown }).name;
    return typeof name !== "string" || !sandboxToolNames.has(name as never);
  });
  actual.agent!.state!.tools = [...retainedTools, ...sandbox.tools];
  return true;
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

function sandboxedToolStart(
  sandbox: SandboxProvider | undefined,
  event: unknown,
): SandboxedBuiltinToolName | undefined {
  if (!sandbox || typeof event !== "object" || event === null) return undefined;
  const typed = event as { type?: unknown; toolName?: unknown };
  if (typed.type !== "tool_execution_start") return undefined;
  if (typeof typed.toolName !== "string") return undefined;
  if (!sandbox.toolNames.has(typed.toolName as never)) return undefined;
  return typed.toolName as SandboxedBuiltinToolName;
}

function assertSandboxProviderWasInvoked(opts: {
  sandbox: SandboxProvider | undefined;
  observedSandboxedToolStarts: ReadonlyMap<SandboxedBuiltinToolName, number>;
  startCounts: Readonly<Record<SandboxedBuiltinToolName, number>>;
}): void {
  if (!opts.sandbox || opts.observedSandboxedToolStarts.size === 0) return;
  for (const [toolName, observedStarts] of opts.observedSandboxedToolStarts) {
    const providerDelta =
      opts.sandbox.invocations.byTool[toolName] - opts.startCounts[toolName];
    if (providerDelta >= observedStarts) continue;
    throw new Error(
      `Sandboxed builtin tool ${toolName} executed without invoking the sandbox provider`,
    );
  }
}

function snapshotSandboxInvocations(
  sandbox: SandboxProvider | undefined,
): Record<SandboxedBuiltinToolName, number> {
  return {
    bash: sandbox?.invocations.byTool.bash ?? 0,
    read: sandbox?.invocations.byTool.read ?? 0,
    write: sandbox?.invocations.byTool.write ?? 0,
    edit: sandbox?.invocations.byTool.edit ?? 0,
    find: sandbox?.invocations.byTool.find ?? 0,
    ls: sandbox?.invocations.byTool.ls ?? 0,
  };
}
