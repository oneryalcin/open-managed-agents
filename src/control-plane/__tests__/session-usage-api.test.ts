import { describe, expect, it } from "vitest";
import { createInMemoryControlPlaneApp } from "./helpers.ts";
import { getSession, sendMessage, setupSession, waitForIdle } from "./api-helpers.ts";
import { translatePiEvent } from "../sessions/pi/translator.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";
import type {
  RuntimeEventRunner,
  RuntimeToolPermissionUseEvent,
  RuntimeMcpToolUseEvent,
  RuntimeMcpToolWithModelEndEvent,
  RuntimeToolPermissionWithModelEndEvent,
} from "../events/types.ts";

// Plan 0148: session usage on the API, from what Pi reports per model request.

interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost: number;
}

const modelMessage = (usage: Usage, content: unknown[]) => ({
  role: "assistant",
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-5",
  content,
  stopReason: "stop",
  usage: {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    cost: { total: usage.cost },
  },
});

const modelStart = () => ({
  type: "message_start",
  message: modelMessage({ input: 0, output: 0, cost: 0 }, []),
});

/** Each turn is one model request answering with text, using `usages[i]`. */
class PricedRunner implements RuntimeEventRunner {
  private turn = 0;
  constructor(private readonly usages: Usage[]) {}

  async *runUserMessage(): AsyncIterable<unknown> {
    const usage = this.usages[this.turn++]!;
    yield { type: "agent_start" };
    yield modelStart();
    yield { type: "message_end", message: modelMessage(usage, [{ type: "text", text: "ok" }]) };
    yield { type: "agent_end", messages: [] };
  }
}

/** One model request that ends in an allowed builtin tool call. */
class PricedToolPermissionRunner implements RuntimeEventRunner {
  constructor(private readonly usage: Usage) {}

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    yield modelStart();
    const permissionUse = {
      type: "oma.tool_permission_use",
      piToolCallId: "toolu_priced",
      name: "bash",
      input: { command: "true" },
      evaluatedPermission: "allow",
      bindToolUseId: () => {},
      rejectToolUse: () => {},
    } satisfies RuntimeToolPermissionUseEvent;
    yield {
      type: "oma.tool_permission_with_model_end",
      messageEnd: {
        type: "message_end",
        message: modelMessage(this.usage, [
          { type: "toolCall", id: "toolu_priced", name: "bash", arguments: { command: "true" } },
        ]),
      },
      permissionUse,
      suppressedPiToolCallIds: [],
    } satisfies RuntimeToolPermissionWithModelEndEvent;
    yield {
      type: "tool_execution_end",
      toolCallId: "toolu_priced",
      toolName: "bash",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    };
    yield { type: "agent_end", messages: [] };
  }
}

/** One model request that ends in an MCP tool call (denied, so nothing runs). */
class PricedMcpToolRunner implements RuntimeEventRunner {
  constructor(private readonly usage: Usage) {}

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    yield modelStart();
    yield {
      type: "oma.mcp_tool_with_model_end",
      messageEnd: {
        type: "message_end",
        message: modelMessage(this.usage, [
          { type: "toolCall", id: "toolu_mcp", name: "docs__search", arguments: {} },
        ]),
      },
      mcpToolUse: {
        type: "oma.mcp_tool_use",
        piToolCallId: "toolu_mcp",
        mcpServerName: "docs",
        name: "search",
        input: {},
        evaluatedPermission: "deny",
        bindToolUseId: () => {},
        rejectToolUse: () => {},
      } satisfies RuntimeMcpToolUseEvent,
      suppressedPiToolCallIds: [],
    } satisfies RuntimeMcpToolWithModelEndEvent;
    yield { type: "agent_end", messages: [] };
  }
}

async function sessionAfterTurns(runner: RuntimeEventRunner, turns: number) {
  const app = createInMemoryControlPlaneApp({ runtime: { runner, translate: translatePiEvent } });
  const session = await setupSession(app);
  for (let turn = 1; turn <= turns; turn += 1) {
    await sendMessage(app, session.id, `turn ${turn}`);
    await waitForIdle(app, session.id, turn);
  }
  return getSession(app, session.id);
}

// Probe 71's turn 1 on claude-sonnet-5: two requests, $0.0459 in all.
const PROBE_71: Usage[] = [
  { input: 2, output: 54, cacheWrite: 16600, cost: 0.0415 },
  { input: 2, output: 4, cacheRead: 16600, cacheWrite: 61, cost: 0.0044 },
];

describe("session usage API", () => {
  it("reports tokens summed over the session's model requests", async () => {
    const session = await sessionAfterTurns(new PricedRunner(PROBE_71), 2);

    expect(session.usage).toMatchObject({
      input_tokens: 4,
      output_tokens: 58,
      cache_read_input_tokens: 16600,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 16661 },
    });
  });

  it("reports list cost in cents, as hosted does", async () => {
    const session = await sessionAfterTurns(new PricedRunner(PROBE_71), 2);

    expect(session.usage.list_cost).toEqual({ amount: "5", currency: "USD" });
  });

  it("reports no list cost when a request's model has no known price", async () => {
    const session = await sessionAfterTurns(
      new PricedRunner([PROBE_71[0]!, { input: 10, output: 5, cost: 0 }]),
      2,
    );

    expect(session.usage.list_cost).toBeNull();
  });

  it("records the cost of a request that ends in a tool permission check", async () => {
    // Its span end is persisted by the tool-permission path, not the stream.
    const session = await sessionAfterTurns(new PricedToolPermissionRunner(PROBE_71[0]!), 1);

    expect(session.usage.list_cost).toEqual({ amount: "4", currency: "USD" });
  });

  it("records the cost of a request that ends in an MCP tool call", async () => {
    // Its span end is persisted by the MCP tool path.
    const session = await sessionAfterTurns(new PricedMcpToolRunner(PROBE_71[0]!), 1);

    expect(session.usage.list_cost).toEqual({ amount: "4", currency: "USD" });
  });

  it("still answers an archive whose session is deleted while cleanup runs", async () => {
    let releaseClose!: () => void;
    const closing = new Promise<void>((resolve) => { releaseClose = resolve; });
    const runner = new PricedRunner(PROBE_71);
    let closes = 0;
    // Only the archive's cleanup waits; the delete's goes straight through.
    Object.assign(runner, { closeSession: () => (closes++ === 0 ? closing : Promise.resolve()) });
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: translatePiEvent },
    });
    const session = await setupSession(app);

    const archive = app.request(`/v1/sessions/${session.id}/archive`, { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const deleted = await app.request(`/v1/sessions/${session.id}`, { method: "DELETE" });
    releaseClose();

    expect([deleted.status, (await archive).status]).toEqual([200, 200]);
  });

  it("reports the session's final usage in the archive response", async () => {
    const app = createInMemoryControlPlaneApp({
      runtime: { runner: new PricedRunner(PROBE_71), translate: translatePiEvent },
    });
    const session = await setupSession(app);
    await sendMessage(app, session.id, "turn 1");
    await waitForIdle(app, session.id, 1);

    const res = await app.request(`/v1/sessions/${session.id}/archive`, { method: "POST" });
    const archived = (await res.json()) as ManagedAgentsSession;

    expect(archived.usage.output_tokens).toBe(54);
  });
});
