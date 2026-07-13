// Plan 0122 §5 — MCP events e2e: the REAL bridge (McpConnection +
// createMcpToolDefinitions + PiToolPermissionBridge) drives the REAL app
// over HTTP against the in-process MCP fixture. Only the Pi model loop is
// faked (the runner generator stands in for runOnSession); the full-runner
// side is covered by sessions/pi/__tests__/runner-mcp.test.ts and the live
// probe (§5).
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryControlPlaneApp } from "./helpers.ts";
import type { ManagedAgentsAgent } from "../../types/agents.ts";
import type { ManagedAgentsEnvironment } from "../../types/environments.ts";
import type { ManagedAgentsSession } from "../../types/sessions.ts";
import type { ManagedAgentsUserToolConfirmationEventInput } from "../../types/events.ts";
import type {
  RuntimeEventRunner,
  RuntimeInternalEvent,
} from "../events/types.ts";
import { translatePiEvent } from "../sessions/pi/translator.ts";
import { PiToolPermissionBridge } from "../sessions/pi/tool-permissions.ts";
import { McpConnection } from "../sessions/pi/mcp/client.ts";
import { createGuardedMcpFetch } from "../sessions/pi/mcp/fetch.ts";
import {
  createMcpToolDefinitions,
  type McpEmitter,
} from "../sessions/pi/mcp/bridge.ts";
import {
  echoTool,
  startMcpFixture,
  type McpFixture,
} from "../sessions/pi/mcp/__tests__/fixture.ts";
import { STREAM_TEST_TIMEOUT_MS, hasTimedOut } from "./test-timeouts.ts";

const seamFetch = createGuardedMcpFetch({ allowAddress: () => true });

type App = ReturnType<typeof createInMemoryControlPlaneApp>;

let fixture: McpFixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

/**
 * Fake ONLY the Pi loop: runUserMessage connects to the fixture, builds the
 * real MCP ToolDefinitions, executes the requested calls, and yields every
 * internal event the real bridge emits — exactly what runOnSession would
 * forward to the events service.
 */
class McpBridgeRunner implements RuntimeEventRunner {
  readonly permissionBridge = new PiToolPermissionBridge({ timeoutMs: 5_000 });
  private queue: unknown[] = [];
  private wake: (() => void) | undefined;
  private readonly emitter: McpEmitter = (event) => {
    this.queue.push(event);
    this.wake?.();
  };

  constructor(
    private readonly opts: {
      fixtureUrl: string;
      permission: "allow" | "ask" | "deny";
      calls?: Array<{ piToolCallId: string; args: Record<string, unknown> }>;
    },
  ) {}

  async *runUserMessage(
    workspaceId: string,
    sessionId: string,
  ): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    const connection = await McpConnection.connect(
      { name: "srv", url: this.opts.fixtureUrl },
      { fetch: seamFetch },
    );
    try {
      const tools = createMcpToolDefinitions({
        workspaceId,
        sessionId,
        connection,
        permissionBridge: this.permissionBridge,
        getEmitter: () => this.emitter,
        access: () => ({ enabled: true, permission: this.opts.permission }),
      });
      const calls = this.opts.calls ?? [
        { piToolCallId: "toolu_mcp_1", args: { text: "hi" } },
      ];
      let settled = 0;
      const executions = calls.map((call) =>
        tools[0]
          .execute(call.piToolCallId, call.args as never, undefined, undefined, undefined as never)
          .catch(() => undefined) // deny/error surface to the model as throws
          .finally(() => {
            settled += 1;
            this.wake?.();
          }),
      );
      while (settled < executions.length || this.queue.length > 0) {
        if (this.queue.length > 0) {
          yield this.queue.shift();
          continue;
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
      }
      await Promise.all(executions);
    } finally {
      await connection.close();
    }
    yield { type: "agent_end", messages: [], willRetry: false };
  }

  claimToolConfirmation(
    workspaceId: string,
    sessionId: string,
    event: ManagedAgentsUserToolConfirmationEventInput,
  ): (() => void) | undefined {
    return this.permissionBridge.claimConfirmation(workspaceId, sessionId, event);
  }

  customToolNames(): ReadonlySet<string> {
    return new Set(["mcp__srv__echo"]);
  }

  publicToolUseIdForPiToolCallId(
    _workspaceId: string,
    sessionId: string,
    piToolCallId: string,
  ): string | undefined {
    return this.permissionBridge.publicToolUseIdForPiToolCallId(
      sessionId,
      piToolCallId,
    );
  }

