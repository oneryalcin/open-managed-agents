import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedAgentsCustomTool } from "../../../../types/agents.ts";
import type {
  ManagedAgentsUserCustomToolResultEventInput,
  ManagedAgentsUserToolConfirmationEventInput,
} from "../../../../types/events.ts";
import type { PiRuntimeSession } from "../runner.ts";

const sdk = vi.hoisted(() => {
  class MockAuthStorage {
    static create(): Record<string, never> {
      return {};
    }
  }

  class MockModelRegistry {
    static create(): { find: () => { id: string } } {
      return { find: () => ({ id: "mock-model" }) };
    }
  }

  class MockSession implements PiRuntimeSession {
    readonly results: unknown[] = [];
    private readonly listeners = new Set<(event: unknown) => void>();

    constructor(
      private readonly customTools: MockToolDefinition[],
      private readonly activeToolNames: string[],
    ) {}

    async prompt(): Promise<void> {
      this.emit({ type: "agent_start" });
      const [tool] = this.customTools;
      if (!tool) throw new Error("missing mock custom tool");
      const result = await tool.execute(
        "toolu_mock_runner",
        { question: "continue?" },
        new AbortController().signal,
        undefined,
        {} as never,
      );
      this.results.push(result);
      this.emit({ type: "agent_end", messages: [], willRetry: false });
    }

    async followUp(): Promise<void> {}

    async abort(): Promise<void> {}

    dispose(): void {
      this.listeners.clear();
    }

    subscribe(listener: (event: unknown) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    getActiveToolNames(): string[] {
      return this.activeToolNames;
    }

    private emit(event: unknown): void {
      for (const listener of this.listeners) listener(event);
    }
  }

  type MockToolDefinition = {
    name: string;
    execute: (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal,
      onUpdate: undefined,
      ctx: never,
    ) => Promise<unknown>;
  };

  let lastSession: MockSession | undefined;
  let lastCreateOptions: MockCreateOptions | undefined;

  type MockCreateOptions = {
    noTools?: "all" | "builtin";
    tools?: string[];
    customTools?: MockToolDefinition[];
  };

  return {
    AuthStorage: MockAuthStorage,
    ModelRegistry: MockModelRegistry,
    SessionManager: { inMemory: vi.fn(() => ({})) },
    defineTool: vi.fn((tool: MockToolDefinition) => tool),
    createAgentSession: vi.fn(
      async (opts: MockCreateOptions) => {
        lastCreateOptions = opts;
        lastSession = new MockSession(opts.customTools ?? [], opts.tools ?? []);
        return { session: lastSession };
      },
    ),
    lastSession: () => lastSession,
    lastCreateOptions: () => lastCreateOptions,
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: sdk.AuthStorage,
  createAgentSession: sdk.createAgentSession,
  defineTool: sdk.defineTool,
  ModelRegistry: sdk.ModelRegistry,
  SessionManager: sdk.SessionManager,
}));

import { PiSessionRunner } from "../runner.ts";
import type { SandboxProvider } from "../sandbox/provider.ts";

describe("PiSessionRunner custom-tool bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds a public custom-tool event ID and resumes the Pi tool through the runner path", async () => {
    const released: string[] = [];
    const runner = new PiSessionRunner({
      customTools: () => [ASK_USER],
      customToolTimeoutMs: 0,
      idleTtlMs: 0,
    });

    const iterator = runner
      .runUserMessage("wrk_default", "sesn_runner_tool", "ask")
      [Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ type: "agent_start" });

    const toolUse = (await iterator.next()).value;
    expect(toolUse).toMatchObject({
      type: "oma.custom_tool_use",
      piToolCallId: "toolu_mock_runner",
      name: "ask_user",
      input: { question: "continue?" },
    });

    toolUse.bindCustomToolUseId("sevt_runner_tool", () => {
      released.push("sevt_runner_tool");
    });
    const commit = runner.claimCustomToolResult("wrk_default", "sesn_runner_tool", {
      type: "user.custom_tool_result",
      custom_tool_use_id: "sevt_runner_tool",
      content: [{ type: "text", text: "yes" }],
    } satisfies ManagedAgentsUserCustomToolResultEventInput);
    expect(commit).toBeTypeOf("function");
    commit?.();

    expect((await iterator.next()).value).toEqual({
      type: "agent_end",
      messages: [],
      willRetry: false,
    });
    expect((await iterator.next()).done).toBe(true);
    expect(sdk.lastSession()?.results).toEqual([
      { content: [{ type: "text", text: "yes" }], details: {} },
    ]);
    expect(released).toEqual(["sevt_runner_tool"]);
  });

  it("registers sandbox tools through public customTools and an exact tools allowlist", async () => {
    const sandboxTool = {
      name: "bash",
      execute: vi.fn(),
    };
    const runner = new PiSessionRunner({
      customTools: () => [ASK_USER],
      sandboxProviderFactory: async () =>
        ({
          cwd: "/workspace",
          operations: {},
          tools: [sandboxTool] as unknown as SandboxProvider["tools"],
          toolNames: new Set(["bash"]),
          invocations: {
            total: 0,
            byTool: {
              bash: 0,
              read: 0,
              write: 0,
              edit: 0,
              find: 0,
              ls: 0,
            },
          },
          dispose: vi.fn(),
        }) as unknown as SandboxProvider,
      customToolTimeoutMs: 0,
      idleTtlMs: 0,
    });

    const iterator = runner
      .runUserMessage("wrk_default", "sesn_sandbox", "run")
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "agent_start" });
    const toolUse = (await iterator.next()).value;
    expect(toolUse).toMatchObject({
      type: "oma.tool_permission_use",
      piToolCallId: "toolu_mock_runner",
      name: "bash",
      input: { question: "continue?" },
      evaluatedPermission: "allow",
    });
    toolUse.bindToolUseId("sevt_builtin_tool", () => {});
    expect((await iterator.next()).value).toEqual({
      type: "agent_end",
      messages: [],
      willRetry: false,
    });
    expect((await iterator.next()).done).toBe(true);

    expect(sdk.lastCreateOptions()).toMatchObject({
      noTools: "builtin",
      tools: ["bash", "ask_user"],
    });
    expect(sdk.lastCreateOptions()?.customTools?.map((tool) => tool.name)).toEqual([
      "bash",
      "ask_user",
    ]);
    expect(sandboxTool.execute).toHaveBeenCalledOnce();
  });

  it("pauses always_ask builtin tools until a tool_confirmation is committed", async () => {
    const sandboxTool = {
      name: "bash",
      execute: vi.fn(async () => ({ content: [], details: {} })),
    };
    const runner = new PiSessionRunner({
      sandboxProviderFactory: async () =>
        ({
          cwd: "/workspace",
          operations: {},
          tools: [sandboxTool] as unknown as SandboxProvider["tools"],
          toolNames: new Set(["bash"]),
          invocations: {
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
              bash: new Set(),
              read: new Set(),
              write: new Set(),
              edit: new Set(),
              find: new Set(),
              ls: new Set(),
            },
          },
          dispose: vi.fn(),
        }) as unknown as SandboxProvider,
      builtinToolAccess: () => ({ enabled: true, permission: "ask" }),
      customToolTimeoutMs: 0,
      idleTtlMs: 0,
    });

    const iterator = runner
      .runUserMessage("wrk_default", "sesn_builtin_ask", "run")
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "agent_start" });
    const toolUse = (await iterator.next()).value;
    expect(toolUse).toMatchObject({
      type: "oma.tool_permission_use",
      piToolCallId: "toolu_mock_runner",
      name: "bash",
      evaluatedPermission: "ask",
    });
    toolUse.bindToolUseId("sevt_builtin_ask", () => {});
    expect(sandboxTool.execute).not.toHaveBeenCalled();
    const resumed = iterator.next();
    await Promise.resolve();

    const commit = runner.claimToolConfirmation("wrk_default", "sesn_builtin_ask", {
      type: "user.tool_confirmation",
      tool_use_id: "sevt_builtin_ask",
      result: "allow",
    } satisfies ManagedAgentsUserToolConfirmationEventInput);
    expect(commit).toBeTypeOf("function");
    commit?.();

    expect((await resumed).value).toEqual({
      type: "agent_end",
      messages: [],
      willRetry: false,
    });
    expect((await iterator.next()).done).toBe(true);
    expect(sandboxTool.execute).toHaveBeenCalledOnce();
  });

  it("denies never_allow builtin tools without invoking the sandbox provider", async () => {
    const sandboxTool = {
      name: "bash",
      execute: vi.fn(async () => ({ content: [], details: {} })),
    };
    const runner = new PiSessionRunner({
      sandboxProviderFactory: async () =>
        ({
          cwd: "/workspace",
          operations: {},
          tools: [sandboxTool] as unknown as SandboxProvider["tools"],
          toolNames: new Set(["bash"]),
          invocations: {
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
              bash: new Set(),
              read: new Set(),
              write: new Set(),
              edit: new Set(),
              find: new Set(),
              ls: new Set(),
            },
          },
          dispose: vi.fn(),
        }) as unknown as SandboxProvider,
      builtinToolAccess: () => ({ enabled: true, permission: "deny" }),
      customToolTimeoutMs: 0,
      idleTtlMs: 0,
    });

    const iterator = runner
      .runUserMessage("wrk_default", "sesn_builtin_deny", "run")
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "agent_start" });
    const toolUse = (await iterator.next()).value;
    expect(toolUse).toMatchObject({
      type: "oma.tool_permission_use",
      piToolCallId: "toolu_mock_runner",
      name: "bash",
      evaluatedPermission: "deny",
    });
    toolUse.bindToolUseId("sevt_builtin_deny", () => {});

    await expect(iterator.next()).rejects.toThrow("denied by policy");
    expect(sandboxTool.execute).not.toHaveBeenCalled();
  });

  it("omits disabled builtin tools from Pi customTools and the active allowlist", async () => {
    const bashTool = {
      name: "bash",
      execute: vi.fn(async () => ({ content: [], details: {} })),
    };
    const readTool = {
      name: "read",
      execute: vi.fn(async () => ({ content: [], details: {} })),
    };
    const runner = new PiSessionRunner({
      sandboxProviderFactory: async () =>
        ({
          cwd: "/workspace",
          operations: {},
          tools: [bashTool, readTool] as unknown as SandboxProvider["tools"],
          toolNames: new Set(["bash", "read"]),
          invocations: {
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
              bash: new Set(),
              read: new Set(),
              write: new Set(),
              edit: new Set(),
              find: new Set(),
              ls: new Set(),
            },
          },
          dispose: vi.fn(),
        }) as unknown as SandboxProvider,
      builtinToolAccess: (_workspaceId, _sessionId, toolName) => ({
        enabled: toolName !== "read",
        permission: "allow",
      }),
      customToolTimeoutMs: 0,
      idleTtlMs: 0,
    });

    const iterator = runner
      .runUserMessage("wrk_default", "sesn_disabled", "run")
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "agent_start" });
    const toolUse = (await iterator.next()).value;
    toolUse.bindToolUseId("sevt_builtin_allow", () => {});
    expect((await iterator.next()).value).toEqual({
      type: "agent_end",
      messages: [],
      willRetry: false,
    });
    expect((await iterator.next()).done).toBe(true);

    expect(sdk.lastCreateOptions()?.tools).toEqual(["bash"]);
    expect(sdk.lastCreateOptions()?.customTools?.map((tool) => tool.name)).toEqual([
      "bash",
    ]);
  });
});

const ASK_USER: ManagedAgentsCustomTool = {
  type: "custom",
  name: "ask_user",
  input_schema: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  },
};

async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of source) out.push(event);
  return out;
}
