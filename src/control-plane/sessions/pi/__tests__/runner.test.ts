import { describe, expect, it } from "vitest";
import {
  PiSessionRunner,
  type PiRuntimeSession,
} from "../runner.ts";
import type { SandboxProvider } from "../sandbox/provider.ts";

describe("PiSessionRunner continuity (Cycle C.3a)", () => {
  it("reuses one Pi session for multiple turns of the same managed session", async () => {
    const factory = new FakeSessionFactory();
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      idleTtlMs: 0,
    });

    const first = await collect(runner.runUserMessage("wrk", "sesn_1", "one"));
    const second = await collect(runner.runUserMessage("wrk", "sesn_1", "two"));

    expect(factory.sessions).toHaveLength(1);
    expect(factory.sessions[0]?.prompts).toEqual(["one", "two"]);
    expect(messageTexts(first)).toEqual(["reply: one"]);
    expect(messageTexts(second)).toEqual(["reply: two"]);
  });

  it("does not share Pi state across different managed sessions", async () => {
    const factory = new FakeSessionFactory();
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      idleTtlMs: 0,
    });

    await collect(runner.runUserMessage("wrk", "sesn_1", "one"));
    await collect(runner.runUserMessage("wrk", "sesn_2", "two"));

    expect(factory.sessions).toHaveLength(2);
    expect(factory.sessions[0]?.prompts).toEqual(["one"]);
    expect(factory.sessions[1]?.prompts).toEqual(["two"]);
  });

  it("queues a user message with followUp while the session is running", async () => {
    const gate = deferred<void>();
    const factory = new FakeSessionFactory({ promptGate: gate.promise });
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      idleTtlMs: 0,
    });

    const first = collect(runner.runUserMessage("wrk", "sesn_1", "one"));
    await until(() => factory.sessions[0]?.running === true);

    const second = await collect(runner.runUserMessage("wrk", "sesn_1", "two"));
    expect(second).toEqual([]);
    expect(factory.sessions[0]?.followUps).toEqual(["two"]);

    gate.resolve();
    const firstEvents = await first;
    expect(messageTexts(firstEvents)).toEqual(["reply: one", "reply: two"]);
  });

  it("falls back to followUp when Pi rejects prompt because the session is already running", async () => {
    const factory = new FakeSessionFactory({ throwAlreadyProcessingOnce: true });
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      idleTtlMs: 0,
    });

    const events = await collect(runner.runUserMessage("wrk", "sesn_1", "two"));

    expect(events).toEqual([]);
    expect(factory.sessions[0]?.prompts).toEqual(["two"]);
    expect(factory.sessions[0]?.followUps).toEqual(["two"]);
  });

  it("does not emit duplicate events when two idle sends race into prompt/followUp", async () => {
    const gate = deferred<void>();
    const factory = new FakeSessionFactory({
      promptGate: gate.promise,
      throwAlreadyProcessingAfterFirstPrompt: true,
    });
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      idleTtlMs: 0,
    });

    const first = collect(runner.runUserMessage("wrk", "sesn_1", "one"));
    const second = collect(runner.runUserMessage("wrk", "sesn_1", "two"));
    await until(() => factory.sessions[0]?.followUps.length === 1);
    factory.sessions[0]?.emitMessage("overlap");
    gate.resolve();

    const firstEvents = await first;
    const secondEvents = await second;
    expect(messageTexts(firstEvents)).toEqual([
      "reply: overlap",
      "reply: one",
      "reply: two",
    ]);
    expect(messageTexts(secondEvents)).toEqual([]);
  });

  it("does not evict an active turn, then disposes after the turn drains and TTL elapses", async () => {
    const gate = deferred<void>();
    const factory = new FakeSessionFactory({ promptGate: gate.promise });
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      idleTtlMs: 20,
    });

    const run = collect(runner.runUserMessage("wrk", "sesn_1", "one"));
    await until(() => factory.sessions[0]?.running === true);
    await delay(50);
    expect(factory.sessions[0]?.disposed).toBe(false);

    gate.resolve();
    await run;
    await until(() => factory.sessions[0]?.disposed === true);
  });

  it("evicts the cached session after a hard runtime error", async () => {
    const factory = new FakeSessionFactory({ throwHardErrorOnce: true });
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      idleTtlMs: 0,
    });

    await expect(
      collect(runner.runUserMessage("wrk", "sesn_1", "one")),
    ).rejects.toThrow("hard runtime failure");
    expect(factory.sessions[0]?.disposed).toBe(true);

    await collect(runner.runUserMessage("wrk", "sesn_1", "two"));
    expect(factory.sessions).toHaveLength(2);
    expect(factory.sessions[1]?.prompts).toEqual(["two"]);
  });

  it("close waits for an active turn to drain before disposing", async () => {
    const gate = deferred<void>();
    const factory = new FakeSessionFactory({ promptGate: gate.promise });
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      idleTtlMs: 20,
    });

    const run = collect(runner.runUserMessage("wrk", "sesn_1", "one"));
    await until(() => factory.sessions[0]?.running === true);
    runner.close();
    await delay(50);
    expect(factory.sessions[0]?.disposed).toBe(false);

    gate.resolve();
    await run;
    await until(() => factory.sessions[0]?.disposed === true);
  });

  it("close disposes pending sessions that resolve after shutdown", async () => {
    const created = deferred<PiRuntimeSession>();
    const runner = new PiSessionRunner({
      sessionFactory: () => created.promise,
      idleTtlMs: 0,
    });
    const run = collect(runner.runUserMessage("wrk", "sesn_1", "one"));
    await delay(10);

    const session = new FakeSession();
    runner.close();
    created.resolve(session);

    await expect(run).rejects.toThrow("PiSessionRunner is closed");
    expect(session.disposed).toBe(true);
  });

  it("disposes a created session if sandbox provisioning fails", async () => {
    const factory = new FakeSessionFactory();
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      sandboxProviderFactory: async () => {
        throw new Error("sandbox provision failed");
      },
      idleTtlMs: 0,
    });

    await expect(
      collect(runner.runUserMessage("wrk", "sesn_1", "one")),
    ).rejects.toThrow("sandbox provision failed");
    expect(factory.sessions[0]?.disposed).toBe(true);
  });

  it("fails closed when a sandboxed builtin tool bypasses the provider", async () => {
    const factory = new FakeSessionFactory({ emitSandboxedTool: "bash" });
    const sandbox = new FakeSandboxProvider(["bash"]);
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      sandboxProviderFactory: async () => sandbox,
      idleTtlMs: 0,
    });

    await expect(
      collect(runner.runUserMessage("wrk", "sesn_1", "one")),
    ).rejects.toThrow("without invoking the sandbox provider");
    expect(sandbox.disposed).toBe(true);
  });

  it("fails closed when the wrong provider tool was invoked", async () => {
    const sandbox = new FakeSandboxProvider(["bash", "read"]);
    const factory = new FakeSessionFactory({
      emitSandboxedTool: "bash",
      onSandboxedTool: () => sandbox.recordInvocation("read"),
    });
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      sandboxProviderFactory: async () => sandbox,
      idleTtlMs: 0,
    });

    await expect(
      collect(runner.runUserMessage("wrk", "sesn_1", "one")),
    ).rejects.toThrow("builtin tool bash");
    expect(sandbox.disposed).toBe(true);
  });

  it("accepts a sandboxed builtin tool when the matching provider tool was invoked", async () => {
    const sandbox = new FakeSandboxProvider(["bash"]);
    const factory = new FakeSessionFactory({
      emitSandboxedTool: "bash",
      onSandboxedTool: () => sandbox.recordInvocation("bash"),
    });
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      sandboxProviderFactory: async () => sandbox,
      idleTtlMs: 0,
    });

    const events = await collect(runner.runUserMessage("wrk", "sesn_1", "one"));

    expect(messageTexts(events)).toEqual(["reply: one"]);
    expect(sandbox.disposed).toBe(false);
  });
});

