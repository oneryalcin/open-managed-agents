import { describe, expect, it } from "vitest";
import type { AgentRow } from "../../../agents/types.ts";
import type { SessionRow } from "../../types.ts";
import {
  createStoreBackedAgentRevisionProvider,
  createStoreBackedCustomToolsProvider,
} from "../../../wiring.ts";
import {
  createStoreBackedMcpServersProvider,
  createStoreBackedMcpToolAccessResolver,
} from "../mcp/bridge.ts";

const SESSION: SessionRow = {
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

function revision(version: number): AgentRow {
  return {
    id: "agent_1",
    workspace_id: "wrk_default",
    type: "agent",
    name: `Agent v${version}`,
    model: { provider: "anthropic", id: `model-v${version}`, speed: "standard" },
    system: `system-v${version}`,
    description: null,
    tools: [
      {
        type: "custom",
        name: `custom_v${version}`,
        input_schema: { type: "object" },
      },
      {
        type: "mcp_toolset",
        mcp_server_name: `server-v${version}`,
        default_config: {
          enabled: version === 1,
          permission_policy: { type: "always_allow" },
        },
      },
    ],
    skills: [],
    mcp_servers: [
      { type: "url", name: `server-v${version}`, url: `https://v${version}.example` },
    ],
    metadata: {},
    multiagent: null,
    version,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: `2026-01-0${version}T00:00:00.000Z`,
    archived_at: null,
  };
}

function stores() {
  const versions = new Map([[1, revision(1)], [2, revision(2)]]);
  return {
    sessions: { retrieveAny: () => SESSION },
    agents: {
      retrieveVersion: (_workspaceId: string, _agentId: string, version: number) =>
        versions.get(version),
    },
  };
}

describe("pinned agent revision runtime resolution", () => {
  it("uses v1 for model/system, custom tools, and MCP after v2 exists", () => {
    const source = stores();
    const agentRevision = createStoreBackedAgentRevisionProvider(source);
    const customTools = createStoreBackedCustomToolsProvider(source);
    const mcpServers = createStoreBackedMcpServersProvider(source);
    const mcpAccess = createStoreBackedMcpToolAccessResolver(source);

    expect(agentRevision("wrk_default", "sesn_1")).toEqual({
      model: { provider: "anthropic", id: "model-v1", speed: "standard" },
      system: "system-v1",
    });
    expect(customTools("wrk_default", "sesn_1").map((tool) => tool.name))
      .toEqual(["custom_v1"]);
    expect(mcpServers("wrk_default", "sesn_1")).toEqual([
      { name: "server-v1", url: "https://v1.example" },
    ]);
    expect(mcpAccess("wrk_default", "sesn_1", "server-v1", "tool"))
      .toEqual({ enabled: true, permission: "allow" });
  });

  it("fails before runtime setup when the pinned revision is missing", () => {
    const provider = createStoreBackedAgentRevisionProvider({
      sessions: { retrieveAny: () => SESSION },
      agents: { retrieveVersion: () => undefined },
    });
    expect(() => provider("wrk_default", "sesn_1"))
      .toThrow("Pinned agent revision not found: agent_1@1");
  });
});
