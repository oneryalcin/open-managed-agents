// Plan 0122 §4.1 — mcp_servers / mcp_toolset validation matrix.
import { describe, expect, it } from "vitest";
import { SqliteAgentStore } from "../store.ts";
import { DefaultAgentService } from "../service.ts";

function service(): DefaultAgentService {
  return new DefaultAgentService(SqliteAgentStore.open(":memory:"), undefined);
}

function agentWithMcp(overrides: {
  mcp_servers?: unknown;
  tools?: unknown;
}): unknown {
  return {
    name: "MCP Agent",
    model: "claude-opus-4-7",
    ...("tools" in overrides ? { tools: overrides.tools } : {}),
    ...("mcp_servers" in overrides
      ? { mcp_servers: overrides.mcp_servers }
      : {}),
  };
}

const SERVER = { type: "url", name: "github", url: "https://mcp.example.com/mcp" };
const TOOLSET = { type: "mcp_toolset", mcp_server_name: "github" };

describe("mcp_servers validation (plan 0122 §4.1)", () => {
  it("accepts a matched server + toolset pair and echoes both back", () => {
    const agent = service().create("wrk_a", agentWithMcp({
      mcp_servers: [SERVER],
      tools: [{ type: "agent_toolset_20260401" }, TOOLSET],
    }));
    expect(agent.mcp_servers).toEqual([SERVER]);
    expect(agent.tools).toContainEqual(TOOLSET);
  });

  it("keeps MCP config names server-defined rather than applying builtin vocabulary", () => {
    const toolset = {
      ...TOOLSET,
      configs: [{ name: "server_defined_tool", permission_policy: { type: "always_ask" } }],
    };
    const agent = service().create("wrk_a", agentWithMcp({
      mcp_servers: [SERVER],
      tools: [{ type: "agent_toolset_20260401" }, toolset],
    }));
    expect(agent.tools).toContainEqual(toolset);
  });

  it("rejects a dangling mcp_toolset referencing an undeclared server", () => {
    expect(() =>
      service().create("wrk_a", agentWithMcp({ tools: [TOOLSET] })),
    ).toThrow("references undeclared MCP server: github");
  });

  it("rejects an unreferenced server when tools has no matching toolset", () => {
    expect(() =>
      service().create("wrk_a", agentWithMcp({
        mcp_servers: [SERVER],
        tools: [{ type: "agent_toolset_20260401" }],
      })),
    ).toThrow("not referenced by any mcp_toolset: github");
  });

  it("rejects an unreferenced server when tools is absent entirely", () => {
    expect(() =>
      service().create("wrk_a", agentWithMcp({ mcp_servers: [SERVER] })),
    ).toThrow("not referenced by any mcp_toolset: github");
  });

  it("rejects two mcp_toolsets naming the same server (hosted parity, probe 47)", () => {
    expect(() =>
      service().create("wrk_a", agentWithMcp({
        mcp_servers: [SERVER],
        tools: [TOOLSET, { ...TOOLSET }],
      })),
    ).toThrow("at most one mcp_toolset per server: github");
  });

  it("rejects duplicate server names", () => {
    expect(() =>
      service().create("wrk_a", agentWithMcp({
        mcp_servers: [SERVER, { ...SERVER, url: "https://other.example.com/" }],
        tools: [TOOLSET],
      })),
    ).toThrow("duplicate server name: github");
  });

  it("treats server-name comparisons as case-sensitive", () => {
    // "GitHub" and "github" are distinct: no duplicate, and the toolset
    // referencing "GitHub" does not satisfy "github"'s reference check.
    expect(() =>
      service().create("wrk_a", agentWithMcp({
        mcp_servers: [SERVER, { ...SERVER, name: "GitHub" }],
        tools: [{ type: "mcp_toolset", mcp_server_name: "GitHub" }],
      })),
    ).toThrow("not referenced by any mcp_toolset: github");
  });

  it("rejects a 21st server", () => {
    const servers = Array.from({ length: 21 }, (_, i) => ({
      type: "url",
      name: `srv-${i}`,
      url: "https://mcp.example.com/mcp",
    }));
    expect(() =>
      service().create("wrk_a", agentWithMcp({
        mcp_servers: servers,
        tools: servers.map((s) => ({
          type: "mcp_toolset",
          mcp_server_name: s.name,
        })),
      })),
    ).toThrow("at most 20 servers");
  });

  it("rejects a 256-character server name", () => {
    expect(() =>
      service().create("wrk_a", agentWithMcp({
        mcp_servers: [{ ...SERVER, name: "n".repeat(256) }],
        tools: [{ type: "mcp_toolset", mcp_server_name: "n".repeat(256) }],
      })),
    ).toThrow("at most 255 characters");
  });

  it("rejects a 2049-character URL", () => {
    const url = `https://mcp.example.com/${"p".repeat(2049)}`;
    expect(() =>
      service().create("wrk_a", agentWithMcp({
        mcp_servers: [{ ...SERVER, url }],
        tools: [TOOLSET],
      })),
    ).toThrow("at most 2048 characters");
  });

  it("rejects non-http(s) URL schemes", () => {
    expect(() =>
      service().create("wrk_a", agentWithMcp({
        mcp_servers: [{ ...SERVER, url: "ftp://mcp.example.com/mcp" }],
        tools: [TOOLSET],
      })),
    ).toThrow("must use http or https");
  });

  it("rejects an unparseable URL", () => {
    expect(() =>
      service().create("wrk_a", agentWithMcp({
        mcp_servers: [{ ...SERVER, url: "not a url" }],
        tools: [TOOLSET],
      })),
    ).toThrow("must be a valid URL");
  });

  it("rejects URLs with embedded userinfo credentials", () => {
    expect(() =>
      service().create("wrk_a", agentWithMcp({
        mcp_servers: [{ ...SERVER, url: "https://user:pass@mcp.example.com/mcp" }],
        tools: [TOOLSET],
      })),
    ).toThrow("must not embed credentials");
  });

  it("rejects unknown server fields", () => {
    expect(() =>
      service().create("wrk_a", agentWithMcp({
        mcp_servers: [{ ...SERVER, authorization_token: "tok" }],
        tools: [TOOLSET],
      })),
    ).toThrow("Unsupported `mcp_servers[]` field: authorization_token");
  });

  it("persists the raw URL string byte-exactly (no URL normalization)", () => {
    // Each of these would change under URL.toString(): redundant default
    // port, mixed-case host, bare-origin without trailing slash. M2's
    // credential matching is byte-exact, so storage must not normalize.
    const rawUrls = [
      "https://MCP.Example.com:443/mcp",
      "https://mcp.example.com",
      "https://mcp.example.com/mcp/",
    ];
    for (const [i, url] of rawUrls.entries()) {
      const agent = service().create("wrk_a", agentWithMcp({
        mcp_servers: [{ ...SERVER, name: `srv-${i}`, url }],
        tools: [{ type: "mcp_toolset", mcp_server_name: `srv-${i}` }],
      }));
      expect(agent.mcp_servers[0].url).toBe(url);
    }
  });
});
