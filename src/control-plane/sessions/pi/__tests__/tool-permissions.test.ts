import { describe, expect, it, vi } from "vitest";
import type { AgentRow } from "../../../agents/types.ts";
import type { RuntimeToolPermissionUseEvent } from "../../../events/types.ts";
import type { SessionRow } from "../../types.ts";
import {
  PiToolPermissionBridge,
  createStoreBackedBuiltinToolAccessResolver,
} from "../tool-permissions.ts";

describe("store-backed builtin tool access resolver", () => {
  it("disables sandbox builtins when agent_toolset_20260401 is absent", () => {
    const resolver = createStoreBackedBuiltinToolAccessResolver(
      fixture({ tools: [] }),
    );

    expect(resolver("wrk_default", "sesn_1", "bash")).toEqual({
      enabled: false,
      permission: "deny",
    });
  });

  it("resolves default policy and per-tool enabled/policy overrides", () => {
    const resolver = createStoreBackedBuiltinToolAccessResolver(
      fixture({
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: {
              enabled: true,
              permission_policy: { type: "always_ask" },
            },
            configs: [
              {
                name: "bash",
                enabled: false,
                permission_policy: { type: "never_allow" },
              },
              {
                name: "read",
                permission_policy: { type: "always_allow" },
              },
            ],
          },
        ],
      }),
    );

    expect(resolver("wrk_default", "sesn_1", "bash")).toEqual({
      enabled: false,
      permission: "deny",
    });
    expect(resolver("wrk_default", "sesn_1", "read")).toEqual({
      enabled: true,
      permission: "allow",
    });
    expect(resolver("wrk_default", "sesn_1", "write")).toEqual({
      enabled: true,
      permission: "ask",
    });
  });

  it("resolves public glob allow, ask, and disabled configurations", () => {
    const access = (config: { enabled?: boolean; permission_policy?: { type: "always_allow" | "always_ask" } }) =>
      createStoreBackedBuiltinToolAccessResolver(fixture({
        tools: [{
          type: "agent_toolset_20260401",
          default_config: { enabled: false },
          configs: [{ name: "glob", ...config }],
        }],
      }))("wrk_default", "sesn_1", "glob");

    expect(access({ enabled: true, permission_policy: { type: "always_allow" } }))
      .toEqual({ enabled: true, permission: "allow" });
    expect(access({ enabled: true, permission_policy: { type: "always_ask" } }))
      .toEqual({ enabled: true, permission: "ask" });
    expect(access({ enabled: false, permission_policy: { type: "always_allow" } }))
      .toEqual({ enabled: false, permission: "allow" });
  });

  it("can resolve from an agent id while the session row is not inserted yet", () => {
    const resolver = createStoreBackedBuiltinToolAccessResolver(
      fixture(
        {
          tools: [
            {
              type: "agent_toolset_20260401",
              default_config: {
                permission_policy: { type: "always_ask" },
              },
            },
          ],
        },
        { sessionVisible: false },
      ),
    );

    expect(
      resolver("wrk_default", "sesn_pending", "bash", {
        agentId: "agent_1",
        agentVersion: 1,
      }),
    ).toEqual({
      enabled: true,
      permission: "ask",
    });
  });

  it("resolves the session's pinned revision instead of the latest agent", () => {
    const v1 = agentRowWithTools([{
      type: "agent_toolset_20260401",
      default_config: { enabled: false },
    }], 1);
    const v2 = agentRowWithTools([{
      type: "agent_toolset_20260401",
      default_config: { enabled: true },
    }], 2);
    const session = sessionRow(1);
    const resolver = createStoreBackedBuiltinToolAccessResolver({
      sessions: { retrieveAny: () => session },
      agents: {
        retrieveVersion: (_workspaceId, _agentId, version) =>
          version === 1 ? v1 : version === 2 ? v2 : undefined,
      },
    });

    expect(resolver("wrk_default", "sesn_1", "bash")).toEqual({
      enabled: false,
      permission: "allow",
    });
  });

  it("fails closed for unknown permission policies", () => {
    const resolver = createStoreBackedBuiltinToolAccessResolver(
      fixture({
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: {
              permission_policy: { type: "typo_never_allow" },
            },
          },
        ],
      }),
    );

    expect(resolver("wrk_default", "sesn_1", "bash")).toEqual({
      enabled: true,
      permission: "deny",
    });
  });

  it("fails closed for duplicate builtin toolsets from existing rows", () => {
    const resolver = createStoreBackedBuiltinToolAccessResolver(
      fixture({
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: {
              permission_policy: { type: "always_allow" },
            },
          },
          {
            type: "agent_toolset_20260401",
            default_config: {
              permission_policy: { type: "never_allow" },
            },
          },
        ],
      }),
    );

    expect(resolver("wrk_default", "sesn_1", "bash")).toEqual({
      enabled: false,
      permission: "deny",
    });
  });
});