class FakeSessionFactory {
  readonly sessions: FakeSession[] = [];
  private hardErrorsRemaining: number;

  constructor(private readonly opts: FakeSessionOptions = {}) {
    this.hardErrorsRemaining = opts.throwHardErrorOnce === true ? 1 : 0;
  }

  async create(): Promise<PiRuntimeSession> {
    const session = new FakeSession({
      ...this.opts,
      shouldThrowHardError: () => {
        if (this.hardErrorsRemaining <= 0) return false;
        this.hardErrorsRemaining -= 1;
        return true;
      },
    });
    this.sessions.push(session);
    return session;
  }
}

interface FakeSessionOptions {
  promptGate?: Promise<void>;
  throwAlreadyProcessingOnce?: boolean;
  throwAlreadyProcessingAfterFirstPrompt?: boolean;
  throwHardErrorOnce?: boolean;
  shouldThrowHardError?: () => boolean;
  emitSandboxedTool?: string;
  onSandboxedTool?: () => void;
}

class FakeSession implements PiRuntimeSession {
  readonly prompts: string[] = [];
  readonly followUps: string[] = [];
  private readonly listeners = new Set<(event: unknown) => void>();
  running = false;
  disposed = false;
  private threwAlreadyProcessing = false;

  constructor(private readonly opts: FakeSessionOptions = {}) {}

