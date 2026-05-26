import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeEventRunner } from "../../events/types.ts";
import type { WorkspaceId } from "../../workspace.ts";

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

export type PiRuntimeSessionFactory = () => Promise<PiRuntimeSession>;

interface RuntimeHandle {
  session: PiRuntimeSession;
  running: boolean;
  lastUsedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class PiSessionRunner implements RuntimeEventRunner {
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);
  private readonly sessions = new Map<string, RuntimeHandle>();
  private readonly pendingSessions = new Map<string, Promise<RuntimeHandle>>();
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private readonly sessionFactory: PiRuntimeSessionFactory;

  constructor(
    private readonly opts: {
      provider?: string;
      model?: string;
      thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
      idleTtlMs?: number;
      now?: () => number;
      sessionFactory?: PiRuntimeSessionFactory;
    } = {},
  ) {
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.sessionFactory = opts.sessionFactory ?? (() => this.createPiSession());
  }

  runUserMessage(
    _workspaceId: WorkspaceId,
    sessionId: string,
    text: string,
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<unknown> {
    return this.runOnSession(sessionId, text, opts.signal);
  }

  close(): void {
    for (const [sessionId, handle] of this.sessions) {
      this.evict(sessionId, handle);
    }
    this.pendingSessions.clear();
  }

  private async *runOnSession(
    sessionId: string,
    text: string,
    signal: AbortSignal | undefined,
  ): AsyncIterable<unknown> {
    const handle = await this.getOrCreateHandle(sessionId);
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
    let done = false;
    let failure: unknown;
    let wake: (() => void) | undefined;

    const stop = handle.session.subscribe((event) => {
      updateRunning(handle, event);
      queue.push(event);
      wake?.();
    });

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
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
          continue;
        }
        yield queue.shift();
      }

      await run;
      if (failure) throw failure;
      this.touch(sessionId, handle);
    } catch (error) {
      this.evict(sessionId, handle);
      throw error;
    } finally {
      stop();
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async getOrCreateHandle(sessionId: string): Promise<RuntimeHandle> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const pending = this.pendingSessions.get(sessionId);
    if (pending) return pending;

    const created = this.sessionFactory()
      .then((session) => {
        const handle: RuntimeHandle = {
          session,
          running: false,
          lastUsedAt: this.now(),
          timer: undefined,
        };
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

  private async createPiSession(): Promise<PiRuntimeSession> {
    const provider = this.opts.provider ?? "anthropic";
    const modelId = this.opts.model ?? "claude-haiku-4-5";
    const model = this.modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(`Pi model not available: ${provider}/${modelId}`);
    }
    const { session } = await createAgentSession({
      model,
      thinkingLevel: this.opts.thinkingLevel ?? "off",
      noTools: "builtin",
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
    handle.session.dispose();
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
