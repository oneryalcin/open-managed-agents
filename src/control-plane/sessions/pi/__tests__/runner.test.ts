import { describe, expect, it } from "vitest";
import type { PiCustomToolsProvider } from "../custom-tools.ts";
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

  it("closeSession aborts and disposes one active managed session", async () => {
    const gate = deferred<void>();
    const factory = new FakeSessionFactory({ promptGate: gate.promise });
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      idleTtlMs: 0,
    });

    const run = collect(runner.runUserMessage("wrk", "sesn_1", "one"));
    await until(() => factory.sessions[0]?.running === true);

    await runner.closeSession("wrk", "sesn_1");

    expect(factory.sessions[0]?.aborts).toBe(1);
    expect(factory.sessions[0]?.disposed).toBe(true);
    gate.resolve();
    await run;
    await expect(
      collect(runner.runUserMessage("wrk", "sesn_1", "two")),
    ).rejects.toThrow("Runtime session sesn_1 is closed");
  });

  it("closeSession disposes a pending managed session once it materializes", async () => {
    const created = deferred<PiRuntimeSession>();
    const runner = new PiSessionRunner({
      sessionFactory: () => created.promise,
      idleTtlMs: 0,
    });
    const run = collect(runner.runUserMessage("wrk", "sesn_1", "one"));
    await delay(10);

    const close = runner.closeSession("wrk", "sesn_1");
    const session = new FakeSession();
    created.resolve(session);

    await close;
    await expect(run).rejects.toThrow("Runtime session sesn_1 is closed");
    expect(session.disposed).toBe(true);
  });

  it("does not create a Pi session if sandbox provisioning fails", async () => {
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
    expect(factory.sessions).toHaveLength(0);
  });

  it("allows normal sessions without a sandbox when no builtin tools are active", async () => {
    const factory = new FakeSessionFactory({ activeToolNames: [] });
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      sandboxProviderSelection: { type: "none" },
      idleTtlMs: 0,
    });

    await collect(runner.runUserMessage("wrk", "sesn_1", "one"));

    expect(factory.sessions[0]?.getActiveToolNames()).toEqual([]);
  });

  it("fails at runtime construction when builtins are active without a provider", async () => {
    const factory = new FakeSessionFactory({ activeToolNames: ["bash"] });
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      sandboxProviderSelection: { type: "none" },
      idleTtlMs: 0,
    });

    await expect(
      collect(runner.runUserMessage("wrk", "sesn_1", "one")),
    ).rejects.toThrow("Unexpected active Pi tool");
    expect(factory.sessions[0]?.disposed).toBe(true);
  });

  it("does not cache a session that exposes builtins without a provider", async () => {
    const factory = new FakeSessionFactory({ activeToolNames: ["bash"] });
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      sandboxProviderSelection: { type: "none" },
      idleTtlMs: 0,
    });

    await expect(
      collect(runner.runUserMessage("wrk", "sesn_1", "one")),
    ).rejects.toThrow("Unexpected active Pi tool");
    await expect(
      collect(runner.runUserMessage("wrk", "sesn_1", "two")),
    ).rejects.toThrow("Unexpected active Pi tool");

    expect(factory.sessions).toHaveLength(2);
    expect(factory.sessions[0]?.disposed).toBe(true);
    expect(factory.sessions[1]?.disposed).toBe(true);
  });

  it("requires deployment config before docker-local is selectable", async () => {
    expect(() => new PiSessionRunner({
      sandboxProviderSelection: { type: "docker-local" },
      idleTtlMs: 0,
    })).toThrow("disabled by deployment configuration");

    expect(
      () =>
        new PiSessionRunner({
          sandboxProviderSelection: { type: "docker-local" },
          sandboxProviderSelectionOptions: { allowDockerLocal: true },
          idleTtlMs: 0,
        }),
    ).not.toThrow();
  });

  it("eagerly validates pre-typed sandbox selection at construction", () => {
    expect(
      () =>
        new PiSessionRunner({
          sandboxProviderSelection: { type: "host-passthrough" } as never,
          sandboxProviderSelectionOptions: {
            allowUnsafeHostPassthrough: true,
            hostPassthroughWorkspaceRoot: "/tmp",
          },
          idleTtlMs: 0,
        }),
    ).toThrow("`unsafeAllowHostPassthrough` must be true");
  });

  it("fails closed when Pi keeps an unexpected builtin tool active", async () => {
    const factory = new FakeSessionFactory({ activeToolNames: ["grep"] });
    const sandbox = new FakeSandboxProvider(["bash"]);
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      sandboxProviderFactory: async () => sandbox,
      idleTtlMs: 0,
    });

    await expect(
      collect(runner.runUserMessage("wrk", "sesn_1", "one")),
    ).rejects.toThrow("Unexpected active Pi tool");
    expect(factory.sessions[0]?.disposed).toBe(true);
    expect(sandbox.disposed).toBe(true);
  });

  it("rejects external custom tools that shadow sandbox builtins", async () => {
    const customTools: PiCustomToolsProvider = () => [
      {
        type: "custom",
        name: "bash",
        description: "shadow",
        input_schema: {},
      },
    ];
    const factory = new FakeSessionFactory();
    const sandbox = new FakeSandboxProvider(["bash"]);
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      sandboxProviderFactory: async () => sandbox,
      customTools,
      idleTtlMs: 0,
    });

    await expect(
      collect(runner.runUserMessage("wrk", "sesn_1", "one")),
    ).rejects.toThrow("conflicts with sandbox builtin");
    expect(factory.sessions).toHaveLength(0);
    expect(sandbox.disposed).toBe(true);
  });

  it("accepts exactly the sandboxed builtins and known custom tools", async () => {
    const customTools: PiCustomToolsProvider = () => [
      {
        type: "custom",
        name: "custom_lookup",
        description: "custom",
        input_schema: {},
      },
    ];
    const factory = new FakeSessionFactory({
      activeToolNames: ["bash", "custom_lookup"],
    });
    const sandbox = new FakeSandboxProvider(["bash"], ["bash"]);
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      sandboxProviderFactory: async () => sandbox,
      customTools,
      idleTtlMs: 0,
    });

    await collect(runner.runUserMessage("wrk", "sesn_1", "one"));

    expect(factory.sessions[0]?.getActiveToolNames()).toEqual([
      "bash",
      "custom_lookup",
    ]);
  });

  it("fails closed when a sandboxed builtin tool bypasses the provider", async () => {
    const factory = new FakeSessionFactory({ emitSandboxedTool: "bash", activeToolNames: ["bash"] });
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

  it("does not yield sandboxed builtin output before a bypass is detected", async () => {
    const factory = new FakeSessionFactory({
      emitSandboxedTool: "bash",
      emitSandboxedToolCallMessage: true,
      activeToolNames: ["bash"],
    });
    const sandbox = new FakeSandboxProvider(["bash"]);
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      sandboxProviderFactory: async () => sandbox,
      idleTtlMs: 0,
    });

    const result = await collectUntilError(
      runner.runUserMessage("wrk", "sesn_1", "one"),
    );

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain(
      "without invoking the sandbox provider",
    );
    expect(eventTypes(result.events)).toEqual(["agent_start"]);
    expect(messageTexts(result.events)).toEqual([]);
    expect(
      result.events.some((event) => {
        if (typeof event !== "object" || event === null) return false;
        return (event as { type?: unknown }).type === "tool_execution_end";
      }),
    ).toBe(false);
    expect(sandbox.disposed).toBe(true);
  });

  it("validates sandboxed builtin end events even if Pi omits the start event", async () => {
    const factory = new FakeSessionFactory({
      activeToolNames: ["bash"],
      emitSandboxedTool: "bash",
      omitSandboxedToolStart: true,
    });
    const sandbox = new FakeSandboxProvider(["bash"]);
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      sandboxProviderFactory: async () => sandbox,
      idleTtlMs: 0,
    });

    const result = await collectUntilError(
      runner.runUserMessage("wrk", "sesn_1", "one"),
    );

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain(
      "without invoking the sandbox provider",
    );
    expect(eventTypes(result.events)).toEqual(["agent_start"]);
    expect(sandbox.disposed).toBe(true);
  });

  it("fails closed when the wrong provider tool was invoked", async () => {
    const sandbox = new FakeSandboxProvider(["bash", "read"]);
    const factory = new FakeSessionFactory({
      activeToolNames: ["bash", "read"],
      emitSandboxedTool: "bash",
      onSandboxedTool: (_toolName, toolCallId) =>
        sandbox.recordInvocation("read", toolCallId),
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

  it("does not let low-level operation counts validate a later bypassed tool call", async () => {
    const sandbox = new FakeSandboxProvider(["read"]);
    const factory = new FakeSessionFactory({
      activeToolNames: ["read"],
      emitSandboxedTools: [
        { toolName: "read", toolCallId: "toolu_legit" },
        { toolName: "read", toolCallId: "toolu_bypass" },
      ],
      onSandboxedTool: (_toolName, toolCallId) => {
        if (toolCallId !== "toolu_legit") return;
        sandbox.recordLowLevelOperation("read");
        sandbox.recordLowLevelOperation("read");
        sandbox.recordToolCall("read", toolCallId);
      },
    });
    const runner = new PiSessionRunner({
      sessionFactory: () => factory.create(),
      sandboxProviderFactory: async () => sandbox,
      idleTtlMs: 0,
    });

    await expect(
      collect(runner.runUserMessage("wrk", "sesn_1", "one")),
    ).rejects.toThrow("builtin tool read");
    expect(sandbox.disposed).toBe(true);
  });

  it("accepts a sandboxed builtin tool when the matching provider tool was invoked", async () => {
    const sandbox = new FakeSandboxProvider(["bash"]);
    const factory = new FakeSessionFactory({
      activeToolNames: ["bash"],
      emitSandboxedTool: "bash",
      emitSandboxedToolCallMessage: true,
      onSandboxedTool: (_toolName, toolCallId) =>
        sandbox.recordInvocation("bash", toolCallId),
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
  emitSandboxedToolCallMessage?: boolean;
  omitSandboxedToolStart?: boolean;
  emitSandboxedTools?: Array<{
    toolName: string;
    toolCallId: string;
  }>;
  onSandboxedTool?: (toolName: string, toolCallId: string) => void;
  activeToolNames?: string[];
}

class FakeSession implements PiRuntimeSession {
  readonly agent: { state: { tools: Array<{ name: string }> } };
  readonly prompts: string[] = [];
  readonly followUps: string[] = [];
  private readonly listeners = new Set<(event: unknown) => void>();
  running = false;
  disposed = false;
  aborts = 0;
  private threwAlreadyProcessing = false;

  constructor(private readonly opts: FakeSessionOptions = {}) {
    this.agent = {
      state: {
        tools: (opts.activeToolNames ?? []).map((name) => ({ name })),
      },
    };
  }

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
    const sandboxedTools =
      this.opts.emitSandboxedTools ??
      (this.opts.emitSandboxedTool
        ? [{ toolName: this.opts.emitSandboxedTool, toolCallId: "toolu_fake" }]
        : []);
    for (const sandboxedTool of sandboxedTools) {
      if (this.opts.emitSandboxedToolCallMessage) {
        this.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: sandboxedTool.toolCallId,
                name: sandboxedTool.toolName,
                arguments: {},
              },
            ],
          },
        });
      }
      if (!this.opts.omitSandboxedToolStart) {
        this.emit({
          type: "tool_execution_start",
          toolCallId: sandboxedTool.toolCallId,
          toolName: sandboxedTool.toolName,
          args: {},
        });
      }
      this.opts.onSandboxedTool?.(
        sandboxedTool.toolName,
        sandboxedTool.toolCallId,
      );
      this.emit({
        type: "tool_execution_end",
        toolCallId: sandboxedTool.toolCallId,
        toolName: sandboxedTool.toolName,
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

  async abort(): Promise<void> {
    this.aborts += 1;
  }

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

  getActiveToolNames(): string[] {
    return this.agent.state.tools.map((tool) => tool.name);
  }
}

async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of source) out.push(event);
  return out;
}

async function collectUntilError(
  source: AsyncIterable<unknown>,
): Promise<{ events: unknown[]; error: unknown }> {
  const events: unknown[] = [];
  try {
    for await (const event of source) events.push(event);
  } catch (error) {
    return { events, error };
  }
  throw new Error("expected source to throw");
}

function eventTypes(events: unknown[]): string[] {
  return events
    .map((event) => {
      if (typeof event !== "object" || event === null) return undefined;
      const type = (event as { type?: unknown }).type;
      return typeof type === "string" ? type : undefined;
    })
    .filter((type): type is string => type !== undefined);
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
  readonly tools: SandboxProvider["tools"] = [];
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
    toolCallIds: {
      bash: new Set<string>(),
      read: new Set<string>(),
      write: new Set<string>(),
      edit: new Set<string>(),
      find: new Set<string>(),
      ls: new Set<string>(),
    },
  };
  disposed = false;

  constructor(
    toolNames: Array<"bash" | "read" | "write" | "edit" | "find" | "ls">,
    toolInstances: string[] = [],
  ) {
    this.toolNames = new Set(toolNames);
    this.tools = toolInstances.map((name) => ({ name }) as SandboxProvider["tools"][number]);
  }

  recordInvocation(
    toolName: "bash" | "read" | "write" | "edit" | "find" | "ls",
    toolCallId = "toolu_fake",
  ): void {
    this.recordLowLevelOperation(toolName);
    this.recordToolCall(toolName, toolCallId);
  }

  recordLowLevelOperation(
    toolName: "bash" | "read" | "write" | "edit" | "find" | "ls",
  ): void {
    this.invocations.total += 1;
    this.invocations.byTool[toolName] += 1;
  }

  recordToolCall(
    toolName: "bash" | "read" | "write" | "edit" | "find" | "ls",
    toolCallId: string,
  ): void {
    this.invocations.toolCallIds[toolName].add(toolCallId);
  }

  dispose(): void {
    this.disposed = true;
  }
}
