import { describe, expect, it, vi } from "vitest";
import type { ManagedAgentsCustomTool } from "../../../../types/agents.ts";
import type { ManagedAgentsUserCustomToolResultEventInput } from "../../../../types/events.ts";
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

    constructor(private readonly customTools: MockToolDefinition[]) {}

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

  return {
    AuthStorage: MockAuthStorage,
    ModelRegistry: MockModelRegistry,
    SessionManager: { inMemory: vi.fn(() => ({})) },
    defineTool: vi.fn((tool: MockToolDefinition) => tool),
    createAgentSession: vi.fn(
      async (opts: { customTools?: MockToolDefinition[] }) => {
        lastSession = new MockSession(opts.customTools ?? []);
        return { session: lastSession };
      },
    ),
    lastSession: () => lastSession,
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

describe("PiSessionRunner custom-tool bridge", () => {
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