  suppressPiToolUse(
    _workspaceId: string,
    sessionId: string,
    piToolCallId: string,
  ): boolean {
    return this.permissionBridge.suppressPiToolUse(sessionId, piToolCallId);
  }
}

/** Yields a fixed event script — for persistence-shape cases. */
class ScriptedRunner implements RuntimeEventRunner {
  constructor(
    private readonly events: readonly unknown[],
    private readonly toolNames: readonly string[] = [],
  ) {}

  async *runUserMessage(): AsyncIterable<unknown> {
    yield { type: "agent_start" };
    for (const event of this.events) yield event;
    yield { type: "agent_end", messages: [], willRetry: false };
  }

  customToolNames(): ReadonlySet<string> {
    return new Set(this.toolNames);
  }
}

describe("MCP events e2e (plan 0122 §5)", () => {
  it("allow flow: mcp_tool_use binds before the call, result correlates, no generic tool events", async () => {
    fixture = await startMcpFixture([echoTool()]);
    const runner = new McpBridgeRunner({
      fixtureUrl: fixture.url,
      permission: "allow",
    });
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: translatePiEvent },
    });
    const session = await setupSession(app, fixture.url);

    await sendMessage(app, session.id, "call the tool");
    const events = await eventuallyEvents(app, session.id, (all) =>
      all.some((event) => event.type === "agent.mcp_tool_result"),
    );

    const use = events.find((event) => event.type === "agent.mcp_tool_use");
    expect(use).toMatchObject({
      mcp_server_name: "srv",
      name: "echo", // bare name on the wire, not mcp__srv__echo
      input: { text: "hi" },
      evaluated_permission: "allow",
      session_thread_id: null, // probe 47: hosted emits this field
    });
    expect(use?.id).toEqual(expect.stringMatching(/^sevt_/));

    const result = events.find(
      (event) => event.type === "agent.mcp_tool_result",
    );
    expect(result).toMatchObject({
      mcp_tool_use_id: use?.id,
      is_error: false,
      content: [{ type: "text", text: "echo: hi" }],
    });

    expect(events.some((event) => event.type === "agent.tool_use")).toBe(false);
    expect(events.some((event) => event.type === "agent.tool_result")).toBe(
      false,
    );
    expect(fixture.toolCalls).toEqual([{ name: "echo", args: { text: "hi" } }]);
  });

  it("ask flow: requires_action lists the mcp use id, allow resumes, replay is idempotent", async () => {
    fixture = await startMcpFixture([echoTool()]);
    const runner = new McpBridgeRunner({
      fixtureUrl: fixture.url,
      permission: "ask",
    });
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: translatePiEvent },
    });
    const session = await setupSession(app, fixture.url);

    await sendMessage(app, session.id, "call the tool");
    const waiting = await eventuallyEvents(app, session.id, (all) =>
      all.some(
        (event) =>
          event.type === "session.status_idle" &&
          (event.stop_reason as { type?: unknown } | undefined)?.type ===
            "requires_action",
      ),
    );
    const use = waiting.find((event) => event.type === "agent.mcp_tool_use");
    expect(use).toMatchObject({ evaluated_permission: "ask" });
    const requiresAction = waiting.find(
      (event) =>
        event.type === "session.status_idle" &&
        (event.stop_reason as { type?: unknown } | undefined)?.type ===
          "requires_action",
    );
    expect(requiresAction?.stop_reason).toEqual({
      type: "requires_action",
      event_ids: [use?.id],
    });
    expect(fixture.toolCalls).toEqual([]); // nothing executed while paused

    const confirmation: ManagedAgentsUserToolConfirmationEventInput = {
      type: "user.tool_confirmation",
      tool_use_id: use?.id as string,
      result: "allow",
    };
    await sendEvents(app, session.id, [confirmation]);
    const completed = await eventuallyEvents(app, session.id, (all) =>
      all.some((event) => event.type === "agent.mcp_tool_result"),
    );
    expect(
      completed.find((event) => event.type === "agent.mcp_tool_result"),
    ).toMatchObject({ mcp_tool_use_id: use?.id, is_error: false });
    expect(fixture.toolCalls).toHaveLength(1);

    // Re-sent confirmation after completion: idempotent accept (the
    // completed-detection scan must recognize agent.mcp_tool_result).
    const replay = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [confirmation] }),
    });
    expect(replay.status).toBe(200);
    expect(fixture.toolCalls).toHaveLength(1); // not executed twice
  });

  it("ask + deny: deny message becomes the error result, zero executions", async () => {
    fixture = await startMcpFixture([echoTool()]);
    const runner = new McpBridgeRunner({
      fixtureUrl: fixture.url,
      permission: "ask",
    });
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: translatePiEvent },
    });
    const session = await setupSession(app, fixture.url);

    await sendMessage(app, session.id, "call the tool");
    const waiting = await eventuallyEvents(app, session.id, (all) =>
      all.some((event) => event.type === "agent.mcp_tool_use"),
    );
    const use = waiting.find((event) => event.type === "agent.mcp_tool_use");
    await sendEvents(app, session.id, [
      {
        type: "user.tool_confirmation",
        tool_use_id: use?.id as string,
        result: "deny",
        deny_message: "use the sandbox instead",
      },
    ]);
    const completed = await eventuallyEvents(app, session.id, (all) =>
      all.some((event) => event.type === "agent.mcp_tool_result"),
    );
    expect(
      completed.find((event) => event.type === "agent.mcp_tool_result"),
    ).toMatchObject({
      mcp_tool_use_id: use?.id,
      is_error: true,
      content: [{ type: "text", text: "use the sandbox instead" }],
    });
    expect(fixture.toolCalls).toEqual([]);
  });

  it("two parallel asks get distinct sevt ids and independent confirmations", async () => {
    fixture = await startMcpFixture([echoTool()]);
    const runner = new McpBridgeRunner({
      fixtureUrl: fixture.url,
      permission: "ask",
      calls: [
        { piToolCallId: "toolu_mcp_a", args: { text: "a" } },
        { piToolCallId: "toolu_mcp_b", args: { text: "b" } },
      ],
    });
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: translatePiEvent },
    });
    const session = await setupSession(app, fixture.url);

    await sendMessage(app, session.id, "call both");
    const waiting = await eventuallyEvents(
      app,
      session.id,
      (all) =>
        all.filter((event) => event.type === "agent.mcp_tool_use").length === 2,
    );
    const uses = waiting.filter((event) => event.type === "agent.mcp_tool_use");
    expect(new Set(uses.map((use) => use.id)).size).toBe(2);

    for (const use of uses) {
      await sendEvents(app, session.id, [
        {
          type: "user.tool_confirmation",
          tool_use_id: use.id as string,
          result: "allow",
        },
      ]);
    }
    const completed = await eventuallyEvents(
      app,
      session.id,
      (all) =>
        all.filter((event) => event.type === "agent.mcp_tool_result").length ===
        2,
    );
    const results = completed.filter(
      (event) => event.type === "agent.mcp_tool_result",
    );
    expect(new Set(results.map((result) => result.mcp_tool_use_id))).toEqual(
      new Set(uses.map((use) => use.id)),
    );
    expect(fixture.toolCalls).toHaveLength(2);
  });

  it("persists connection failures as session.error with structured retry_status", async () => {
    const runner = new ScriptedRunner([
      {
        type: "oma.mcp_connection_failed",
        mcpServerName: "srv",
        message: "connect ECONNREFUSED",
        retryStatus: "retrying",
      } satisfies RuntimeInternalEvent,
    ]);
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: translatePiEvent },
    });
    const session = await setupSession(app);

    await sendMessage(app, session.id, "hello");
    const events = await eventuallyEvents(app, session.id, (all) =>
      all.some((event) => event.type === "session.error"),
    );
    expect(
      events.find((event) => event.type === "session.error"),
    ).toMatchObject({
      error: {
        type: "mcp_connection_failed_error",
        mcp_server_name: "srv",
        message: "connect ECONNREFUSED",
        retry_status: { type: "retrying" },
      },
    });
  });

  it("persists MCP authentication failures with the hosted auth-failure discriminator", async () => {
    const runner = new ScriptedRunner([
      {
        type: "oma.mcp_connection_failed",
        errorType: "mcp_authentication_failed_error",
        mcpServerName: "srv",
        message: "Unauthorized",
        retryStatus: "exhausted",
      } satisfies RuntimeInternalEvent,
    ]);
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: translatePiEvent },
    });
    const session = await setupSession(app);

    await sendMessage(app, session.id, "hello");
    const events = await eventuallyEvents(app, session.id, (all) =>
      all.some((event) => event.type === "session.error"),
    );
    expect(
      events.find((event) => event.type === "session.error"),
    ).toMatchObject({
      error: {
        type: "mcp_authentication_failed_error",
        mcp_server_name: "srv",
        message: "Unauthorized",
        retry_status: { type: "exhausted" },
      },
    });
  });

  it("coalesced mcp_tool_with_model_end persists agent.message + mcp_tool_use, no generic tool_use", async () => {
    const mcpToolUse = {
      type: "oma.mcp_tool_use" as const,
      piToolCallId: "toolu_mcp_1",
      mcpServerName: "srv",
      name: "echo",
      input: { text: "hi" },
      evaluatedPermission: "allow" as const,
      bindToolUseId: () => undefined,
      rejectToolUse: () => undefined,
    };
    const runner = new ScriptedRunner(
      [
        {
          type: "oma.mcp_tool_with_model_end",
          mcpToolUse,
          suppressedPiToolCallIds: ["toolu_mcp_1"],
          messageEnd: {
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "calling the tool now" },
                {
                  type: "toolCall",
                  id: "toolu_mcp_1",
                  name: "mcp__srv__echo",
                  arguments: { text: "hi" },
                },
              ],
            },
          },
        },
      ],
      ["mcp__srv__echo"],
    );
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: translatePiEvent },
    });
    const session = await setupSession(app);

    await sendMessage(app, session.id, "go");
    const events = await eventuallyEvents(app, session.id, (all) =>
      all.some((event) => event.type === "agent.mcp_tool_use"),
    );
    expect(
      events.find((event) => event.type === "agent.message"),
    ).toMatchObject({
      content: [{ type: "text", text: "calling the tool now" }],
    });
    expect(
      events.find((event) => event.type === "agent.mcp_tool_use"),
    ).toMatchObject({ mcp_server_name: "srv", name: "echo" });
    expect(events.some((event) => event.type === "agent.tool_use")).toBe(false);
  });

  it("false-positive direction: an mcp__-looking toolCall NOT in the name set still emits agent.tool_use", async () => {
    // Suppression is set-membership, never prefix-matching: a custom tool
    // that happens to be named mcp__like__this must keep its generic events.
    const runner = new ScriptedRunner(
      [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "toolu_custom_1",
                name: "mcp__like__this",
                arguments: {},
              },
            ],
          },
        },
      ],
      [], // name set does NOT contain mcp__like__this
    );
    const app = createInMemoryControlPlaneApp({
      runtime: { runner, translate: translatePiEvent },
    });
    const session = await setupSession(app);

    await sendMessage(app, session.id, "go");
    const events = await eventuallyEvents(app, session.id, (all) =>
      all.some((event) => event.type === "agent.tool_use"),
    );
    expect(
      events.find((event) => event.type === "agent.tool_use"),
    ).toMatchObject({ name: "mcp__like__this" });
    expect(events.some((event) => event.type === "agent.mcp_tool_use")).toBe(
      false,
    );
  });
});