  async prompt(
    text: string,
    _opts?: { streamingBehavior?: "steer" | "followUp" },
  ): Promise<void> {
    this.prompts.push(text);
    if (
      this.opts.throwAlreadyProcessingAfterFirstPrompt === true &&
      this.prompts.length > 1
    ) {
      throw new Error(
        "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
      );
    }
    if (
      this.opts.throwAlreadyProcessingOnce === true &&
      this.threwAlreadyProcessing === false
    ) {
      this.threwAlreadyProcessing = true;
      throw new Error(
        "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
      );
    }
    if (this.opts.shouldThrowHardError?.() === true) {
      throw new Error("hard runtime failure");
    }
    this.emit({ type: "agent_start" });
    if (this.opts.promptGate) await this.opts.promptGate;
    if (this.opts.emitSandboxedTool) {
      this.emit({
        type: "tool_execution_start",
        toolCallId: "toolu_fake",
        toolName: this.opts.emitSandboxedTool,
        args: {},
      });
      this.opts.onSandboxedTool?.();
      this.emit({
        type: "tool_execution_end",
        toolCallId: "toolu_fake",
        toolName: this.opts.emitSandboxedTool,
        result: { content: [{ type: "text", text: "tool ok" }] },
        isError: false,
      });
    }
    this.emitMessage(text);
    for (const followUp of this.followUps) {
      this.emitMessage(followUp);
    }
    this.emit({ type: "agent_end", messages: [], willRetry: false });
  }

  async followUp(text: string): Promise<void> {
    this.followUps.push(text);
  }

  async abort(): Promise<void> {}

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: unknown): void {
    const type = (event as { type?: unknown }).type;
    if (type === "agent_start") this.running = true;
    if (type === "agent_end") this.running = false;
    for (const listener of this.listeners) listener(event);
  }

  emitMessage(text: string): void {
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `reply: ${text}` }],
        stopReason: "stop",
      },
    });
  }
}

async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of source) out.push(event);
  return out;
}

function messageTexts(events: unknown[]): string[] {
  return events
    .map((event) => {
      if (typeof event !== "object" || event === null) return undefined;
      const message = (event as { message?: unknown }).message;
      if (typeof message !== "object" || message === null) return undefined;
      const blocks = (message as { content?: unknown }).content;
      if (!Array.isArray(blocks)) return undefined;
      return blocks
        .filter((block): block is { type: string; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
        )
        .map((block) => block.text)
        .join("");
    })
    .filter((text): text is string => text !== undefined && text.length > 0);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1_000) {
      throw new Error("timed out waiting for predicate");
    }
    await delay(5);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeSandboxProvider implements SandboxProvider {
  readonly cwd = "/workspace";
  readonly operations = {} as SandboxProvider["operations"];
  readonly tools = [];
  readonly toolNames: ReadonlySet<"bash" | "read" | "write" | "edit" | "find" | "ls">;
  readonly invocations = {
    total: 0,
    byTool: {
      bash: 0,
      read: 0,
      write: 0,
      edit: 0,
      find: 0,
      ls: 0,
    },
  };
  disposed = false;

  constructor(toolNames: Array<"bash" | "read" | "write" | "edit" | "find" | "ls">) {
    this.toolNames = new Set(toolNames);
  }

  recordInvocation(toolName: "bash" | "read" | "write" | "edit" | "find" | "ls"): void {
    this.invocations.total += 1;
    this.invocations.byTool[toolName] += 1;
  }

  dispose(): void {
    this.disposed = true;
  }
}