describe("PiToolPermissionBridge rollback", () => {
  it("releases bound ask confirmations when public tool_use persistence fails", async () => {
    let emitted: RuntimeToolPermissionUseEvent | undefined;
    const release = vi.fn();
    const providerExecute = vi.fn(async () => ({ content: [], details: {} }));
    const bridge = new PiToolPermissionBridge({
      access: () => ({ enabled: true, permission: "ask" }),
    });
    const tool = bridge.wrapTool(
      "wrk_default",
      "sesn_1",
      "bash",
      {
        name: "bash",
        execute: providerExecute,
      } as never,
      () => (event) => {
        emitted = event;
      },
    );

    const execution = tool.execute(
      "toolu_rollback",
      { command: "printf ok" },
      new AbortController().signal,
      undefined,
      {} as never,
    );
    expect(emitted).toMatchObject({
      type: "oma.tool_permission_use",
      evaluatedPermission: "ask",
    });
    emitted?.bindToolUseId("sevt_rollback", release);
    emitted?.rejectToolUse(new Error("persist failed"));

    await expect(execution).rejects.toThrow("persist failed");
    expect(release).toHaveBeenCalledOnce();
    expect(
      bridge.claimConfirmation("wrk_default", "sesn_1", {
        type: "user.tool_confirmation",
        tool_use_id: "sevt_rollback",
        result: "allow",
      }),
    ).toBeUndefined();
    expect(
      bridge.publicToolUseIdForPiToolCallId("sesn_1", "toolu_rollback"),
    ).toBeUndefined();
    expect(bridge.suppressPiToolUse("sesn_1", "toolu_rollback")).toBe(false);
    expect(providerExecute).not.toHaveBeenCalled();
  });

  it("times out abandoned builtin confirmations and releases the pending id", async () => {
    let emitted: RuntimeToolPermissionUseEvent | undefined;
    const release = vi.fn();
    const bridge = new PiToolPermissionBridge({
      access: () => ({ enabled: true, permission: "ask" }),
      timeoutMs: 1,
    });
    const tool = bridge.wrapTool(
      "wrk_default",
      "sesn_1",
      "bash",
      {
        name: "bash",
        execute: vi.fn(async () => ({ content: [], details: {} })),
      } as never,
      () => (event) => {
        emitted = event;
      },
    );

    const execution = tool.execute(
      "toolu_timeout",
      { command: "printf ok" },
      new AbortController().signal,
      undefined,
      {} as never,
    );
    emitted?.bindToolUseId("sevt_timeout", release);

    await expect(execution).rejects.toThrow("confirmation timed out");
    expect(release).toHaveBeenCalledOnce();
    expect(
      bridge.claimConfirmation("wrk_default", "sesn_1", {
        type: "user.tool_confirmation",
        tool_use_id: "sevt_timeout",
        result: "allow",
      }),
    ).toBeUndefined();
    expect(bridge.permissionDenied("sesn_1", "toolu_timeout")).toBe(true);
  });
});

function sessionRow(version: number): SessionRow {
  return {
    id: "sesn_1", workspace_id: "wrk_default", type: "session",
    agent: { type: "agent", id: "agent_1", version },
    environment_id: "env_1", status: "idle", title: null, metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null, usage: null, resources: [],
  };
}

function agentRowWithTools(tools: AgentRow["tools"], version: number): AgentRow {
  return {
    id: "agent_1", workspace_id: "wrk_default", type: "agent", name: "Agent",
    model: { provider: "anthropic", id: "claude-opus-4-7", speed: "standard" }, system: null,
    description: null, tools, skills: [], mcp_servers: [], metadata: {},
    multiagent: null, version, created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z", archived_at: null,
  };
}

function fixture(
  agent: Pick<AgentRow, "tools">,
  opts: { sessionVisible?: boolean } = {},
) {
  const session: SessionRow = {
    id: "sesn_1",
    workspace_id: "wrk_default",
    type: "session",
    agent: { type: "agent", id: "agent_1", version: 1 },
    environment_id: "env_1",
    status: "idle",
    title: null,
    metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null,
    usage: null,
    resources: [],
  };
  const row: AgentRow = {
    id: "agent_1",
    workspace_id: "wrk_default",
    type: "agent",
    name: "Agent",
    model: { provider: "anthropic", id: "claude-opus-4-7", speed: "standard" },
    system: null,
    description: null,
    tools: agent.tools,
    skills: [],
    mcp_servers: [],
    metadata: {},
    multiagent: null,
    version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    archived_at: null,
  };
  return {
    sessions: {
      retrieveAny: (workspaceId: string, sessionId: string) =>
        opts.sessionVisible !== false &&
        workspaceId === session.workspace_id &&
        sessionId === session.id
          ? session
          : undefined,
    },
    agents: {
      retrieveVersion: (workspaceId: string, agentId: string, version: number) =>
        workspaceId === row.workspace_id && agentId === row.id && version === row.version
          ? row
          : undefined,
    },
  };
}