async function setupSession(
  app: App,
  mcpUrl?: string,
): Promise<ManagedAgentsSession> {
  const agentBody =
    mcpUrl === undefined
      ? {
          name: "MCP e2e Agent",
          model: "claude-opus-4-7",
          tools: [{ type: "agent_toolset_20260401" }],
        }
      : {
          name: "MCP e2e Agent",
          model: "claude-opus-4-7",
          mcp_servers: [{ type: "url", name: "srv", url: mcpUrl }],
          tools: [
            { type: "agent_toolset_20260401" },
            { type: "mcp_toolset", mcp_server_name: "srv" },
          ],
        };
  const agentRes = await app.request("/v1/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(agentBody),
  });
  expect(agentRes.status).toBe(200);
  const agent = (await agentRes.json()) as ManagedAgentsAgent;

  const envRes = await app.request("/v1/environments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "MCP e2e Environment",
      config: { type: "cloud" },
    }),
  });
  expect(envRes.status).toBe(200);
  const environment = (await envRes.json()) as ManagedAgentsEnvironment;

  const sessionRes = await app.request("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: agent.id, environment_id: environment.id }),
  });
  expect(sessionRes.status).toBe(200);
  return (await sessionRes.json()) as ManagedAgentsSession;
}

async function sendMessage(
  app: App,
  sessionId: string,
  text: string,
): Promise<void> {
  const res = await app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    }),
  });
  expect(res.status).toBe(200);
}

async function sendEvents(
  app: App,
  sessionId: string,
  events: unknown[],
): Promise<void> {
  const res = await app.request(`/v1/sessions/${sessionId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });
  expect(res.status).toBe(200);
}

async function getEvents(
  app: App,
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await app.request(`/v1/sessions/${sessionId}/events`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data;
}

async function eventuallyEvents(
  app: App,
  sessionId: string,
  predicate: (events: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const startedAt = Date.now();
  while (!hasTimedOut(startedAt, STREAM_TEST_TIMEOUT_MS)) {
    const events = await getEvents(app, sessionId);
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for expected events");
}
